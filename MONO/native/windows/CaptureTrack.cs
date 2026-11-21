using System.Collections.Concurrent;
using System.Diagnostics;
using System.Runtime.InteropServices;
namespace MonoAudio;

internal enum PacketKind {Audio,Pause,Resume}
internal sealed record AudioPacket(PacketKind Kind,byte[] Data,long StartNs);
internal sealed class CaptureTrack : IDisposable
{
    readonly NativeSession session;readonly string? requestedId;readonly bool loopback;readonly int? processId;readonly BlockingCollection<AudioPacket> packets=new(128);
    readonly Thread captureThread,writerThread;readonly AutoResetEvent sampleEvent=new(false);long queuedBytes;const long QueueLimit=8*1024*1024;
    public readonly ManualResetEventSlim Initialized=new(false),Started=new(false),PauseCompleted=new(false),ResumeCompleted=new(false),ProducerDone=new(false),WriterDone=new(false);
    public string Variant{get;private set;}="";public string Id{get;private set;}="";public string Track=>loopback?"system":"mic";public AudioFormat? Format{get;private set;}
    public bool UsesDefault=>requestedId is null&&processId is null;public bool IsApplication=>processId is not null;public double Peak{get;private set;}public double Rms{get;private set;}public long ClippedFrames{get;private set;}
    long safetyNs=250_000_000;bool producerPaused;
    public CaptureTrack(NativeSession session,bool loopback,string? requestedId,int? processId=null)
    {
        this.session=session;this.loopback=loopback||processId is not null;this.requestedId=requestedId;this.processId=processId;
        // Process loopback completes its activation on a system MTA thread; an MTA capture thread
        // uses the activated client in the same apartment, without cross-apartment marshalling.
        captureThread=new Thread(Capture){IsBackground=true,Name="MONO WASAPI "+Track};captureThread.SetApartmentState(processId is null?ApartmentState.STA:ApartmentState.MTA);
        writerThread=new Thread(Write){IsBackground=true,Name="MONO WAV "+Track};
    }
    public void Begin(){writerThread.Start();captureThread.Start();}
    void Enqueue(AudioPacket packet)
    {
        long total=Interlocked.Add(ref queuedBytes,packet.Data.Length);
        if(total>QueueLimit||!packets.TryAdd(packet)){Interlocked.Add(ref queuedBytes,-packet.Data.Length);throw new AudioFailure("DISCONTINUITY");}
    }
    void Capture()
    {
        bool eventDriven=true;IDeviceEnumerator? enumerator=null;IDevice? device=null;IAudioClient? client=null;IAudioCaptureClient? input=null;IntPtr mix=IntPtr.Zero;bool started=false;string operation="resolve-device";
        var mmcss=Realtime.EnterProAudio();
        try{
          if(processId is int pid){
            operation="process-loopback";var steps=new List<KeyValuePair<string,string>>();
            try{client=ProcessLoopback.Open(pid,steps);}finally{Variant=string.Join(",",steps.Select(a=>a.Key+"="+a.Value));}
            Id="process:"+pid;Format=new AudioFormat(ProcessLoopback.Format());
          }else{
            enumerator=(IDeviceEnumerator)new DeviceEnumeratorCom();var flow=loopback?DataFlow.Render:DataFlow.Capture;
            ComAudio.Check(requestedId is null?enumerator.GetDefaultAudioEndpoint(flow,DeviceRole.Console,out device):enumerator.GetDevice(requestedId,out device));
            ComAudio.Check(device.GetState(out var state));if(state!=1)throw new AudioFailure("DEVICE_LOST");ComAudio.Check(device.GetId(out var id));Id=id;
            operation="activate";var iid=typeof(IAudioClient).GUID;ComAudio.Check(device.Activate(ref iid,23,IntPtr.Zero,out var active));client=(IAudioClient)active;
            operation="mix-format";ComAudio.Check(client.GetMixFormat(out mix));int extra=(ushort)Marshal.ReadInt16(mix,16);if(extra>4096-18)throw new AudioFailure("UNSUPPORTED_FORMAT");
            ComAudio.Release(client);client=null;
            // Dissimilar ways to open the stream (see StreamOpener): plain event-driven first, then
            // Windows' converter, polling, IAudioClient3, the communications category and 16-bit PCM.
            operation="initialize";var attempts=new List<KeyValuePair<string,string>>();
            var opened=StreamOpener.Open(device,mix,loopback,attempts);
            Variant=string.Join(",",attempts.Select(a=>a.Key+"="+a.Value));
            if(opened is null){int last=attempts.Count>0&&int.TryParse(attempts[^1].Value,System.Globalization.NumberStyles.HexNumber,null,out var h)?h:unchecked((int)0x80004005);ComAudio.Check(last);throw new AudioFailure("INTERNAL",last);}
            client=opened.Client;eventDriven=opened.EventDriven;
            try{Format=new AudioFormat(opened.Format);}catch(ArgumentException){throw new AudioFailure("UNSUPPORTED_FORMAT");}
          }
            operation="event-handle";if(eventDriven)ComAudio.Check(client.SetEventHandle(sampleEvent.SafeWaitHandle.DangerousGetHandle()));
            // The process-loopback client may not report latency or buffer size; the safety margin then keeps its default.
            operation="stream-latency";int latencyResult=client.GetStreamLatency(out long latency);if(processId is null)ComAudio.Check(latencyResult);else if(latencyResult<0)latency=0;
            operation="buffer-size";int bufferResult=client.GetBufferSize(out uint bufferFrames);if(processId is null)ComAudio.Check(bufferResult);else if(bufferResult<0)bufferFrames=0;
            safetyNs=Math.Max(250_000_000,checked(latency*100+ClockMath.FramesToNs(bufferFrames,Format.Rate)+50_000_000));
            operation="capture-service";var captureIid=typeof(IAudioCaptureClient).GUID;ComAudio.Check(client.GetService(ref captureIid,out var capture));input=(IAudioCaptureClient)capture;
            Initialized.Set();session.StartGate.Wait(session.Cancellation);operation="start";ComAudio.Check(client.Start());started=true;Started.Set();long lastPacket=NativeSession.NowNs;
            while(!session.Cancellation.IsCancellationRequested){
                if(session.PauseRequested&&!producerPaused){
                    ReadPackets();ComAudio.Check(client.Stop());started=false;producerPaused=true;Enqueue(new AudioPacket(PacketKind.Pause,[],session.PauseNs));
                    session.ResumeGate.Wait(session.Cancellation);if(session.Cancellation.IsCancellationRequested)break;
                    Enqueue(new AudioPacket(PacketKind.Resume,[],session.ResumeNs));ComAudio.Check(client.Start());started=true;producerPaused=false;lastPacket=NativeSession.NowNs;ResumeCompleted.Set();
                }
                int signaled=WaitHandle.WaitAny([sampleEvent,session.Cancellation.WaitHandle],50);if(signaled==1)break;
                int read=ReadPackets();if(read>0)lastPacket=NativeSession.NowNs;
                if(!loopback&&NativeSession.NowNs-lastPacket>2_000_000_000)throw new AudioFailure("DEVICE_LOST");
                session.CheckSleep();
            }
            if(started)ReadPackets();
            int ReadPackets(){
                int count=0;
                while(true){
                    operation="next-packet";ComAudio.Check(input.GetNextPacketSize(out uint available));if(available==0)break;
                    operation="packet-buffer";ComAudio.Check(input.GetBuffer(out var pointer,out uint frames,out uint flags,out _,out ulong qpc));
                    byte[] data;long stamp;
                    try{
                        if(frames==0)break;
                        // DATA_DISCONTINUITY (0x1) is routine after loopback silence, device glitches
                        // and stream restarts; the QPC stamp lets the writer insert the exact gap.
                        // TIMESTAMP_ERROR (0x4) only invalidates the stamp, not the audio.
                        bool timestampError=(flags&4)!=0;
                        int size=checked((int)(frames*Format.Alignment));if(size>QueueLimit)throw new AudioFailure("UNSUPPORTED_FORMAT");data=new byte[size];
                        if((flags&2)!=0){if(Format.Silence!=0)Array.Fill(data,Format.Silence);}else Marshal.Copy(pointer,data,0,size);
                        stamp=timestampError?-1:checked((long)qpc*100);
                        // Only trust a process-loopback stamp that lies near now; otherwise the writer continues at its cursor.
                        if(processId is not null&&stamp>=0&&Math.Abs(stamp-NativeSession.NowNs)>5_000_000_000)stamp=-1;
                    }finally{ComAudio.Check(input.ReleaseBuffer(frames));}
                    count++;
                    if(stamp>=0&&stamp<session.OriginNs){
                        long before=session.OriginNs-stamp;int trim=checked((int)Math.Min(frames,ClockMath.NsToFrames(before,Format.Rate)+1));data=data.AsSpan(trim*Format.Alignment).ToArray();stamp+=ClockMath.FramesToNs(trim,Format.Rate);
                    }
                    if(data.Length>0)Enqueue(new AudioPacket(PacketKind.Audio,data,stamp));
                }return count;
            }
        }catch(OperationCanceledException){ }
        catch(AudioFailure error){session.Fail(error.Code,"capture-"+Track+"/"+operation,error.NativeCode);}
        catch(Exception error) when(error is COMException or InvalidCastException or OverflowException or ArgumentException){session.Fail("INTERNAL","capture-"+Track+"/"+operation,error.HResult);}
        finally{
            if(started&&client is not null){try{ComAudio.Check(client.Stop());}catch(AudioFailure error){session.Fail(error.Code);}}
            if(mix!=IntPtr.Zero)Marshal.FreeCoTaskMem(mix);
            Realtime.Leave(mmcss);ComAudio.Release(input);ComAudio.Release(client);ComAudio.Release(device);ComAudio.Release(enumerator);packets.CompleteAdding();ProducerDone.Set();Initialized.Set();Started.Set();ResumeCompleted.Set();
        }
    }
    void Write()
    {
        SegmentAssembler? assembler=null;bool paused=false;
        try{
            Initialized.Wait(session.Cancellation);session.StartGate.Wait(session.Cancellation);if(Format is null)throw new AudioFailure("UNSUPPORTED_FORMAT");
            assembler=new SegmentAssembler(session.Root,Track,Format,session.OriginNs,segment=>{if(session.RecordingPublished)session.EmitSegment(segment);});
            while(!packets.IsCompleted){
                if(packets.TryTake(out var packet,50)){
                    Interlocked.Add(ref queuedBytes,-packet.Data.Length);
                    if(packet.Kind==PacketKind.Pause){
                        if(loopback)assembler.PadTo(packet.StartNs);assembler.Pause();paused=true;Peak=0;Rms=0;PauseCompleted.Set();continue;
                    }
                    if(packet.Kind==PacketKind.Resume){assembler.ResumeAt(packet.StartNs);paused=false;continue;}
                    if(!session.PublishGate.IsSet&&!session.Cancellation.IsCancellationRequested)WaitHandle.WaitAny([session.PublishGate.WaitHandle,session.Cancellation.WaitHandle]);
                    assembler.AppendPacket(packet.Data,packet.StartNs<0?assembler.CursorNs:packet.StartNs);UpdateLevel(packet.Data,Format);
                }else if(loopback&&!paused&&session.RecordingPublished&&!session.PauseRequested&&!session.Cancellation.IsCancellationRequested){assembler.PadTo(Math.Max(session.OriginNs,NativeSession.NowNs-safetyNs));Peak=0;Rms=0;}
            }
            if(loopback&&!paused&&session.RecordingPublished)assembler.PadTo(session.StopNs);
            assembler.Complete();
        }catch(OperationCanceledException){ }
        catch(AudioFailure error){session.Fail(error.Code);}
        catch(IOException){session.Fail("IO_ERROR");}
        catch(Exception error) when(error is InvalidOperationException or OverflowException or ArgumentException){session.Fail(error.Message=="DISCONTINUITY"?"DISCONTINUITY":"INTERNAL");}
        finally{
            try{assembler?.Dispose();}catch(IOException){session.Fail("IO_ERROR");}catch(InvalidOperationException){session.Fail("INTERNAL");}
            WriterDone.Set();PauseCompleted.Set();
        }
    }
    void UpdateLevel(byte[] data,AudioFormat format)
    {
        double peak=0,squares=0;long clips=0;int count=0;
        for(int frame=0;frame<data.Length;frame+=format.Alignment){bool clipped=false;
            for(int channel=0;channel<format.Channels;channel++){
                int offset=frame+channel*(format.Bits/8);double value;
                if(format.Tag==3)value=format.Bits==32?BitConverter.ToSingle(data,offset):BitConverter.ToDouble(data,offset);
                else value=format.Bits switch{8=>(data[offset]-128)/128d,16=>BitConverter.ToInt16(data,offset)/32768d,24=>(((data[offset]|data[offset+1]<<8|data[offset+2]<<16)<<8)>>8)/8388608d,32=>BitConverter.ToInt32(data,offset)/2147483648d,_=>throw new AudioFailure("UNSUPPORTED_FORMAT")};
                if(!double.IsFinite(value)||Math.Abs(value)>1000)throw new AudioFailure("UNSUPPORTED_FORMAT");peak=Math.Max(peak,Math.Abs(value));squares+=value*value;count++;if(Math.Abs(value)>=1)clipped=true;
            }if(clipped)clips++;
        }
        Peak=peak;Rms=count==0?0:Math.Sqrt(squares/count);ClippedFrames=clips;
    }
    public void Dispose(){sampleEvent.Dispose();packets.Dispose();Initialized.Dispose();Started.Dispose();PauseCompleted.Dispose();ResumeCompleted.Dispose();ProducerDone.Dispose();WriterDone.Dispose();}
}
