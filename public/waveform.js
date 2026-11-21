// The player's spectral waveform: one bar per slice of time, height = loudness, colour = how
// bright the sound is (deep blue for vowels and hum → cyan for sibilants and hiss). The range
// input stays on top for keyboard and screen readers; the canvas only draws.
export class PlayerWave{
 constructor(canvas,seek,{frame=globalThis.requestAnimationFrame?.bind(globalThis),cancel=globalThis.cancelAnimationFrame?.bind(globalThis)}={}){
  Object.assign(this,{canvas,seek,frame,cancel});this.data=null;this.drawn=null;this.loop=0;
  this.resize=new ResizeObserver(()=>{this.drawn=null});this.resize.observe(canvas);
 }
 load(data){this.data=data?.peaks?.length?data:null;this.drawn=null;this.canvas.closest('.seek-wave')?.classList.toggle('has-wave',Boolean(this.data));this.start()}
 clear(){this.load(null);const context=this.canvas.getContext('2d');context?.clearRect(0,0,this.canvas.width,this.canvas.height)}
 start(){if(!this.loop&&this.frame)this.loop=this.frame(()=>this.tick())}
 stop(){if(this.loop&&this.cancel)this.cancel(this.loop);this.loop=0}
 tick(){
  this.loop=0;if(!this.data)return;
  if(this.canvas.isConnected&&this.canvas.offsetParent!==null&&!document.hidden){const progress=Number(this.seek.value)/Number(this.seek.max||1000),key=`${progress.toFixed(4)}|${this.canvas.clientWidth}|${document.body.dataset.theme}`;if(key!==this.drawn){this.draw(progress);this.drawn=key}}
  this.start();
 }
 draw(progress){
  const canvas=this.canvas,ratio=Math.min(2,globalThis.devicePixelRatio||1),width=Math.max(1,Math.round(canvas.clientWidth*ratio)),height=Math.max(1,Math.round(canvas.clientHeight*ratio));
  if(canvas.width!==width||canvas.height!==height){canvas.width=width;canvas.height=height}
  const context=canvas.getContext('2d');if(!context)return;context.clearRect(0,0,width,height);
  const {peaks,brightness}=this.data,light=document.body.dataset.theme==='light',gap=Math.max(1,Math.round(ratio)),count=Math.max(1,Math.floor(width/(2*ratio+gap)));
  const bar=Math.max(1,(width-gap*(count-1))/count),played=progress*width,middle=height/2;
  for(let i=0;i<count;i++){
   const index=Math.min(peaks.length-1,Math.floor(i*peaks.length/count)),value=peaks[index]||0,bright=brightness[index]||0;
   const h=Math.max(2*ratio,value*height*.92),x=i*(bar+gap),hue=222-50*bright,saturation=light?78:88,lightness=light?48-8*bright:62+6*bright;
   context.fillStyle=`hsla(${hue},${saturation}%,${lightness}%,${x+bar<=played?1:light?.32:.3})`;
   const r=Math.min(bar/2,h/2);context.beginPath();context.roundRect?context.roundRect(x,middle-h/2,bar,h,r):context.rect(x,middle-h/2,bar,h);context.fill();
  }
 }
}
