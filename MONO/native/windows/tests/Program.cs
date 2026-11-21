using System.Buffers.Binary;
using MonoAudio;
using System.Text.Json;

bool keep=args.Length==2&&args[0]=="--artifacts";
var artifactParent=Path.GetFullPath(keep?args[1]:Path.GetTempPath());
var root=Path.GetFullPath(Path.Combine(artifactParent,"mono-native-tests-"+Guid.NewGuid().ToString("N")));
if(args.Contains("--probe")){Console.WriteLine(JsonSerializer.Serialize(CoreAudio.ProbeLoopbackInitialization()));return;}
Directory.CreateDirectory(root);int count=0;
void Check(bool result,string label){if(!result)throw new Exception(label);count++;}
try{
    Check(ClockMath.FramesToNs(16000,16000)==1_000_000_000,"one second PCM");
    Check(ClockMath.NsToFrames(999_999_999,48000)==47999,"fractional frame floors rather than extending time");
    Check(ClockMath.NsToFrames(14_400_000_000_000,44100)==635_040_000,"four hours without 32-bit overflow");
    Check(ClockMath.FramesToNs(635_040_000,44100)==14_400_000_000_000,"four-hour exact round trip");
    Check(SleepClock.SleptNs(5000,10_000_000)==4_000_000_000,"sleep detector compares boot time to awake time");
    Check(SleepClock.SleptNs(1000,10_000_000)==0,"normal elapsed time is not sleep");
    var receipts=new CommitWindow(maximumPending:2,maximumBytes:100,timeoutNs:1000);
    var hashA=new string('a',64);var hashB=new string('b',64);
    void Reject(Action action,string label){try{action();}catch(InvalidOperationException){Check(true,label);return;}throw new Exception(label);}
    receipts.Register("mic",0,hashA,40,100);receipts.Register("system",0,hashB,60,200);
    Reject(()=>receipts.Register("mic",1,hashA,1,300),"unacknowledged files are bounded before another publication");
    Reject(()=>receipts.Acknowledge("mic",0,hashB),"wrong-hash ACK cannot release durable source receipt");
    Check(receipts.PendingCount==2,"bad ACK preserves pending metadata");
    receipts.Acknowledge("mic",0,hashA);receipts.Acknowledge("mic",0,hashA);
    Check(receipts.PendingCount==1,"ACK replay is idempotent");
    receipts.Register("mic",1,hashA,40,300);
    Check(!receipts.Expired(1199)&&receipts.Expired(1200),"oldest unacknowledged segment has a monotonic deadline");
    Reject(()=>receipts.Acknowledge("mic",99,hashA),"future ACK cannot acknowledge unregistered bytes");
    receipts.Acknowledge("system",0,hashB);receipts.Acknowledge("mic",1,hashA);
    Check(receipts.PendingCount==0&&!receipts.Expired(99999),"fully acknowledged session can stop cleanly");
    var format=AudioFormat.Pcm(16000,1,16);var emitted=new List<SegmentInfo>();var all=new List<SegmentInfo>();void Emit(SegmentInfo s){emitted.Add(s);all.Add(s);}var bytes=new byte[34000*2];
    for(int i=0;i<bytes.Length;i++)bytes[i]=(byte)(i*17);
    using(var assembler=new SegmentAssembler(Path.Combine(root,"split"),"mic",format,1_000_000_000,Emit)){
        assembler.AppendPacket(bytes,1_000_000_000);assembler.Complete();
    }
    Check(emitted.Count==2,"packet crosses exactly two segments");
    Check(emitted[0].Frames==32000&&emitted[1].Frames==2000,"independent expected segment frame counts");
    Check(emitted[0].StartNs==1_000_000_000&&emitted[1].StartNs==3_000_000_000,"native packet offsets preserved");
    var joined=new List<byte>();
    foreach(var segment in emitted){var file=File.ReadAllBytes(segment.Path);Check(file.AsSpan(0,4).SequenceEqual("RIFF"u8),"RIFF header");Check(BinaryPrimitives.ReadUInt32LittleEndian(file.AsSpan(4,4))==file.Length-8,"RIFF length");Check(BinaryPrimitives.ReadUInt32LittleEndian(file.AsSpan(40,4))==segment.Frames*2,"data length matches frames");joined.AddRange(file.Skip(44));}
    Check(joined.SequenceEqual(bytes),"all source bytes survive segmentation in order");
    emitted.Clear();
    using(var assembler=new SegmentAssembler(Path.Combine(root,"silence"),"system",format,0,Emit)){
        assembler.PadTo(5_000_000_000);assembler.Complete();
    }
    Check(emitted.Select(s=>s.Frames).SequenceEqual(new long[]{32000,32000,16000}),"idle loopback advances five-second timeline");
    Check(emitted.All(s=>File.ReadAllBytes(s.Path).Skip(44).All(b=>b==0)),"PCM16 silence contains zero samples");
    emitted.Clear();
    using(var assembler=new SegmentAssembler(Path.Combine(root,"pause"),"mic",format,0,Emit)){
        assembler.AppendPacket(new byte[16000*2],0);assembler.Pause();assembler.ResumeAt(3_000_000_000);assembler.AppendPacket(new byte[16000*2],3_000_000_000);assembler.Complete();
    }
    Check(emitted.Count==2&&emitted[0].Frames==16000&&emitted[1].Frames==16000,"pause flushes partial segments");
    Check(emitted[1].StartNs==3_000_000_000,"explicit pause stays a clock gap");
    emitted.Clear();
    using(var assembler=new SegmentAssembler(Path.Combine(root,"unsigned"),"system",AudioFormat.Pcm(8000,1,8),0,Emit)){assembler.PadTo(100_000_000);assembler.Complete();}
    Check(File.ReadAllBytes(emitted.Single().Path).Skip(44).All(b=>b==128),"unsigned PCM8 silence is centered at128");
    emitted.Clear();
    using(var assembler=new SegmentAssembler(Path.Combine(root,"fractional"),"system",AudioFormat.Pcm(44100,1,16),0,Emit)){for(int i=1;i<=1000;i++)assembler.PadTo(i*1_000_000L);assembler.Complete();}
    Check(emitted.Sum(s=>s.Frames)==44100,"fractional samples never accumulate truncation on frequent silence ticks");
    emitted.Clear();
    using(var assembler=new SegmentAssembler(Path.Combine(root,"drift"),"mic",AudioFormat.Pcm(44100,1,16),0,Emit)){for(int i=0;i<1000;i++)assembler.AppendPacket(new byte[441*2],i*10_001_000L);assembler.Complete();}
    Check(emitted.Sum(s=>s.Frames)==441000,"native source frames survive100ppm clock drift without sample removal");
    Check(emitted[1].StartNs==2_000_200_000,"second segment retains measured source clock rather than nominal accumulated position");
    Check(Math.Abs(emitted[^1].EndNs-10_001_000_000)<ClockMath.FramesToNs(1,44100),"last packet clock approximation stays within one source frame");
    DeviceInventory? devices=null;if(args.Contains("--devices")){devices=CoreAudio.Enumerate();Check(devices.Inputs.All(d=>!string.IsNullOrWhiteSpace(d.Id)&&!string.IsNullOrWhiteSpace(d.Name)),"real input endpoint identities");Check(devices.Outputs.All(d=>!string.IsNullOrWhiteSpace(d.Id)&&!string.IsNullOrWhiteSpace(d.Name)),"real output endpoint identities");}
    var report=new {result="PASS",checks=count,physicalAudio=false,nativeEnumeration=devices is not null,inputDeviceCount=devices?.Inputs.Count,outputDeviceCount=devices?.Outputs.Count,artifactDirectory=keep?root:null,segments=all.Select(s=>new {file=Path.GetRelativePath(root,s.Path),frames=s.Frames,startNs=s.StartNs,endNs=s.EndNs,rate=s.Format.Rate,channels=s.Format.Channels,bits=s.Format.Bits,sha256=s.Sha256})};
    if(keep)File.WriteAllText(Path.Combine(root,"report.json"),JsonSerializer.Serialize(report));
    Console.WriteLine(JsonSerializer.Serialize(report));
}finally{
    var parent=artifactParent.TrimEnd(Path.DirectorySeparatorChar)+Path.DirectorySeparatorChar;
    if(!root.StartsWith(parent,StringComparison.OrdinalIgnoreCase)||!Path.GetFileName(root).StartsWith("mono-native-tests-",StringComparison.Ordinal))throw new Exception("Refuse cleanup outside owned native test directory");
    if(!keep)Directory.Delete(root,true);
}
