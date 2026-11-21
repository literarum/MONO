namespace MonoAudio;
public static class ClockMath
{
    public static long FramesToNs(long frames,int rate)
    {
        if(frames<0||rate<=0)throw new ArgumentOutOfRangeException(nameof(frames));
        return checked((long)((Int128)frames*1_000_000_000/rate));
    }
    public static long NsToFrames(long nanoseconds,int rate)
    {
        if(nanoseconds<0||rate<=0)throw new ArgumentOutOfRangeException(nameof(nanoseconds));
        return checked((long)((Int128)nanoseconds*rate/1_000_000_000));
    }
    public static long QpcToNs(long ticks,long frequency)
    {
        if(ticks<0||frequency<=0)throw new ArgumentOutOfRangeException(nameof(ticks));
        return checked((long)((Int128)ticks*1_000_000_000/frequency));
    }
}
