using System.Diagnostics;
using System.Runtime.InteropServices;
namespace MonoAudio;

internal sealed class NativeSession : IDisposable
{
    readonly Action<string,Dictionary<string,object?>> emit;readonly CancellationTokenSource cancellation=new();readonly List<CaptureTrack> tracks=[];readonly object stateLock=new();
    readonly SleepClock sleep=new();readonly CommitWindow receipts=new();Task? coordinator;Timer? heartbeat;string state="requesting";string? failure,diagnosticStage,nativeCode;long stopNs;bool disposed;
    public string Id{get;}public string Root{get;}public CancellationToken Cancellation=>cancellation.Token;
    public readonly ManualResetEventSlim StartGate=new(false),PublishGate=new(false),ResumeGate=new(false);
    public bool PauseRequested{get;private set;}public long PauseNs{get;private set;}public long ResumeNs{get;private set;}public long OriginNs{get;private set;}
    public bool RecordingPublished{get;private set;}public long StopNs=>Interlocked.Read(ref stopNs) is var value&&value>0?value:NowNs;
    public static long NowNs=>ClockMath.QpcToNs(Stopwatch.GetTimestamp(),Stopwatch.Frequency);
    public bool Completed=>coordinator?.IsCompleted??false;
    public NativeSession(string id,string root,string mode,string? inputId,string? outputId,Action<string,Dictionary<string,object?>> emit)
    {
        Id=id;Root=root;this.emit=emit;
        if(mode is "mic" or "both")tracks.Add(new CaptureTrack(this,false,inputId));
        if(mode is "system" or "both")tracks.Add(new CaptureTrack(this,true,outputId));
        if(tracks.Count==0)throw new AudioFailure("NOT_SUPPORTED");
    }
    void State(string value,long stamp)=>emit("state",new(){{"sessionId",Id},{"state",value},{"monotonicNs",stamp},{"originMonotonicNs",OriginNs},{"inputId",tracks.FirstOrDefault(t=>t.Track=="mic")?.Id},{"outputId",tracks.FirstOrDefault(t=>t.Track=="system")?.Id}});
    public void Begin()
    {
        State("requesting",NowNs);heartbeat=new Timer(_=>{if(!Completed)foreach(var track in tracks)emit("level",new(){{"sessionId",Id},{"track",track.Track},{"peak",track.Peak},{"rms",track.Rms},{"clippedFrames",track.ClippedFrames},{"monotonicNs",NowNs}});},null,0,250);
        coordinator=Task.Run(Run);
    }
    async Task WaitFor(Func<bool> condition,int timeoutMs)
    {
        long deadline=Environment.TickCount64+timeoutMs;
        while(!condition()){Cancellation.ThrowIfCancellationRequested();if(Environment.TickCount64>deadline)throw new AudioFailure("START_TIMEOUT");await Task.Delay(5,Cancellation);}
        Cancellation.ThrowIfCancellationRequested();
    }
    async Task Run()
    {
        DeviceMonitor? monitor=null;
        try{
            tracks.ForEach(t=>t.Begin());await WaitFor(()=>tracks.All(t=>t.Initialized.IsSet),10000);
            monitor=new DeviceMonitor(tracks,Fail);OriginNs=NowNs;StartGate.Set();await WaitFor(()=>tracks.All(t=>t.Started.IsSet),5000);
            lock(stateLock){if(Cancellation.IsCancellationRequested)return;state="recording";RecordingPublished=true;State("recording",OriginNs);PublishGate.Set();}
            while(!Cancellation.IsCancellationRequested){CheckSleep();if(receipts.Expired(NowNs))throw new AudioFailure("IO_ERROR");await Task.Delay(50,Cancellation);}
        }catch(OperationCanceledException){ }
        catch(AudioFailure error){Fail(error.Code,"coordinator",error.NativeCode);}
        finally{
            RequestStop();StartGate.Set();ResumeGate.Set();PublishGate.Set();
            long deadline=Environment.TickCount64+2500;
            while(tracks.Any(t=>!t.ProducerDone.IsSet||!t.WriterDone.IsSet)&&Environment.TickCount64<deadline)await Task.Delay(10);
            if(tracks.Any(t=>!t.ProducerDone.IsSet||!t.WriterDone.IsSet))failure??="IO_ERROR";
            if(failure is null){long ackDeadline=Environment.TickCount64+1000;while(receipts.PendingCount>0&&Environment.TickCount64<ackDeadline)await Task.Delay(10);if(receipts.PendingCount>0)failure="IO_ERROR";}
            monitor?.Dispose();heartbeat?.Dispose();
            if(failure is not null)emit("error",new(){{"sessionId",Id},{"code",failure},{"stage",diagnosticStage},{"nativeCode",nativeCode}});else State("idle",StopNs);
            lock(stateLock)state="closed";
            if(tracks.Any(t=>!t.ProducerDone.IsSet||!t.WriterDone.IsSet))Environment.Exit(1);
        }
    }
    public bool WaitCompleted(int timeoutMs){try{return coordinator?.Wait(timeoutMs)??true;}catch(AggregateException){return true;}}
    public void RequestStop(){if(disposed)return;Interlocked.CompareExchange(ref stopNs,NowNs,0);cancellation.Cancel();ResumeGate.Set();StartGate.Set();PublishGate.Set();}
    public void Fail(string code){if(disposed)return;Interlocked.CompareExchange(ref failure,code,null);RequestStop();}
    public void Fail(string code,string stage,int? hresult){lock(stateLock){if(failure is null){diagnosticStage=stage;nativeCode=hresult?.ToString("X8");}}Fail(code);}
    public void Pause()
    {
        lock(stateLock){if(state!="recording")return;state="pausing";PauseNs=NowNs;PauseRequested=true;ResumeGate.Reset();tracks.ForEach(t=>t.PauseCompleted.Reset());}
        _=Task.Run(async()=>{try{await WaitFor(()=>tracks.All(t=>t.PauseCompleted.IsSet),2000);lock(stateLock){if(Cancellation.IsCancellationRequested)return;state="paused";State("paused",PauseNs);}}catch(OperationCanceledException){}catch(AudioFailure e){Fail(e.Code);}});
    }
    public void Resume()
    {
        lock(stateLock){if(state!="paused")return;state="resuming";ResumeNs=NowNs;PublishGate.Reset();tracks.ForEach(t=>t.ResumeCompleted.Reset());PauseRequested=false;ResumeGate.Set();}
        _=Task.Run(async()=>{try{await WaitFor(()=>tracks.All(t=>t.ResumeCompleted.IsSet),2000);lock(stateLock){if(Cancellation.IsCancellationRequested)return;state="recording";State("recording",ResumeNs);PublishGate.Set();}}catch(OperationCanceledException){}catch(AudioFailure e){Fail(e.Code);}});
    }
    public void Acknowledge(string track,int index,string hash){try{receipts.Acknowledge(track,index,hash);}catch(InvalidOperationException){Fail("INTERNAL");}}
    public void EmitSegment(SegmentInfo segment)
    {
        try{receipts.Register(segment.Track,segment.Index,segment.Sha256,new FileInfo(segment.Path).Length,NowNs);}
        catch(InvalidOperationException){throw new AudioFailure("IO_ERROR");}
        emit("segment",new(){{"sessionId",Id},{"track",segment.Track},{"index",segment.Index},{"relativeFile",Path.GetFileName(segment.Path)},{"format",segment.Format.Encoding},{"sampleRate",segment.Format.Rate},{"channels",segment.Format.Channels},{"startMonotonicNs",segment.StartNs},{"endMonotonicNs",segment.EndNs},{"frames",segment.Frames},{"sha256",segment.Sha256}});
    }
    public void CheckSleep()
    {
        if(sleep.SleepDetected())Fail("SLEEP");
    }
    public void Dispose()
    {
        if(disposed)return;RequestStop();if(coordinator is not null&&!coordinator.Wait(3500))return;disposed=true;
        foreach(var track in tracks)track.Dispose();heartbeat?.Dispose();cancellation.Dispose();StartGate.Dispose();PublishGate.Dispose();ResumeGate.Dispose();
    }
}

[ComVisible(true),ClassInterface(ClassInterfaceType.None)] internal sealed class DeviceMonitor : IDeviceNotifications,IDisposable
{
    readonly IReadOnlyList<CaptureTrack> tracks;readonly Action<string> fail;readonly IDeviceEnumerator enumerator;
    public DeviceMonitor(IReadOnlyList<CaptureTrack> tracks,Action<string> fail){this.tracks=tracks;this.fail=fail;enumerator=(IDeviceEnumerator)new DeviceEnumeratorCom();ComAudio.Check(enumerator.RegisterEndpointNotificationCallback(this));}
    public int OnDeviceStateChanged(string id,uint state){if(state!=1&&tracks.Any(t=>t.Id==id))fail("DEVICE_LOST");return 0;}
    public int OnDeviceAdded(string id)=>0;
    public int OnDeviceRemoved(string id){if(tracks.Any(t=>t.Id==id))fail("DEVICE_LOST");return 0;}
    public int OnDefaultDeviceChanged(DataFlow flow,DeviceRole role,string? id){if(role==DeviceRole.Console&&tracks.Any(t=>t.UsesDefault&&t.Track==(flow==DataFlow.Render?"system":"mic")&&t.Id!=id))fail("DEVICE_LOST");return 0;}
    public int OnPropertyValueChanged(string id,PropertyKey key){if(key.Format==new Guid("F19F064D-082C-4E27-BC73-6882A1BB8E4C")&&key.Id==0&&tracks.Any(t=>t.Id==id))fail("DISCONTINUITY");return 0;}
    public void Dispose(){enumerator.UnregisterEndpointNotificationCallback(this);ComAudio.Release(enumerator);}
}
