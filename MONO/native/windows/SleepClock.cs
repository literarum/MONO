using System.Runtime.InteropServices;
namespace MonoAudio;
public sealed class SleepClock
{
    readonly ulong boot,awake;
    [DllImport("kernel32.dll")]static extern ulong GetTickCount64();
    [DllImport("kernel32.dll")][return:MarshalAs(UnmanagedType.Bool)]static extern bool QueryUnbiasedInterruptTime(out ulong value);
    public SleepClock(){boot=GetTickCount64();if(!QueryUnbiasedInterruptTime(out awake))throw new InvalidOperationException("INTERNAL");}
    public static long SleptNs(ulong elapsedBootMs,ulong elapsedAwake100Ns)=>Math.Max(0,checked((long)((Int128)elapsedBootMs*1_000_000-(Int128)elapsedAwake100Ns*100)));
    public bool SleepDetected(){if(!QueryUnbiasedInterruptTime(out var current))throw new InvalidOperationException("INTERNAL");return SleptNs(GetTickCount64()-boot,current-awake)>1_000_000_000;}
}
