using System.Text;
using System.Text.Json;
using System.Runtime.InteropServices;
namespace MonoAudio;
internal static class Program
{
    static readonly object outputLock=new();static long sequence;static NativeSession? session;static string root="";
    static readonly HashSet<string> recent=[];static readonly Queue<string> order=[];
    static void Emit(string kind,Dictionary<string,object?> fields)
    {
        lock(outputLock){fields["v"]=1;fields["event"]=kind;fields["seq"]=sequence++;Console.WriteLine(JsonSerializer.Serialize(fields));Console.Out.Flush();}
    }
    static void Devices(bool ready)
    {
        var inventory=CoreAudio.Enumerate();var modes=new List<string>();if(inventory.Inputs.Count>0)modes.Add("mic");if(inventory.Outputs.Count>0)modes.Add("system");if(modes.Count==2)modes.Add("both");
        object Rows(IReadOnlyList<AudioDevice> rows)=>rows.Select(d=>new Dictionary<string,object?>{{"id",d.Id},{"name",d.Name},{"default",d.Default}}).ToArray();
        Emit(ready?"ready":"devices",new(){{"protocol",1},{"platform","windows"},{"supported",modes.Count>0},{"modes",modes},{"inputDevices",Rows(inventory.Inputs)},{"outputDevices",Rows(inventory.Outputs)}});
    }
    static void ValidateRoot(string value)
    {
        root=Path.GetFullPath(value);if(!Directory.Exists(root))throw new AudioFailure("IO_ERROR");
        // Reject redirection (symlink/junction) only. OneDrive and other cloud placeholders are
        // reparse points too, but store data in place; LinkTarget is null for them.
        for(DirectoryInfo? directory=new(root);directory is not null;directory=directory.Parent)if(directory.LinkTarget is not null)throw new AudioFailure("IO_ERROR");
    }
    static string? DeviceId(JsonElement parameters,string key)
    {
        if(!parameters.TryGetProperty(key,out var value)||value.ValueKind==JsonValueKind.Null)return null;
        if(value.ValueKind!=JsonValueKind.String||value.GetString() is not {Length:>0 and <=4096} id)throw new AudioFailure("INTERNAL");return id;
    }
    static void Command(ReadOnlySpan<byte> line)
    {
        using var document=JsonDocument.Parse(line.ToArray());var request=document.RootElement;
        if(request.ValueKind!=JsonValueKind.Object||!request.TryGetProperty("v",out var version)||!version.TryGetInt32(out int v)||v!=1||!request.TryGetProperty("id",out var idElement)||idElement.GetString() is not {Length:>0 and <=100} requestId||!request.TryGetProperty("method",out var methodElement)||methodElement.GetString() is not string method)throw new AudioFailure("INTERNAL");
        if(!recent.Add(requestId))throw new AudioFailure("INTERNAL");order.Enqueue(requestId);if(order.Count>4096)recent.Remove(order.Dequeue());
        var parameters=request.GetProperty("params");if(parameters.ValueKind!=JsonValueKind.Object)throw new AudioFailure("INTERNAL");
        if(method=="enumerate"){Devices(false);return;}
        string? sid=parameters.TryGetProperty("sessionId",out var sidElement)?sidElement.GetString():null;
        if(method=="start"){
            string? mode=parameters.GetProperty("mode").GetString();
            if(sid is null||!Guid.TryParseExact(sid,"D",out var guid)||guid.ToString("D")!=sid||mode is not ("mic" or "system" or "both"))throw new AudioFailure("INTERNAL");
            // A start right after stop races the previous session's drain (up to ~3.5 s): wait for it
            // instead of reporting a busy device that is not busy.
            if(session is not null&&!session.Completed&&!session.WaitCompleted(5000)){Emit("error",new(){{"sessionId",sid},{"code","CAPTURE_BUSY"}});return;}
            session?.Dispose();session=new NativeSession(sid,root,mode,DeviceId(parameters,"inputId"),DeviceId(parameters,"outputId"),Emit);session.Begin();return;
        }
        if(session is null||sid!=session.Id)return;
        switch(method){case "pause":session.Pause();break;case "resume":session.Resume();break;case "stop":session.RequestStop();break;case "commitAck":session.Acknowledge(parameters.GetProperty("track").GetString()??"",parameters.GetProperty("index").GetInt32(),parameters.GetProperty("sha256").GetString()??"");break;default:session.Fail("INTERNAL");break;}
    }
    [MTAThread]
    static int Main(string[] args)
    {
        Console.InputEncoding=new UTF8Encoding(false,true);Console.OutputEncoding=new UTF8Encoding(false);
        try{
            if(args.Length!=4||args[0]!="--protocol"||args[1]!="1"||args[2]!="--capture-root")return 2;
            ValidateRoot(args[3]);Devices(true);
            using var input=Console.OpenStandardInput();var chunk=new byte[4096];using var line=new MemoryStream();bool oversized=false;
            while(true){int read=input.Read(chunk);if(read==0)break;for(int i=0;i<read;i++){
                byte value=chunk[i];if(value==10){
                    if(oversized){session?.Fail("INTERNAL");oversized=false;}else if(line.Length>0){try{Command(line.GetBuffer().AsSpan(0,checked((int)line.Length)));}catch(Exception error) when(error is JsonException or InvalidOperationException or KeyNotFoundException or AudioFailure){session?.Fail(error is AudioFailure failure?failure.Code:"INTERNAL");}}
                    line.SetLength(0);
                }else if(!oversized){if(line.Length>=65535){oversized=true;line.SetLength(0);}else line.WriteByte(value);}
            }}
            session?.Dispose();return 0;
        }catch(Exception error) when(error is AudioFailure or COMException or IOException or UnauthorizedAccessException or PlatformNotSupportedException){Emit("error",new(){{"sessionId",session?.Id},{"code",error is AudioFailure failure?failure.Code:error is PlatformNotSupportedException?"NOT_SUPPORTED":"INTERNAL"}});session?.Dispose();return 1;}
    }
}
