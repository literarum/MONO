using System.Runtime.InteropServices;
namespace MonoAudio;

/// Built-in test of the real capture path for one microphone (default when id is null):
/// open → capture ~0.5 s → close, reporting each step's HRESULT. Also reports what a browser
/// would meet: the shared mix format, whether the driver claims raw-mode support (Chromium opens
/// raw-capable microphones with AUDCLNT_STREAMOPTIONS_RAW and has no retry without it), and
/// whether 48 kHz stereo 16-bit PCM — Chromium's default request — is accepted in shared mode.
/// Never records anything to disk.
public static class MicProbe
{
    // PKEY_Devices_AudioDevice_RawProcessingSupported (mmdeviceapi.h / devpkey).
    static readonly PropertyKey RawSupported=new(new Guid("8943B373-388C-4395-B557-BC6DBAFFAFDB"),2);
    static string Hex(int hr)=>unchecked((uint)hr).ToString("X8");
    static bool? Raw(IDevice device)
    {
        if(device.OpenPropertyStore(0,out var store)!=0)return null;
        try{var key=RawSupported;if(store.GetValue(ref key,out var value)!=0)return null;try{return value.Type==11?unchecked((short)value.Pointer.ToInt64())!=0:null;}/* VT_BOOL: boolVal is the low 16 bits at offset 8 */finally{ComAudio.PropVariantClear(ref value);}}
        catch(COMException){return null;}finally{ComAudio.Release(store);}
    }
    public static Dictionary<string,object?> Run(string? id)
    {
        // The real capture thread is STA (Microsoft: the first use of IAudioClient should be on an
        // STA thread); the probe runs the same way, then repeats the plain request on MTA for contrast.
        var report=OnThread(ApartmentState.STA,()=>Probe(id));
        var mta=OnThread(ApartmentState.MTA,()=>PlainOnly(id));
        report["mtaEvent"]=mta.TryGetValue("hresult",out var value)?value:null;
        return report;
    }
    static Dictionary<string,object?> OnThread(ApartmentState apartment,Func<Dictionary<string,object?>> work)
    {
        Dictionary<string,object?>? result=null;Exception? problem=null;
        var thread=new Thread(()=>{try{result=work();}catch(Exception error){problem=error;}});
        thread.SetApartmentState(apartment);thread.Start();if(!thread.Join(10000))return new(){{"opened",false},{"step","timeout"}};
        if(problem is not null)return new(){{"opened",false},{"step","exception"},{"code",problem is AudioFailure f?f.Code:problem.GetType().Name},{"hresult",problem is AudioFailure g&&g.NativeCode is int n?Hex(n):problem is COMException c?Hex(c.HResult):null}};
        return result!;
    }
    static Dictionary<string,object?> PlainOnly(string? id)
    {
        var enumerator=(IDeviceEnumerator)new DeviceEnumeratorCom();IDevice? device=null;IAudioClient? client=null;IntPtr mix=IntPtr.Zero;
        try{
            int hr=id is null?enumerator.GetDefaultAudioEndpoint(DataFlow.Capture,DeviceRole.Console,out device):enumerator.GetDevice(id,out device);if(hr<0)return new(){{"hresult",Hex(hr)}};
            var iid=typeof(IAudioClient).GUID;hr=device.Activate(ref iid,23,IntPtr.Zero,out var value);if(hr<0)return new(){{"hresult",Hex(hr)}};client=(IAudioClient)value;
            hr=client.GetMixFormat(out mix);if(hr<0)return new(){{"hresult",Hex(hr)}};
            var session=Guid.NewGuid();hr=client.Initialize(0,0x40000u,0,0,mix,ref session);return new(){{"hresult",Hex(hr)}};
        }finally{if(mix!=IntPtr.Zero)Marshal.FreeCoTaskMem(mix);ComAudio.Release(client);ComAudio.Release(device);ComAudio.Release(enumerator);}
    }
    static Dictionary<string,object?> Probe(string? id)
    {
        var report=new Dictionary<string,object?>{{"opened",false}};
        var enumerator=(IDeviceEnumerator)new DeviceEnumeratorCom();IDevice? device=null;IAudioClient? client=null;IAudioCaptureClient? input=null;IntPtr mix=IntPtr.Zero;OpenedStream? opened=null;AutoResetEvent? signal=null;
        try{
            int hr=id is null?enumerator.GetDefaultAudioEndpoint(DataFlow.Capture,DeviceRole.Console,out device):enumerator.GetDevice(id,out device);
            if(hr<0){report["step"]="resolve-device";report["hresult"]=Hex(hr);return report;}
            report["rawSupported"]=Raw(device);
            var iid=typeof(IAudioClient).GUID;hr=device.Activate(ref iid,23,IntPtr.Zero,out var activated);
            if(hr<0){report["step"]="activate";report["hresult"]=Hex(hr);return report;}
            client=(IAudioClient)activated;
            hr=client.GetMixFormat(out mix);if(hr<0){report["step"]="mix-format";report["hresult"]=Hex(hr);return report;}
            report["mixFormat"]=new Dictionary<string,object?>{{"tag",(ushort)Marshal.ReadInt16(mix,0)},{"channels",(ushort)Marshal.ReadInt16(mix,2)},{"rate",Marshal.ReadInt32(mix,4)},{"bits",(ushort)Marshal.ReadInt16(mix,14)}};
            var request=Marshal.AllocCoTaskMem(18);
            try{
                Marshal.WriteInt16(request,0,1);Marshal.WriteInt16(request,2,2);Marshal.WriteInt32(request,4,48000);Marshal.WriteInt32(request,8,48000*4);Marshal.WriteInt16(request,12,4);Marshal.WriteInt16(request,14,16);Marshal.WriteInt16(request,16,0);
                int supported=client.IsFormatSupported(0,request,out var closest);if(closest!=IntPtr.Zero)Marshal.FreeCoTaskMem(closest);
                report["browserFormat"]=supported==0?"supported":supported==1?"closest-match":Hex(supported);
            }finally{Marshal.FreeCoTaskMem(request);}
            ComAudio.Release(client);client=null;
            var attempts=new List<KeyValuePair<string,string>>();opened=StreamOpener.Open(device,mix,false,attempts);
            report["attempts"]=attempts.ToDictionary(a=>a.Key,a=>(object?)a.Value);
            if(attempts.Count>0)report["initPlain"]=attempts[0].Value;if(attempts.Count>1)report["initAutoconvert"]=attempts[1].Value;
            if(opened is null){report["step"]="initialize";report["hresult"]=attempts.Count>0?attempts[^1].Value:null;return report;}
            report["variant"]=opened.Variant;client=opened.Client;
            iid=typeof(IAudioCaptureClient).GUID;hr=client.GetService(ref iid,out var service);if(hr<0){report["step"]="capture-service";report["hresult"]=Hex(hr);return report;}
            input=(IAudioCaptureClient)service;
            if(opened.EventDriven){signal=new AutoResetEvent(false);client.SetEventHandle(signal.SafeWaitHandle.DangerousGetHandle());}
            hr=client.Start();if(hr<0){report["step"]="start";report["hresult"]=Hex(hr);return report;}
            var format=opened.Format;int channels=BitConverter.ToUInt16(format,2),bits=BitConverter.ToUInt16(format,14),tag=BitConverter.ToUInt16(format,0);
            if(tag==0xFFFE&&format.Length>=40)tag=BitConverter.ToUInt16(format,24);
            long frames=0;double peak=0;bool silentFlag=false;var until=Environment.TickCount64+600;
            while(Environment.TickCount64<until){
                Thread.Sleep(20);
                while(input.GetNextPacketSize(out var size)==0&&size>0){
                    if(input.GetBuffer(out var data,out var count,out var flags,out _,out _)<0)break;
                    if((flags&2)!=0)silentFlag=true;
                    else if(data!=IntPtr.Zero)for(long i=0;i<(long)count*channels;i+=channels){
                        double v=tag==3&&bits==32?BitConverter.Int32BitsToSingle(Marshal.ReadInt32(data,(int)(i*4))):bits==16?Marshal.ReadInt16(data,(int)(i*2))/32768d:bits==32?Marshal.ReadInt32(data,(int)(i*4))/2147483648d:0;
                        if(double.IsFinite(v))peak=Math.Max(peak,Math.Abs(v));
                    }
                    frames+=count;input.ReleaseBuffer(count);
                }
            }
            client.Stop();
            report["opened"]=true;report["frames"]=frames;report["peakDb"]=peak>0?Math.Round(20*Math.Log10(peak),1):-120.0;report["silentFlag"]=silentFlag;
            return report;
        }finally{if(mix!=IntPtr.Zero)Marshal.FreeCoTaskMem(mix);ComAudio.Release(input);ComAudio.Release(client);ComAudio.Release(device);ComAudio.Release(enumerator);signal?.Dispose();}
    }
}
