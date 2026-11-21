// Defect detector: runs inside the analysis stream, one mono sample at a time, in constant memory.
//
// What it measures, and why only these: recent studies find that broadband speech enhancement before
// Whisper usually raises its word error rate (arXiv 2512.17562, 2603.04710), so MONO repairs only
// defects it has measured and that a filter removes without touching the voice:
//   • DC offset — a constant shift of the waveform (removed by a high-pass at 20 Hz);
//   • mains hum — a narrow 50 Hz or 60 Hz tone and its harmonics (removed by narrow notches);
//   • noise floor and signal-to-noise ratio — from the distribution of 20 ms window levels;
//   • the share of the record where someone speaks (windows well above the noise floor).
// Hum is judged on the quietest seconds: there the hum, if any, is not masked by speech.
const HUM_FAMILIES=Object.freeze({50:[50,100,150],60:[60,120,180]});
// hum lives below 200 Hz: samples are averaged down to about 6 kHz before the tone detectors

class Goertzel{
 constructor(frequency,rate){this.coefficient=2*Math.cos(2*Math.PI*frequency/rate);this.reset()}
 reset(){this.a=0;this.b=0}
 push(x){const s=x+this.coefficient*this.a-this.b;this.b=this.a;this.a=s}
 power(){return this.a*this.a+this.b*this.b-this.coefficient*this.a*this.b}
}

export class DefectMeter{
 constructor(sampleRate){
  this.rate=sampleRate;this.step=Math.max(1,Math.round(sampleRate/6000));this.decimatedRate=sampleRate/this.step;
  this.blockLength=Math.round(this.decimatedRate); // one-second blocks
  this.sum=0;this.count=0;this.acc=0;this.accCount=0;this.inBlock=0;this.blockEnergy=0;this.blocks=[];
  this.bands=[];for(const [family,harmonics] of Object.entries(HUM_FAMILIES))for(const f of harmonics)this.bands.push({family:Number(family),f,tone:new Goertzel(f,this.decimatedRate),low:new Goertzel(f*.9,this.decimatedRate),high:new Goertzel(f*1.1,this.decimatedRate)});
  this.windowLength=Math.max(1,Math.round(sampleRate*.02));this.windowEnergy=0;this.windowCount=0;this.levels=new Uint32Array(121); // 20 ms window levels, −120…0 dBFS
 }
 push(mono){
  this.sum+=mono;this.count++;
  this.windowEnergy+=mono*mono;if(++this.windowCount===this.windowLength){const level=this.windowEnergy/this.windowLength;const dbfs=level>0?Math.max(-120,Math.min(0,10*Math.log10(level))):-120;this.levels[Math.round(-dbfs)]++;this.windowEnergy=0;this.windowCount=0}
  this.acc+=mono;if(++this.accCount<this.step)return;
  const x=this.acc/this.accCount;this.acc=0;this.accCount=0;this.blockEnergy+=x*x;
  for(const band of this.bands){band.tone.push(x);band.low.push(x);band.high.push(x)}
  if(++this.inBlock===this.blockLength)this.closeBlock();
 }
 closeBlock(){
  const ratios={};for(const band of this.bands){const reference=(band.low.power()+band.high.power())/2;ratios[band.f]=10*Math.log10((band.tone.power()+1e-20)/(reference+1e-20));band.tone.reset();band.low.reset();band.high.reset()}
  if(this.blocks.length<4*3600)this.blocks.push({energy:this.blockEnergy/this.inBlock,ratios});
  this.inBlock=0;this.blockEnergy=0;
 }
 /** Level (dBFS) below which the share p of the 20 ms windows lie; digital silence (< −100 dBFS) is left out. */
 percentile(p){let total=0;for(let i=0;i<=100;i++)total+=this.levels[i];if(!total)return null;let seen=0;for(let i=100;i>=0;i--){seen+=this.levels[i];if(seen/total>=p)return -i}return 0}
 result(){
  if(this.inBlock>this.blockLength/2)this.closeBlock();
  const dc=this.count?this.sum/this.count:0;
  // hum: median over the quietest 30 % of seconds, per family; the fundamental and one harmonic must stand out
  let hum=null;
  if(this.blocks.length>=3){
   const quiet=[...this.blocks].sort((a,b)=>a.energy-b.energy).slice(0,Math.max(3,Math.ceil(this.blocks.length*.3)));
   const median=values=>{const sorted=[...values].sort((a,b)=>a-b);return sorted[Math.floor(sorted.length/2)]};
   for(const [family,harmonics] of Object.entries(HUM_FAMILIES)){
    const strengths=harmonics.map(f=>median(quiet.map(block=>block.ratios[f])));
    const standing=strengths.filter(value=>value>=10).length;
    if(strengths[0]>=10&&standing>=2&&(!hum||strengths[0]>hum.strengthDb))hum={hz:Number(family),strengthDb:Math.round(strengths[0]*10)/10,harmonics:harmonics.filter((_,i)=>strengths[i]>=8).join(',')};
   }
  }
  const floor=this.percentile(.1),speech=this.percentile(.9);// the quietest tenth is the room; the loudest tenth is the voice
  const snr=floor!==null&&speech!==null?speech-floor:null;
  let voiced=0,total=0;if(floor!==null)for(let i=0;i<=100;i++){total+=this.levels[i];if(-i>floor+10)voiced+=this.levels[i]}
  return {schema:1,dcOffset:Math.round(dc*1e5)/1e5,hum,noise:{floorDbFS:floor,speechDbFS:speech,snrDb:snr,heuristic:true},speechFraction:total?Math.round(voiced/total*1000)/1000:null};
 }
}
