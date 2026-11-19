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
        Dictionary<string,object?>? result=null;Exception? problem=null;
        var thread=new Thread(()=>{try{result=Probe(id);}catch(Exception error){problem=error;}});
        thread.SetApartmentState(ApartmentState.MTA);thread.Start();if(!thread.Join(8000))return new(){{"opened",false},{"step","timeout"}};
        if(problem is not null)return new(){{"opened",false},{"step","exception"},{"code",problem is AudioFailure f?f.Code:problem.GetType().Name},{"hresult",problem is AudioFailure g&&g.NativeCode is int n?Hex(n):problem is COMException c?Hex(c.HResult):null}};
        return result!;
    }
    static Dictionary<string,object?> Probe(string? id)
    {
        var report=new Dictionary<string,object?>{{"opened",false}};
        var enumerator=(IDeviceEnumerator)new DeviceEnumeratorCom();IDevice? device=null;IAudioClient? client=null;IAudioCaptureClient? input=null;IntPtr mix=IntPtr.Zero;
        try{
            int hr=id is null?enumerator.GetDefaultAudioEndpoint(DataFlow.Capture,DeviceRole.Console,out device):enumerator.GetDevice(id,out device);
            if(hr<0){report["step"]="resolve-device";report["hresult"]=Hex(hr);return report;}
            if(device.GetId(out var actual)==0)report["id"]=actual;
            report["rawSupported"]=Raw(device);
            var iid=typeof(IAudioClient).GUID;hr=device.Activate(ref iid,23,IntPtr.Zero,out var activated);
            if(hr<0){report["step"]="activate";report["hresult"]=Hex(hr);return report;}
            client=(IAudioClient)activated;
            hr=client.GetMixFormat(out mix);if(hr<0){report["step"]="mix-format";report["hresult"]=Hex(hr);return report;}
            report["mixFormat"]=new Dictionary<string,object?>{{"tag",(ushort)Marshal.ReadInt16(mix,0)},{"channels",(ushort)Marshal.ReadInt16(mix,2)},{"rate",Marshal.ReadInt32(mix,4)},{"bits",(ushort)Marshal.ReadInt16(mix,14)}};
            // What Chromium asks for by default: 48 kHz, stereo, 16-bit PCM.
            var request=Marshal.AllocCoTaskMem(18);
            try{
                Marshal.WriteInt16(request,0,1);Marshal.WriteInt16(request,2,2);Marshal.WriteInt32(request,4,48000);Marshal.WriteInt32(request,8,48000*4);Marshal.WriteInt16(request,12,4);Marshal.WriteInt16(request,14,16);Marshal.WriteInt16(request,16,0);
                int supported=client.IsFormatSupported(0,request,out var closest);if(closest!=IntPtr.Zero)Marshal.FreeCoTaskMem(closest);
                report["browserFormat"]=supported==0?"supported":supported==1?"closest-match":Hex(supported);
            }finally{Marshal.FreeCoTaskMem(request);}
            var session=Guid.NewGuid();hr=client.Initialize(0,0,2_000_000,0,mix,ref session);report["initPlain"]=Hex(hr);
            if(hr<0){
                ComAudio.Release(client);client=null;
                hr=device.Activate(ref iid,23,IntPtr.Zero,out var retry);if(hr<0){report["step"]="activate-retry";report["hresult"]=Hex(hr);return report;}
                client=(IAudioClient)retry;session=Guid.NewGuid();hr=client.Initialize(0,0x80000000u|0x08000000u,2_000_000,0,mix,ref session);report["initAutoconvert"]=Hex(hr);
                if(hr<0){report["step"]="initialize";report["hresult"]=Hex(hr);return report;}
            }
            iid=typeof(IAudioCaptureClient).GUID;hr=client.GetService(ref iid,out var service);if(hr<0){report["step"]="capture-service";report["hresult"]=Hex(hr);return report;}
            input=(IAudioCaptureClient)service;
            hr=client.Start();if(hr<0){report["step"]="start";report["hresult"]=Hex(hr);return report;}
            int channels=(ushort)Marshal.ReadInt16(mix,2),bits=(ushort)Marshal.ReadInt16(mix,14),tag=(ushort)Marshal.ReadInt16(mix,0);
            if(tag==0xFFFE&&(ushort)Marshal.ReadInt16(mix,16)>=22){var sub=new byte[16];Marshal.Copy(mix+24,sub,0,16);tag=BitConverter.ToUInt16(sub,0);}
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
        }finally{if(mix!=IntPtr.Zero)Marshal.FreeCoTaskMem(mix);ComAudio.Release(input);ComAudio.Release(client);ComAudio.Release(device);ComAudio.Release(enumerator);}
    }
}
