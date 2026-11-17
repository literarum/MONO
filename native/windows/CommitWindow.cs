namespace MonoAudio;

// Receipt metadata only. The supervisor owns publication and the audio files;
// the helper never deletes a library original when acknowledging a segment.
public sealed class CommitWindow(int maximumPending=16,long maximumBytes=128*1024*1024,long timeoutNs=10_000_000_000)
{
    readonly object gate=new();readonly Dictionary<(string,int),(string Hash,long Bytes,long Stamp)> pending=[];
    readonly Dictionary<(string,int),string> acknowledged=[];readonly Queue<(string,int)> order=[];
    long bytes;
    public int PendingCount{get{lock(gate)return pending.Count;}}
    static void Validate(string track,int index,string hash){if(track is not ("mic" or "system")||index is <0 or >999999||hash.Length!=64||hash.Any(c=>c is not (>= '0' and <= '9') and not (>= 'a' and <= 'f')))throw new InvalidOperationException("INVALID_RECEIPT");}
    public void Register(string track,int index,string hash,long size,long stamp)
    {
        Validate(track,index,hash);
        lock(gate){
            if(size<1||stamp<0||pending.Count>=maximumPending||size>maximumBytes-bytes||pending.ContainsKey((track,index))||acknowledged.ContainsKey((track,index)))throw new InvalidOperationException("COMMIT_BACKPRESSURE");
            pending.Add((track,index),(hash,size,stamp));bytes+=size;
        }
    }
    public void Acknowledge(string track,int index,string hash)
    {
        Validate(track,index,hash);
        lock(gate){
            if(acknowledged.TryGetValue((track,index),out var previous)){if(previous!=hash)throw new InvalidOperationException("INVALID_RECEIPT");return;}
            if(!pending.TryGetValue((track,index),out var item)||item.Hash!=hash)throw new InvalidOperationException("INVALID_RECEIPT");
            pending.Remove((track,index));bytes-=item.Bytes;acknowledged.Add((track,index),hash);order.Enqueue((track,index));
            if(order.Count>128)acknowledged.Remove(order.Dequeue());
        }
    }
    public bool Expired(long now){lock(gate)return pending.Values.Any(item=>now>=item.Stamp&&now-item.Stamp>=timeoutNs);}
}
