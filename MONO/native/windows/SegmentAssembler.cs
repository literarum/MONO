using System.Security.Cryptography;
using System.Text;
namespace MonoAudio;
public sealed record SegmentInfo(string Path,int Index,string Track,long StartNs,long EndNs,long Frames,AudioFormat Format,string Sha256);

sealed class WaveFile : IDisposable
{
    readonly FileStream stream;readonly BinaryWriter writer;readonly AudioFormat format;readonly string path;readonly long dataSizeOffset;readonly long dataStart;readonly long? factOffset;
    bool sealedFile;public long Frames{get;private set;}public long StartNs{get;}public long EndNs{get;private set;}
    public WaveFile(string path,AudioFormat format,long startNs)
    {
        this.path=path;this.format=format;StartNs=startNs;EndNs=startNs;
        stream=new FileStream(path,FileMode.CreateNew,FileAccess.ReadWrite,FileShare.Read,65536,FileOptions.SequentialScan);writer=new BinaryWriter(stream,Encoding.UTF8,true);
        writer.Write("RIFF"u8);writer.Write(0u);writer.Write("WAVEfmt "u8);writer.Write((uint)format.WaveBytes.Length);writer.Write(format.WaveBytes);if((format.WaveBytes.Length&1)!=0)writer.Write((byte)0);
        if(format.Tag!=1){writer.Write("fact"u8);writer.Write(4u);factOffset=stream.Position;writer.Write(0u);}
        writer.Write("data"u8);dataSizeOffset=stream.Position;writer.Write(0u);dataStart=stream.Position;
    }
    public void Write(ReadOnlySpan<byte> data,long startNs)
    {
        if(sealedFile||data.Length%format.Alignment!=0)throw new InvalidOperationException("INVALID_AUDIO");
        stream.Write(data);Frames+=data.Length/format.Alignment;EndNs=startNs+ClockMath.FramesToNs(data.Length/format.Alignment,format.Rate);
    }
    public SegmentInfo Seal(int index,string track)
    {
        long length=checked(Frames*format.Alignment);
        if(sealedFile||Frames<1||stream.Length!=dataStart+length)throw new InvalidOperationException("INVALID_AUDIO");
        if((length&1)!=0){stream.Position=stream.Length;writer.Write((byte)0);}
        long end=stream.Length;stream.Position=4;writer.Write(checked((uint)(end-8)));stream.Position=dataSizeOffset;writer.Write(checked((uint)length));
        if(factOffset is not null){stream.Position=factOffset.Value;writer.Write(checked((uint)Frames));}
        writer.Flush();stream.Flush(true);writer.Dispose();stream.Dispose();sealedFile=true;
        using var source=File.OpenRead(path);string hash=Convert.ToHexString(SHA256.HashData(source)).ToLowerInvariant();return new SegmentInfo(path,index,track,StartNs,EndNs,Frames,format,hash);
    }
    public void Dispose(){if(!sealedFile){writer.Dispose();stream.Dispose();}}
}

public sealed class SegmentAssembler : IDisposable
{
    readonly string root,track;readonly AudioFormat format;readonly Action<SegmentInfo> emit;readonly long framesPerSegment;
    WaveFile? current;int index;long frames,anchorFrames,anchorNs;bool completed;
    public long CursorNs=>anchorNs+ClockMath.FramesToNs(frames-anchorFrames,format.Rate);
    public SegmentAssembler(string root,string track,AudioFormat format,long originNs,Action<SegmentInfo> emit)
    {
        if(track is not ("mic" or "system")||originNs<0)throw new ArgumentException("INVALID_TRACK");
        this.root=Path.GetFullPath(root);this.track=track;this.format=format;this.emit=emit;anchorNs=originNs;framesPerSegment=checked(format.Rate*2L);Directory.CreateDirectory(this.root);
    }
    void Write(ReadOnlySpan<byte> data,long firstNs)
    {
        long consumed=0;
        while(!data.IsEmpty){
            long start=firstNs+ClockMath.FramesToNs(consumed,format.Rate);
            current??=new WaveFile(Path.Combine(root,$"{track}-{index:D6}.wav"),format,start);
            int count=checked((int)Math.Min(data.Length/format.Alignment,framesPerSegment-current.Frames));int bytes=checked(count*format.Alignment);
            current.Write(data[..bytes],start);data=data[bytes..];consumed+=count;frames+=count;
            if(current.Frames==framesPerSegment)Flush();
        }
    }
    public void AppendPacket(ReadOnlySpan<byte> data,long firstNs)
    {
        if(completed||data.Length%format.Alignment!=0||firstNs<0)throw new InvalidOperationException("INVALID_AUDIO");
        if(data.IsEmpty)return;
        long delta=firstNs-CursorNs;
        if(delta < -2_000_000){
            // A packet reported after a discontinuity can overlap audio already placed
            // on the timeline (e.g. loopback silence padding). Drop only the overlap.
            long overlap=ClockMath.NsToFrames(-delta,format.Rate);
            if(overlap*format.Alignment>=data.Length)return;
            data=data[checked((int)(overlap*format.Alignment))..];firstNs+=ClockMath.FramesToNs(overlap,format.Rate);delta=firstNs-CursorNs;
        }
        if(delta>2_000_000)PadTo(firstNs);
        anchorNs=firstNs;anchorFrames=frames;Write(data,firstNs);
    }
    public void PadTo(long endNs)
    {
        if(completed)throw new InvalidOperationException("INVALID_AUDIO");
        if(endNs<=anchorNs)return;
        long target=anchorFrames+ClockMath.NsToFrames(endNs-anchorNs,format.Rate),remaining=target-frames;
        if(remaining<=0)return;
        var silence=new byte[checked(format.Alignment*4096)];if(format.Silence!=0)Array.Fill(silence,format.Silence);
        while(remaining>0){int count=(int)Math.Min(4096,remaining);Write(silence.AsSpan(0,count*format.Alignment),CursorNs);remaining-=count;}
    }
    void Flush()
    {
        if(current is null)return;
        var sealedSegment=current.Seal(index++,track);current.Dispose();current=null;emit(sealedSegment);
    }
    public void Pause(){if(completed)throw new InvalidOperationException("INVALID_AUDIO");Flush();}
    public void ResumeAt(long firstNs){if(completed||current is not null||firstNs<CursorNs)throw new InvalidOperationException("INVALID_AUDIO");anchorNs=firstNs;anchorFrames=frames;}
    public void Complete(){if(completed)return;Flush();completed=true;}
    public void Dispose(){try{Complete();}finally{current?.Dispose();}}
}
