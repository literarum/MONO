using System.Runtime.InteropServices;
namespace MonoAudio;

internal enum DataFlow {Render=0,Capture=1,All=2}
internal enum DeviceRole {Console=0,Multimedia=1,Communications=2}
[StructLayout(LayoutKind.Sequential)] internal struct PropertyKey {public Guid Format;public uint Id;public PropertyKey(Guid format,uint id){Format=format;Id=id;}}
[StructLayout(LayoutKind.Explicit,Size=24)] internal struct PropVariant {[FieldOffset(0)]public ushort Type;[FieldOffset(8)]public IntPtr Pointer;}
[ComImport,Guid("BCDE0395-E52F-467C-8E3D-C4579291692E"),ClassInterface(ClassInterfaceType.None)] internal class DeviceEnumeratorCom { }
[ComImport,Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"),InterfaceType(ComInterfaceType.InterfaceIsIUnknown)] internal interface IDeviceEnumerator
{
    [PreserveSig]int EnumAudioEndpoints(DataFlow flow,uint mask,out IDeviceCollection devices);
    [PreserveSig]int GetDefaultAudioEndpoint(DataFlow flow,DeviceRole role,out IDevice device);
    [PreserveSig]int GetDevice([MarshalAs(UnmanagedType.LPWStr)]string id,out IDevice device);
    [PreserveSig]int RegisterEndpointNotificationCallback(IDeviceNotifications notification);
    [PreserveSig]int UnregisterEndpointNotificationCallback(IDeviceNotifications notification);
}
[ComImport,Guid("0BD7A1BE-7A1A-44DB-8397-CC5392387B5E"),InterfaceType(ComInterfaceType.InterfaceIsIUnknown)] internal interface IDeviceCollection
{
    [PreserveSig]int GetCount(out uint count);
    [PreserveSig]int Item(uint index,out IDevice device);
}
[ComImport,Guid("D666063F-1587-4E43-81F1-B948E807363F"),InterfaceType(ComInterfaceType.InterfaceIsIUnknown)] internal interface IDevice
{
    [PreserveSig]int Activate(ref Guid iid,uint context,IntPtr activation,[MarshalAs(UnmanagedType.IUnknown)]out object value);
    [PreserveSig]int OpenPropertyStore(uint access,out IPropertyStore properties);
    [PreserveSig]int GetId([MarshalAs(UnmanagedType.LPWStr)]out string id);
    [PreserveSig]int GetState(out uint state);
}
[ComImport,Guid("1BE09788-6894-4089-8586-9A2A6C265AC5"),InterfaceType(ComInterfaceType.InterfaceIsIUnknown)] internal interface IEndpoint
{
    [PreserveSig]int GetDataFlow(out DataFlow flow);
}
[ComImport,Guid("886D8EEB-8CF2-4446-8D02-CDBA1DBDCF99"),InterfaceType(ComInterfaceType.InterfaceIsIUnknown)] internal interface IPropertyStore
{
    [PreserveSig]int GetCount(out uint count);
    [PreserveSig]int GetAt(uint index,out PropertyKey key);
    [PreserveSig]int GetValue(ref PropertyKey key,out PropVariant value);
    [PreserveSig]int SetValue(ref PropertyKey key,ref PropVariant value);
    [PreserveSig]int Commit();
}
[Guid("7991EEC9-7E89-4D85-8390-6C703CEC60C0"),InterfaceType(ComInterfaceType.InterfaceIsIUnknown),ComVisible(true)] internal interface IDeviceNotifications
{
    [PreserveSig]int OnDeviceStateChanged([MarshalAs(UnmanagedType.LPWStr)]string id,uint state);
    [PreserveSig]int OnDeviceAdded([MarshalAs(UnmanagedType.LPWStr)]string id);
    [PreserveSig]int OnDeviceRemoved([MarshalAs(UnmanagedType.LPWStr)]string id);
    [PreserveSig]int OnDefaultDeviceChanged(DataFlow flow,DeviceRole role,[MarshalAs(UnmanagedType.LPWStr)]string? id);
    [PreserveSig]int OnPropertyValueChanged([MarshalAs(UnmanagedType.LPWStr)]string id,PropertyKey key);
}
[ComImport,Guid("1CB9AD4C-DBFA-4C32-B178-C2F568A703B2"),InterfaceType(ComInterfaceType.InterfaceIsIUnknown)] internal interface IAudioClient
{
    [PreserveSig]int Initialize(int shareMode,uint flags,long duration,long periodicity,IntPtr format,ref Guid session);
    [PreserveSig]int GetBufferSize(out uint frames);
    [PreserveSig]int GetStreamLatency(out long latency);
    [PreserveSig]int GetCurrentPadding(out uint frames);
    [PreserveSig]int IsFormatSupported(int mode,IntPtr format,out IntPtr closest);
    [PreserveSig]int GetMixFormat(out IntPtr format);
    [PreserveSig]int GetDevicePeriod(out long defaultPeriod,out long minimumPeriod);
    [PreserveSig]int Start();
    [PreserveSig]int Stop();
    [PreserveSig]int Reset();
    [PreserveSig]int SetEventHandle(IntPtr handle);
    [PreserveSig]int GetService(ref Guid iid,[MarshalAs(UnmanagedType.IUnknown)]out object service);
}
// endpointvolume.h; method order verified against pycaw's comtypes declaration.
[ComImport,Guid("5CDF2C82-841E-4546-9722-0CF74078229A"),InterfaceType(ComInterfaceType.InterfaceIsIUnknown)] internal interface IAudioEndpointVolume
{
    [PreserveSig]int RegisterControlChangeNotify(IntPtr notify);
    [PreserveSig]int UnregisterControlChangeNotify(IntPtr notify);
    [PreserveSig]int GetChannelCount(out uint count);
    [PreserveSig]int SetMasterVolumeLevel(float levelDb,IntPtr context);
    [PreserveSig]int SetMasterVolumeLevelScalar(float level,IntPtr context);
    [PreserveSig]int GetMasterVolumeLevel(out float levelDb);
    [PreserveSig]int GetMasterVolumeLevelScalar(out float level);
    [PreserveSig]int SetChannelVolumeLevel(uint channel,float levelDb,IntPtr context);
    [PreserveSig]int SetChannelVolumeLevelScalar(uint channel,float level,IntPtr context);
    [PreserveSig]int GetChannelVolumeLevel(uint channel,out float levelDb);
    [PreserveSig]int GetChannelVolumeLevelScalar(uint channel,out float level);
    [PreserveSig]int SetMute([MarshalAs(UnmanagedType.Bool)]bool mute,IntPtr context);
    [PreserveSig]int GetMute([MarshalAs(UnmanagedType.Bool)]out bool mute);
}
[ComImport,Guid("C8ADBD64-E71E-48A0-A4DE-185C395CD317"),InterfaceType(ComInterfaceType.InterfaceIsIUnknown)] internal interface IAudioCaptureClient
{
    [PreserveSig]int GetBuffer(out IntPtr data,out uint frames,out uint flags,out ulong devicePosition,out ulong qpc100Ns);
    [PreserveSig]int ReleaseBuffer(uint frames);
    [PreserveSig]int GetNextPacketSize(out uint frames);
}
internal sealed class AudioFailure(string code,int? nativeCode=null) : Exception(code) {public string Code{get;}=code;public int? NativeCode{get;}=nativeCode;}
internal static class ComAudio
{
    internal static void Check(int result)
    {
        if(result>=0)return;
        throw new AudioFailure(unchecked((uint)result) switch {0x80070005=>"ACCESS_DENIED",0x88890004=>"DEVICE_LOST",0x8889000A=>"DEVICE_BUSY",0x88890008=>"UNSUPPORTED_FORMAT",0x80070490=>"DEVICE_LOST",_=>"INTERNAL"},result);
    }
    internal static void Release(object? value){if(value is not null&&Marshal.IsComObject(value))Marshal.ReleaseComObject(value);}
    [DllImport("ole32.dll")]internal static extern int PropVariantClear(ref PropVariant value);
}
/// Scheduling for glitch-free capture under load.
/// MMCSS "Pro Audio" for capture threads (as GStreamer's WASAPI source does) and opting the
/// process out of EcoQoS / Efficiency mode while recording. Constants verified against the
/// windows-sys metadata: ProcessPowerThrottling=4, CURRENT_VERSION=1, EXECUTION_SPEED=1.
internal static class Realtime
{
    [DllImport("avrt.dll",CharSet=CharSet.Unicode,SetLastError=true)]static extern IntPtr AvSetMmThreadCharacteristicsW(string task,ref uint index);
    [DllImport("avrt.dll",SetLastError=true)][return:MarshalAs(UnmanagedType.Bool)]static extern bool AvRevertMmThreadCharacteristics(IntPtr handle);
    [StructLayout(LayoutKind.Sequential)]struct PowerThrottlingState{public uint Version;public uint ControlMask;public uint StateMask;}
    [DllImport("kernel32.dll",SetLastError=true)][return:MarshalAs(UnmanagedType.Bool)]static extern bool SetProcessInformation(IntPtr process,int informationClass,ref PowerThrottlingState information,uint size);
    [DllImport("kernel32.dll")]static extern IntPtr GetCurrentProcess();
    public static IntPtr EnterProAudio(){try{uint index=0;return AvSetMmThreadCharacteristicsW("Pro Audio",ref index);}catch(Exception error) when(error is DllNotFoundException or EntryPointNotFoundException){return IntPtr.Zero;}}
    public static void Leave(IntPtr handle){if(handle==IntPtr.Zero)return;try{AvRevertMmThreadCharacteristics(handle);}catch(Exception error) when(error is DllNotFoundException or EntryPointNotFoundException){}}
    /// ControlMask=EXECUTION_SPEED with StateMask=0: "never throttle execution speed" (high QoS).
    public static bool KeepFullSpeed(bool recording)
    {
        try{var state=new PowerThrottlingState{Version=1,ControlMask=recording?1u:0u,StateMask=0};return SetProcessInformation(GetCurrentProcess(),4,ref state,(uint)Marshal.SizeOf<PowerThrottlingState>());}
        catch(EntryPointNotFoundException){return false;}
    }
}
public sealed record AudioDevice(string Id,string Name,bool Default);
public sealed record DeviceInventory(IReadOnlyList<AudioDevice> Inputs,IReadOnlyList<AudioDevice> Outputs);
/// Capture endpoint health as Windows reports it. State: 1 active, 2 disabled (Sound control panel),
/// 4 not present (Device Manager), 8 unplugged. Mute/volume only exist for active endpoints.
public sealed record InputHealth(string Id,string Name,bool Default,uint State,bool? Muted,float? Volume);
public static class CoreAudio
{
    public static object ProbeLoopbackInitialization()
    {
        object? result=null;Exception? problem=null;
        var thread=new Thread(()=>{
            try{
                var rows=new List<object>();
                foreach(var settings in new[]{(Flags:0x60000u,Buffer:1_000_000L),(Flags:0x60000u,Buffer:0L),(Flags:0x20000u,Buffer:1_000_000L),(Flags:0u,Buffer:1_000_000L)}){
                    var enumerator=(IDeviceEnumerator)new DeviceEnumeratorCom();IDevice? device=null;IAudioClient? client=null;IntPtr mix=IntPtr.Zero;
                    try{
                        ComAudio.Check(enumerator.GetDefaultAudioEndpoint(DataFlow.Render,DeviceRole.Console,out device));var iid=typeof(IAudioClient).GUID;ComAudio.Check(device.Activate(ref iid,23,IntPtr.Zero,out var activated));client=(IAudioClient)activated;ComAudio.Check(client.GetMixFormat(out mix));
                        int extra=(ushort)Marshal.ReadInt16(mix,16);var bytes=new byte[18+extra];Marshal.Copy(mix,bytes,0,bytes.Length);var guid=Guid.Empty;
                        ComAudio.Check(((IEndpoint)device).GetDataFlow(out var actualFlow));
                        int hr=client.Initialize(0,settings.Flags,settings.Buffer,0,mix,ref guid);
                        rows.Add(new {flags=settings.Flags,buffer=settings.Buffer,hresult=hr.ToString("X8"),flow=actualFlow.ToString(),waveFormat=Convert.ToHexString(bytes),physicalCaptureStarted=false});
                    }finally{if(mix!=IntPtr.Zero)Marshal.FreeCoTaskMem(mix);ComAudio.Release(client);ComAudio.Release(device);ComAudio.Release(enumerator);}
                }result=rows;
            }catch(Exception error){problem=error;}
        });thread.SetApartmentState(ApartmentState.STA);thread.Start();thread.Join();if(problem is not null)throw problem;return result!;
    }
    static string? DefaultId(IDeviceEnumerator enumerator,DataFlow flow)
    {
        int result=enumerator.GetDefaultAudioEndpoint(flow,DeviceRole.Console,out var device);
        if(unchecked((uint)result)==0x80070490)return null;
        ComAudio.Check(result);try{ComAudio.Check(device.GetId(out var id));return id;}finally{ComAudio.Release(device);}
    }
    static IReadOnlyList<AudioDevice> List(IDeviceEnumerator enumerator,DataFlow flow)
    {
        string? defaultId=DefaultId(enumerator,flow);ComAudio.Check(enumerator.EnumAudioEndpoints(flow,1,out var collection));var result=new List<AudioDevice>();
        try{
            ComAudio.Check(collection.GetCount(out var count));if(count>256)throw new AudioFailure("INTERNAL");
            for(uint i=0;i<count;i++){
                ComAudio.Check(collection.Item(i,out var device));
                try{
                    ComAudio.Check(device.GetId(out var id));ComAudio.Check(device.OpenPropertyStore(0,out var properties));
                    string? name=null;try{
                        var key=new PropertyKey(new Guid("A45C254E-DF1C-4EFD-8020-67D146A850E0"),14);ComAudio.Check(properties.GetValue(ref key,out var value));
                        try{if(value.Type==31)name=Marshal.PtrToStringUni(value.Pointer);}finally{ComAudio.PropVariantClear(ref value);}
                    }finally{ComAudio.Release(properties);}
                    result.Add(new AudioDevice(id,string.IsNullOrWhiteSpace(name)?(flow==DataFlow.Capture?"Устройство ввода":"Устройство вывода"):name,id==defaultId));
                }finally{ComAudio.Release(device);}
            }
        }finally{ComAudio.Release(collection);}
        return result;
    }
    static string FriendlyName(IDevice device,DataFlow flow)
    {
        string? name=null;
        if(device.OpenPropertyStore(0,out var properties)==0)try{
            var key=new PropertyKey(new Guid("A45C254E-DF1C-4EFD-8020-67D146A850E0"),14);
            if(properties.GetValue(ref key,out var value)==0)try{if(value.Type==31)name=Marshal.PtrToStringUni(value.Pointer);}finally{ComAudio.PropVariantClear(ref value);}
        }finally{ComAudio.Release(properties);}
        return string.IsNullOrWhiteSpace(name)?(flow==DataFlow.Capture?"Устройство ввода":"Устройство вывода"):name;
    }
    static IAudioEndpointVolume? Volume(IDevice device)
    {
        var iid=typeof(IAudioEndpointVolume).GUID;
        return device.Activate(ref iid,23,IntPtr.Zero,out var value)==0?(IAudioEndpointVolume)value:null;
    }
    /// Every capture endpoint in every state (DEVICE_STATEMASK_ALL), with mute and level for active ones.
    public static IReadOnlyList<InputHealth> DiagnoseInputs()
    {
        var enumerator=(IDeviceEnumerator)new DeviceEnumeratorCom();
        try{
            string? defaultId=DefaultId(enumerator,DataFlow.Capture);ComAudio.Check(enumerator.EnumAudioEndpoints(DataFlow.Capture,0xF,out var collection));var result=new List<InputHealth>();
            try{
                ComAudio.Check(collection.GetCount(out var count));
                for(uint i=0;i<count&&i<256;i++){
                    if(collection.Item(i,out var device)!=0)continue;
                    try{
                        if(device.GetId(out var id)!=0||device.GetState(out var state)!=0)continue;
                        bool? muted=null;float? volume=null;
                        if(state==1){var control=Volume(device);if(control is not null)try{if(control.GetMute(out var m)==0)muted=m;if(control.GetMasterVolumeLevelScalar(out var v)==0)volume=v;}finally{ComAudio.Release(control);}}
                        result.Add(new InputHealth(id,FriendlyName(device,DataFlow.Capture),id==defaultId,state,muted,volume));
                    }finally{ComAudio.Release(device);}
                }
            }finally{ComAudio.Release(collection);}
            return result;
        }finally{ComAudio.Release(enumerator);}
    }
    /// Self-repair on explicit intent: unmute and/or raise a near-zero input level of one
    /// endpoint (default capture when id is null). Never changes which device is default.
    public static void RepairInput(string? id,bool? mute,float? minimumVolume)
    {
        var enumerator=(IDeviceEnumerator)new DeviceEnumeratorCom();IDevice? device=null;IAudioEndpointVolume? control=null;
        try{
            ComAudio.Check(id is null?enumerator.GetDefaultAudioEndpoint(DataFlow.Capture,DeviceRole.Console,out device):enumerator.GetDevice(id,out device));
            control=Volume(device)??throw new AudioFailure("NOT_SUPPORTED");
            if(mute is bool m)ComAudio.Check(control.SetMute(m,IntPtr.Zero));
            if(minimumVolume is float target&&control.GetMasterVolumeLevelScalar(out var current)==0&&current<target)ComAudio.Check(control.SetMasterVolumeLevelScalar(Math.Clamp(target,0f,1f),IntPtr.Zero));
        }finally{ComAudio.Release(control);ComAudio.Release(device);ComAudio.Release(enumerator);}
    }
    public static DeviceInventory Enumerate()
    {
        if(!OperatingSystem.IsWindowsVersionAtLeast(10,0,17763))throw new PlatformNotSupportedException("NOT_SUPPORTED");
        var enumerator=(IDeviceEnumerator)new DeviceEnumeratorCom();
        try{return new DeviceInventory(List(enumerator,DataFlow.Capture),List(enumerator,DataFlow.Render));}finally{ComAudio.Release(enumerator);}
    }
}
