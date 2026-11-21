using System.Buffers.Binary;
namespace MonoAudio;
public sealed class AudioFormat
{
    public byte[] WaveBytes {get;}
    public int Rate {get;}
    public int Channels {get;}
    public int Bits {get;}
    public int Alignment {get;}
    public int Tag {get;}
    public byte Silence => Tag==1&&Bits==8?(byte)128:(byte)0;
    public string Encoding => Tag==3?$"pcm_f{Bits}le":Bits==8?"pcm_u8":$"pcm_s{Bits}le";
    public AudioFormat(byte[] format)
    {
        if(format.Length<16||format.Length>4096)throw new ArgumentException("UNSUPPORTED_FORMAT");
        WaveBytes=(byte[])format.Clone();Tag=BinaryPrimitives.ReadUInt16LittleEndian(format);
        Channels=BinaryPrimitives.ReadUInt16LittleEndian(format.AsSpan(2));Rate=checked((int)BinaryPrimitives.ReadUInt32LittleEndian(format.AsSpan(4)));
        Alignment=BinaryPrimitives.ReadUInt16LittleEndian(format.AsSpan(12));Bits=BinaryPrimitives.ReadUInt16LittleEndian(format.AsSpan(14));
        if(Tag==65534){
            if(format.Length<40||BinaryPrimitives.ReadUInt16LittleEndian(format.AsSpan(16))<22||!format.AsSpan(28,12).SequenceEqual(Convert.FromHexString("00001000800000AA00389B71")))throw new ArgumentException("UNSUPPORTED_FORMAT");
            Tag=checked((int)BinaryPrimitives.ReadUInt32LittleEndian(format.AsSpan(24)));
        }
        if(Tag is not (1 or 3)||Channels is <1 or >64||Rate is <8000 or >384000||Bits is not (8 or 16 or 24 or 32 or 64)||Alignment!=Channels*(Bits/8)||BinaryPrimitives.ReadUInt32LittleEndian(format.AsSpan(8))!=Rate*Alignment||Tag==3&&Bits is not (32 or 64)||Tag==1&&Bits==64)throw new ArgumentException("UNSUPPORTED_FORMAT");
        if(checked((long)Rate*2*Alignment)>32*1024*1024)throw new ArgumentException("UNSUPPORTED_FORMAT");
    }
    public static AudioFormat Pcm(int rate,int channels,int bits)
    {
        var bytes=new byte[16];BinaryPrimitives.WriteUInt16LittleEndian(bytes,1);BinaryPrimitives.WriteUInt16LittleEndian(bytes.AsSpan(2),checked((ushort)channels));BinaryPrimitives.WriteUInt32LittleEndian(bytes.AsSpan(4),checked((uint)rate));
        int align=checked(channels*(bits/8));BinaryPrimitives.WriteUInt32LittleEndian(bytes.AsSpan(8),checked((uint)(rate*align)));BinaryPrimitives.WriteUInt16LittleEndian(bytes.AsSpan(12),checked((ushort)align));BinaryPrimitives.WriteUInt16LittleEndian(bytes.AsSpan(14),checked((ushort)bits));return new AudioFormat(bytes);
    }
}
