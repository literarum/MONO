using System.Diagnostics;
using System.Runtime.InteropServices;
namespace MonoAudio;

// Sound of one application (and the processes it started) through Windows' process loopback:
// ActivateAudioInterfaceAsync on the virtual device VAD\Process_Loopback with
// AUDIOCLIENT_ACTIVATION_PARAMS {PROCESS_LOOPBACK, pid, INCLUDE_TARGET_PROCESS_TREE}.
// Microsoft documents it from Windows 10 build 20348 (AUDIOCLIENT_ACTIVATION_PARAMS, sdk-api;
// Windows-classic-samples/ApplicationLoopback, "requires Windows 10 build 20348 or later"), i.e.
// Windows 11 and Windows Server 2022. As in that sample, the stream is opened with a fixed 16-bit
// PCM format, LOOPBACK | EVENTCALLBACK | AUTOCONVERTPCM; Windows converts the program's sound to it.

[ComImport,Guid("72A22D78-CDE4-431D-B8CC-843A71199B6D"),InterfaceType(ComInterfaceType.InterfaceIsIUnknown)] internal interface IActivateAudioInterfaceAsyncOperation
{
    [PreserveSig]int GetActivateResult(out int activateResult,[MarshalAs(UnmanagedType.IUnknown)]out object? activatedInterface);
}
[ComImport,Guid("41D949AB-9862-444A-80F6-C261334DA5EB"),InterfaceType(ComInterfaceType.InterfaceIsIUnknown)] internal interface IActivateAudioInterfaceCompletionHandler
{
    [PreserveSig]int ActivateCompleted(IActivateAudioInterfaceAsyncOperation operation);
}
// The completion arrives on a system worker thread; IAgileObject tells Windows the handler may be called there directly.
[ComImport,Guid("94EA2B94-E9CC-49E0-C0FF-EE64CA8F5B90"),InterfaceType(ComInterfaceType.InterfaceIsIUnknown)] internal interface IAgileObject { }

[ComVisible(true),ClassInterface(ClassInterfaceType.None)] internal sealed class ActivationCompletion : IActivateAudioInterfaceCompletionHandler,IAgileObject
{
    public readonly ManualResetEventSlim Done=new(false);public int Result=unchecked((int)0x80004005);public object? Client;
    public int ActivateCompleted(IActivateAudioInterfaceAsyncOperation operation)
    {
        try{int hr=operation.GetActivateResult(out int activated,out var client);Result=hr<0?hr:activated;Client=Result>=0?client:null;}
        catch(COMException error){Result=error.HResult;}
        finally{Done.Set();}
        return 0;
    }
}

public static class ProcessLoopback
{
    public const int MinimumBuild=20348;
    public static bool Supported=>OperatingSystem.IsWindows()&&Environment.OSVersion.Version.Build>=MinimumBuild;
    const string VirtualDevice="VAD\\Process_Loopback";const ushort VtBlob=65;
    const uint EventCallback=0x40000u,Loopback=0x20000u,AutoConvert=0x80000000u,SrcDefault=0x08000000u;

    [DllImport("Mmdevapi.dll",ExactSpelling=true,CharSet=CharSet.Unicode)]
    static extern int ActivateAudioInterfaceAsync(string deviceInterfacePath,ref Guid riid,IntPtr activationParams,IActivateAudioInterfaceCompletionHandler completionHandler,out IActivateAudioInterfaceAsyncOperation operation);

    /// 48 kHz, stereo, 16-bit PCM WAVEFORMATEX (18 bytes).
    public static byte[] Format()
    {
        var bytes=new byte[18];
        BitConverter.TryWriteBytes(bytes.AsSpan(0),(ushort)1);BitConverter.TryWriteBytes(bytes.AsSpan(2),(ushort)2);BitConverter.TryWriteBytes(bytes.AsSpan(4),48000);
        BitConverter.TryWriteBytes(bytes.AsSpan(8),48000*4);BitConverter.TryWriteBytes(bytes.AsSpan(12),(ushort)4);BitConverter.TryWriteBytes(bytes.AsSpan(14),(ushort)16);
        return bytes;
    }

    /// An initialised shared-mode loopback client for the process tree of `processId`.
    internal static IAudioClient Open(int processId,List<KeyValuePair<string,string>> attempts)
    {
        if(!Supported)throw new AudioFailure("NOT_SUPPORTED");
        try{using var process=Process.GetProcessById(processId);if(process.HasExited)throw new AudioFailure("DEVICE_LOST");}
        catch(ArgumentException){throw new AudioFailure("DEVICE_LOST");}
        catch(InvalidOperationException){throw new AudioFailure("DEVICE_LOST");}
        // AUDIOCLIENT_ACTIVATION_PARAMS: ActivationType (1 = PROCESS_LOOPBACK), TargetProcessId, ProcessLoopbackMode (0 = include tree).
        IntPtr parameters=Marshal.AllocCoTaskMem(12),variant=Marshal.AllocCoTaskMem(24),format=IntPtr.Zero;
        var completion=new ActivationCompletion();
        try{
            Marshal.WriteInt32(parameters,0,1);Marshal.WriteInt32(parameters,4,processId);Marshal.WriteInt32(parameters,8,0);
            // PROPVARIANT (x64): vt @0, BLOB.cbSize @8, BLOB.pBlobData @16.
            for(int offset=0;offset<24;offset+=4)Marshal.WriteInt32(variant,offset,0);
            Marshal.WriteInt16(variant,0,unchecked((short)VtBlob));Marshal.WriteInt32(variant,8,12);Marshal.WriteIntPtr(variant,16,parameters);
            var iid=typeof(IAudioClient).GUID;
            int hr=ActivateAudioInterfaceAsync(VirtualDevice,ref iid,variant,completion,out var operation);
            attempts.Add(new("process-activate",unchecked((uint)hr).ToString("X8")));
            if(hr<0)throw new AudioFailure("INTERNAL",hr);
            try{
                if(!completion.Done.Wait(5000))throw new AudioFailure("START_TIMEOUT");
            }finally{ComAudio.Release(operation);}
            attempts.Add(new("process-activated",unchecked((uint)completion.Result).ToString("X8")));
            if(completion.Result<0||completion.Client is not IAudioClient client){ComAudio.Check(completion.Result<0?completion.Result:unchecked((int)0x80004005));throw new AudioFailure("INTERNAL",completion.Result);}
            var bytes=Format();format=Marshal.AllocCoTaskMem(bytes.Length);Marshal.Copy(bytes,0,format,bytes.Length);
            var session=Guid.Empty;hr=client.Initialize(0,Loopback|EventCallback|AutoConvert|SrcDefault,2_000_000,0,format,ref session);
            attempts.Add(new("process-initialize",unchecked((uint)hr).ToString("X8")));
            if(hr<0){ComAudio.Release(client);ComAudio.Check(hr);throw new AudioFailure("INTERNAL",hr);}
            return client;
        }finally{
            Marshal.FreeCoTaskMem(parameters);Marshal.FreeCoTaskMem(variant);if(format!=IntPtr.Zero)Marshal.FreeCoTaskMem(format);completion.Done.Dispose();
        }
    }

    /// Opens and closes a capture stream for `processId` (used by the Windows tests); returns the steps with their HRESULTs.
    public static string SelfTest(int processId)
    {
        var steps=new List<KeyValuePair<string,string>>();var client=Open(processId,steps);
        try{var iid=typeof(IAudioCaptureClient).GUID;int hr=client.GetService(ref iid,out var capture);steps.Add(new("capture-service",unchecked((uint)hr).ToString("X8")));ComAudio.Release(capture);}
        finally{ComAudio.Release(client);}
        return string.Join(",",steps.Select(s=>s.Key+"="+s.Value));
    }

    /// Applications that can be recorded: processes with a visible main window, one row per program.
    public static IReadOnlyList<Dictionary<string,object?>> Applications()
    {
        var rows=new List<Dictionary<string,object?>>();var seen=new HashSet<string>(StringComparer.OrdinalIgnoreCase);int self=Environment.ProcessId;
        foreach(var process in Process.GetProcesses().OrderBy(p=>p.ProcessName,StringComparer.OrdinalIgnoreCase)){
            using(process){
                try{
                    if(process.Id==self||process.Id==0||process.MainWindowHandle==IntPtr.Zero||string.IsNullOrWhiteSpace(process.MainWindowTitle))continue;
                    string name=process.ProcessName;if(!seen.Add(name))continue;
                    string label=name;try{var description=process.MainModule?.FileVersionInfo.FileDescription;if(!string.IsNullOrWhiteSpace(description))label=description.Trim();}catch(Exception error) when(error is System.ComponentModel.Win32Exception or InvalidOperationException or NotSupportedException){}
                    rows.Add(new(){{"processId",process.Id},{"processName",name},{"name",label.Length>120?label[..120]:label},{"title",process.MainWindowTitle.Length>200?process.MainWindowTitle[..200]:process.MainWindowTitle}});
                    if(rows.Count>=200)break;
                }catch(InvalidOperationException){ }
            }
        }
        return rows;
    }
}
