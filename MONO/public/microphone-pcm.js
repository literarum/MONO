/** Mono PCM timeline shared by the real AudioWorklet and its sample oracle. */
export class PcmCapture{
 constructor(rate,onChunk,onEnd){
  if(!Number.isInteger(rate)||rate<8000||rate>192000)throw new RangeError('Invalid microphone sample rate');
  this.rate=rate;this.onChunk=onChunk;this.onEnd=onEnd;this.capacity=rate*2;this.buffer=new Int16Array(this.capacity);this.used=0;this.frames=0;this.index=0;this.paused=false;this.stopped=false;
 }
 setPaused(value){if(this.stopped)throw new Error('Microphone is stopped');this.paused=Boolean(value);return this.frames}
 append(channels){
  if(this.stopped||!channels.length)return;
  const count=channels[0].length;if(channels.some(channel=>!(channel instanceof Float32Array)||channel.length!==count))throw new TypeError('Invalid microphone samples');let peak=0,squares=0,clips=0;
  for(let i=0;i<count;i++){
   let value=0;
   if(!this.paused){for(const channel of channels){if(!Number.isFinite(channel[i]))throw new TypeError('Invalid microphone sample');value+=channel[i]}value=Math.max(-1,Math.min(1,value/channels.length))}
   peak=Math.max(peak,Math.abs(value));squares+=value*value;if(Math.abs(value)>=1)clips++;
   this.buffer[this.used++]=Math.round(value*(value<0?32768:32767));this.frames++;
   if(this.used===this.capacity)this.flush();
  }
  return {peak,rms:count?Math.sqrt(squares/count):0,clippedFrames:clips,frames:count};
 }
 flush(){if(!this.used)return;const pcm=this.used===this.capacity?this.buffer.buffer:this.buffer.slice(0,this.used).buffer;this.onChunk({index:this.index++,frames:this.used,pcm});this.buffer=new Int16Array(this.capacity);this.used=0}
 stop(){if(this.stopped)return;this.stopped=true;this.flush();this.onEnd(this.frames)}
}
export function pcmWave(pcm,rate){
 if(!(pcm instanceof ArrayBuffer)||pcm.byteLength%2||pcm.byteLength<2||pcm.byteLength>rate*4||!Number.isInteger(rate)||rate<8000||rate>192000)throw new RangeError('Invalid PCM block');
 const bytes=new Uint8Array(44+pcm.byteLength),view=new DataView(bytes.buffer),text=(at,value)=>{for(let i=0;i<value.length;i++)bytes[at+i]=value.charCodeAt(i)};
 text(0,'RIFF');view.setUint32(4,bytes.length-8,true);text(8,'WAVE');text(12,'fmt ');view.setUint32(16,16,true);view.setUint16(20,1,true);view.setUint16(22,1,true);view.setUint32(24,rate,true);view.setUint32(28,rate*2,true);view.setUint16(32,2,true);view.setUint16(34,16,true);text(36,'data');view.setUint32(40,pcm.byteLength,true);
 const samples=new Int16Array(pcm);for(let i=0;i<samples.length;i++)view.setInt16(44+i*2,samples[i],true);return bytes;
}
