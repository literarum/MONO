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
public sealed record AudioDevice(string Id,string Name,bool Default);
public sealed record DeviceInventory(IReadOnlyList<AudioDevice> Inputs,IReadOnlyList<AudioDevice> Outputs);
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
    public static DeviceInventory Enumerate()
    {
        if(!OperatingSystem.IsWindowsVersionAtLeast(10,0,19045))throw new PlatformNotSupportedException("NOT_SUPPORTED");
        var enumerator=(IDeviceEnumerator)new DeviceEnumeratorCom();
        try{return new DeviceInventory(List(enumerator,DataFlow.Capture),List(enumerator,DataFlow.Render));}finally{ComAudio.Release(enumerator);}
    }
}
