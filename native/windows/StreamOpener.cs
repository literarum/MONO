using System.Runtime.InteropServices;
namespace MonoAudio;

[StructLayout(LayoutKind.Sequential)] internal struct AudioClientProperties {public uint Size;public int IsOffload;public int Category;public int Options;}
// audioclient.h: IAudioClient2 = IAudioClient + 3 methods; IAudioClient3 = IAudioClient2 + 3 methods (vtable order).
[ComImport,Guid("726778CD-F60A-4EDA-82DE-E47610CD78AA"),InterfaceType(ComInterfaceType.InterfaceIsIUnknown)] internal interface IAudioClient2
{
    [PreserveSig]int Initialize(int shareMode,uint flags,long duration,long periodicity,IntPtr format,ref Guid session);
    [PreserveSig]int GetBufferSize(out uint frames);[PreserveSig]int GetStreamLatency(out long latency);[PreserveSig]int GetCurrentPadding(out uint frames);
    [PreserveSig]int IsFormatSupported(int mode,IntPtr format,out IntPtr closest);[PreserveSig]int GetMixFormat(out IntPtr format);
    [PreserveSig]int GetDevicePeriod(out long defaultPeriod,out long minimumPeriod);[PreserveSig]int Start();[PreserveSig]int Stop();[PreserveSig]int Reset();
    [PreserveSig]int SetEventHandle(IntPtr handle);[PreserveSig]int GetService(ref Guid iid,[MarshalAs(UnmanagedType.IUnknown)]out object service);
    [PreserveSig]int IsOffloadCapable(int category,out int capable);
    [PreserveSig]int SetClientProperties(ref AudioClientProperties properties);
    [PreserveSig]int GetBufferSizeLimits(IntPtr format,int eventDriven,out long minimum,out long maximum);
}
[ComImport,Guid("7ED4EE07-8E67-4CD4-8C1A-2B7A5987AD42"),InterfaceType(ComInterfaceType.InterfaceIsIUnknown)] internal interface IAudioClient3
{
    [PreserveSig]int Initialize(int shareMode,uint flags,long duration,long periodicity,IntPtr format,ref Guid session);
    [PreserveSig]int GetBufferSize(out uint frames);[PreserveSig]int GetStreamLatency(out long latency);[PreserveSig]int GetCurrentPadding(out uint frames);
    [PreserveSig]int IsFormatSupported(int mode,IntPtr format,out IntPtr closest);[PreserveSig]int GetMixFormat(out IntPtr format);
    [PreserveSig]int GetDevicePeriod(out long defaultPeriod,out long minimumPeriod);[PreserveSig]int Start();[PreserveSig]int Stop();[PreserveSig]int Reset();
    [PreserveSig]int SetEventHandle(IntPtr handle);[PreserveSig]int GetService(ref Guid iid,[MarshalAs(UnmanagedType.IUnknown)]out object service);
    [PreserveSig]int IsOffloadCapable(int category,out int capable);
    [PreserveSig]int SetClientProperties(ref AudioClientProperties properties);
    [PreserveSig]int GetBufferSizeLimits(IntPtr format,int eventDriven,out long minimum,out long maximum);
    [PreserveSig]int GetSharedModeEnginePeriod(IntPtr format,out uint defaultPeriod,out uint fundamentalPeriod,out uint minimumPeriod,out uint maximumPeriod);
    [PreserveSig]int GetCurrentSharedModeEnginePeriod(out IntPtr format,out uint currentPeriod);
    [PreserveSig]int InitializeSharedAudioStream(uint flags,uint periodInFrames,IntPtr format,IntPtr session);
}

/// One opened shared-mode stream: the client (as IAudioClient), whether it signals an event,
/// and the exact format it delivers (which may differ from the mix format for the PCM16 path).
internal sealed record OpenedStream(IAudioClient Client,bool EventDriven,byte[] Format,string Variant);

/// Dissimilar ways to open one endpoint in shared mode. Some drivers (reported for the Intel
/// Smart Sound digital microphone) answer E_INVALIDARG to the plain request with their own mix
/// format, while another process opening the same endpoint succeeds; Microsoft gives no single
/// rule, so each variant is tried on a fresh client and every HRESULT is kept for diagnostics.
/// Privacy denial, exclusive use and a vanished device are final answers and are not retried.
internal static class StreamOpener
{
    const uint EventCallback=0x40000u,Loopback=0x20000u,AutoConvert=0x80000000u,SrcDefault=0x08000000u;
    static readonly Guid Client2=typeof(IAudioClient2).GUID,Client3=typeof(IAudioClient3).GUID,Client1=typeof(IAudioClient).GUID;
    static string Hex(int hr)=>unchecked((uint)hr).ToString("X8");
    public static bool Final(int hr)=>unchecked((uint)hr) is 0x80070005u or 0x8889000Au or 0x88890004u;
    static byte[] Bytes(IntPtr format){int extra=(ushort)Marshal.ReadInt16(format,16);var bytes=new byte[18+Math.Min(extra,4096)];Marshal.Copy(format,bytes,0,bytes.Length);return bytes;}
    static IntPtr Pcm16(){var p=Marshal.AllocCoTaskMem(18);Marshal.WriteInt16(p,0,1);Marshal.WriteInt16(p,2,2);Marshal.WriteInt32(p,4,48000);Marshal.WriteInt32(p,8,48000*4);Marshal.WriteInt16(p,12,4);Marshal.WriteInt16(p,14,16);Marshal.WriteInt16(p,16,0);return p;}

    /// Tries the variants in order; returns the first stream that initialises, or null with
    /// every attempt in `attempts` (variant → HRESULT).
    public static OpenedStream? Open(IDevice device,IntPtr mix,bool loopback,List<KeyValuePair<string,string>> attempts)
    {
        uint loop=loopback?Loopback:0;
        var variants=new List<(string Name,Func<OpenedStream?>)>{
            ("event",()=>Plain(device,mix,EventCallback|loop,0,true,"event",attempts)),
            ("autoconvert",()=>Plain(device,mix,EventCallback|loop|AutoConvert|SrcDefault,2_000_000,true,"autoconvert",attempts)),
            ("polling",()=>Plain(device,mix,loop,2_000_000,false,"polling",attempts)),
        };
        if(!loopback){
            variants.Add(("client3",()=>Shared3(device,mix,attempts)));
            variants.Add(("communications",()=>Category(device,mix,3,attempts)));
            variants.Add(("pcm16",()=>{var f=Pcm16();try{return Plain(device,f,EventCallback|AutoConvert|SrcDefault,2_000_000,true,"pcm16",attempts);}finally{Marshal.FreeCoTaskMem(f);}}));
        }
        foreach(var (_,attempt) in variants){
            var opened=attempt();if(opened is not null)return opened;
            if(attempts.Count>0&&int.TryParse(attempts[^1].Value,System.Globalization.NumberStyles.HexNumber,null,out var last)&&Final(last))return null;
        }
        return null;
    }
    static OpenedStream? Plain(IDevice device,IntPtr format,uint flags,long duration,bool eventDriven,string name,List<KeyValuePair<string,string>> attempts)
    {
        var iid=Client1;int hr=device.Activate(ref iid,23,IntPtr.Zero,out var value);if(hr<0){attempts.Add(new(name+"-activate",Hex(hr)));return null;}
        var client=(IAudioClient)value;var session=Guid.NewGuid();hr=client.Initialize(0,flags,duration,0,format,ref session);attempts.Add(new(name,Hex(hr)));
        if(hr<0){ComAudio.Release(client);return null;}
        return new OpenedStream(client,eventDriven,Bytes(format),name);
    }
    static OpenedStream? Shared3(IDevice device,IntPtr mix,List<KeyValuePair<string,string>> attempts)
    {
        var iid=Client3;int hr=device.Activate(ref iid,23,IntPtr.Zero,out var value);if(hr<0){attempts.Add(new("client3-activate",Hex(hr)));return null;}
        var client=(IAudioClient3)value;
        hr=client.GetSharedModeEnginePeriod(mix,out uint period,out _,out _,out _);
        if(hr>=0)hr=client.InitializeSharedAudioStream(EventCallback,period,mix,IntPtr.Zero);
        attempts.Add(new("client3",Hex(hr)));
        if(hr<0){ComAudio.Release(client);return null;}
        return new OpenedStream((IAudioClient)client,true,Bytes(mix),"client3");
    }
    static OpenedStream? Category(IDevice device,IntPtr mix,int category,List<KeyValuePair<string,string>> attempts)
    {
        var iid=Client2;int hr=device.Activate(ref iid,23,IntPtr.Zero,out var value);if(hr<0){attempts.Add(new("communications-activate",Hex(hr)));return null;}
        var client=(IAudioClient2)value;var properties=new AudioClientProperties{Size=(uint)Marshal.SizeOf<AudioClientProperties>(),IsOffload=0,Category=category,Options=0};
        hr=client.SetClientProperties(ref properties);
        if(hr>=0){var session=Guid.NewGuid();hr=client.Initialize(0,EventCallback,0,0,mix,ref session);}
        attempts.Add(new("communications",Hex(hr)));
        if(hr<0){ComAudio.Release(client);return null;}
        return new OpenedStream((IAudioClient)client,true,Bytes(mix),"communications");
    }
}
