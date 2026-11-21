const aborted=()=>new DOMException('Playback superseded','AbortError');
const finite=value=>Number.isFinite(value);
function wait(media,event,condition,signal){
 if(signal.aborted)return Promise.reject(aborted());if(condition())return Promise.resolve();
 return new Promise((resolve,reject)=>{
  const finish=error=>{clearTimeout(timer);media.removeEventListener(event,ready);media.removeEventListener('error',failed);signal.removeEventListener('abort',cancel);error?reject(error):resolve()};
  const ready=()=>{if(condition())finish()},failed=()=>finish(new Error('Не удалось загрузить аудио для сравнения.')),cancel=()=>finish(aborted());
  const timer=setTimeout(()=>finish(new Error('Аудио пока не готово. Повторите прослушивание.')),8000);media.addEventListener(event,ready);media.addEventListener('error',failed);signal.addEventListener('abort',cancel,{once:true});
 });
}
function delay(ms,signal){if(!ms)return Promise.resolve();return new Promise((resolve,reject)=>{const abort=()=>{clearTimeout(timer);reject(aborted())},timer=setTimeout(()=>{signal.removeEventListener('abort',abort);resolve()},ms);signal.addEventListener('abort',abort,{once:true});if(signal.aborted)abort()})}

/** One timeline, one audible branch. Comparison gain affects audition only. */
export class ReviewPlayer{
 constructor({original,prepared,play=audio=>audio.play(),contextFactory=()=>new AudioContext(),fadeMs=12}={}){
  this.elements={original,prepared};this.playMedia=play;this.contextFactory=contextFactory;this.fadeMs=fadeMs;this.variant='original';this.position=0;this.rate=1;this.volume=1;this.matching=true;this.analysis=null;this.wantPlaying=false;this.transitioning=false;this.internalPause=false;this.abort=null;this.tail=Promise.resolve();this.context=null;this.nodes=null;this.listeners=new Set();this.events=[];this.closed=false;
  for(const [name,media] of Object.entries(this.elements))for(const event of ['timeupdate','play','pause','ended','loadedmetadata']){
   const listener=()=>{if(name!==this.variant||this.closed)return;if(event==='pause'&&!this.internalPause&&!this.transitioning)this.wantPlaying=false;if(event==='ended')this.wantPlaying=false;this.position=finite(media.currentTime)?media.currentTime:this.position;this.emit()};media.addEventListener(event,listener);this.events.push(()=>media.removeEventListener(event,listener));
  }
 }
 get active(){return this.elements[this.variant]}
 get time(){return this.active.readyState>=1&&finite(this.active.currentTime)?this.active.currentTime:this.position}
 get matchingAvailable(){return ['original','prepared'].every(name=>this.analysis?.[name]?.loudness?.valid&&finite(this.analysis[name].loudness.integrated))}
 target(name){if(name!==this.variant)return 0;let gain=this.volume;if(this.matching&&this.matchingAvailable){const a=this.analysis.original.loudness.integrated,b=this.analysis.prepared.loudness.integrated;gain*=10**((Math.min(a,b)-this.analysis[name].loudness.integrated)/20)}return gain}
 get snapshot(){return {variant:this.variant,time:this.time,duration:finite(this.active.duration)?this.active.duration:0,playing:!this.active.paused,rate:this.rate,volume:this.volume,matching:this.matching,matchingAvailable:this.matchingAvailable,preparedReady:Boolean(this.elements.prepared.src),gains:{original:this.target('original'),prepared:this.target('prepared')}}}
 subscribe(listener){this.listeners.add(listener);listener(this.snapshot);return()=>this.listeners.delete(listener)}
 emit(){for(const listener of this.listeners)listener(this.snapshot)}
 pauseMedia(){this.internalPause=true;for(const media of Object.values(this.elements))media.pause();this.internalPause=false}
 gains(immediate=false){if(!this.nodes)return;for(const name of ['original','prepared']){const gain=this.nodes[name].gain,now=this.context.currentTime;gain.cancelScheduledValues(now);gain.setValueAtTime(immediate?this.target(name):gain.value,now);if(!immediate)gain.linearRampToValueAtTime(this.target(name),now+this.fadeMs/1000)}}
 pause(){this.wantPlaying=false;this.abort?.abort();this.requestedVariant=this.variant;this.position=this.time;this.pauseMedia();if(this.nodes)for(const node of Object.values(this.nodes)){node.gain.cancelScheduledValues(this.context.currentTime);node.gain.setValueAtTime(0,this.context.currentTime)}this.emit()}
 load({originalURL,preparedURL=null,analysis=null}){
  this.pause();this.variant='original';this.requestedVariant='original';this.position=0;this.analysis=analysis;
  for(const [name,media] of Object.entries(this.elements)){const url=name==='original'?originalURL:preparedURL;if(url)media.src=url;else media.removeAttribute('src');media.playbackRate=this.rate;media.load();media.currentTime=0}this.emit();
 }
 setPrepared(url,analysis=null){const position=this.time;this.pause();this.variant='original';this.requestedVariant='original';this.position=position;if(this.elements.original.readyState>=1)this.elements.original.currentTime=position;this.analysis=analysis;const media=this.elements.prepared;if(url)media.src=url;else media.removeAttribute('src');media.load();this.gains(true);this.emit()}
 setMatching(value){this.matching=Boolean(value);this.gains();this.emit()}
 setRate(value){if(!finite(value)||value<.5||value>2)throw new RangeError('Invalid playback rate');this.rate=value;for(const media of Object.values(this.elements))media.playbackRate=value;this.emit()}
 setVolume(value){if(!finite(value)||value<0||value>1)throw new RangeError('Invalid playback volume');this.volume=value;this.gains();this.emit()}
 async audioContext(){if(!this.context){this.context=this.contextFactory();this.nodes={};for(const [name,media] of Object.entries(this.elements)){const source=this.context.createMediaElementSource(media),node=this.context.createGain();node.gain.setValueAtTime(0,this.context.currentTime);source.connect(node);node.connect(this.context.destination);this.nodes[name]=node}}await this.context.resume()}
 /** At the end, Play starts over (as every media player does), not a no-op on the last frame. */
 play(){this.wantPlaying=true;const duration=this.active.duration;let at=this.time;if(this.active.ended||(finite(duration)&&duration>0&&at>=duration-.25)){at=0;this.position=0}return this.transition(this.requestedVariant||this.variant,at)}
 switchVariant(name){if(!['original','prepared'].includes(name)||!this.elements[name].src)return Promise.reject(new Error('Сначала подготовьте вариант для сравнения.'));return this.transition(name,this.time)}
 seek(seconds){if(!finite(seconds))return Promise.reject(new RangeError('Invalid seek'));const time=Math.max(0,Math.min(seconds,this.snapshot.duration||seconds));return this.transition(this.requestedVariant||this.variant,time)}
 transition(name,time){
  if(this.closed)return Promise.reject(aborted());this.requestedVariant=name;this.abort?.abort();if(this.transitioning)this.pauseMedia();const controller=new AbortController(),signal=controller.signal;this.abort=controller;
  const previous=this.tail;const operation=previous.catch(()=>{}).then(async()=>{
   signal.throwIfAborted();this.transitioning=true;
   try{
    if(!this.active.paused&&this.nodes){const gain=this.nodes[this.variant].gain,now=this.context.currentTime;gain.cancelScheduledValues(now);gain.setValueAtTime(gain.value,now);gain.linearRampToValueAtTime(0,now+this.fadeMs/1000);await delay(this.fadeMs,signal)}
    this.pauseMedia();const media=this.elements[name];await wait(media,'loadedmetadata',()=>media.readyState>=1,signal);signal.throwIfAborted();
    const position=Math.max(0,Math.min(time,finite(media.duration)?media.duration:time));media.currentTime=position;await wait(media,'seeked',()=>!media.seeking&&Math.abs(media.currentTime-position)<.01,signal);signal.throwIfAborted();
    this.variant=name;this.position=position;media.playbackRate=this.rate;
    if(this.wantPlaying){await this.audioContext();signal.throwIfAborted();this.gains(true);this.nodes[name].gain.setValueAtTime(0,this.context.currentTime);await this.playMedia(media);signal.throwIfAborted();if(media.paused)throw aborted();this.gains()}
    this.emit();return this.snapshot;
   }catch(error){this.pauseMedia();if(!signal.aborted)this.wantPlaying=false;throw error}
   finally{if(this.abort===controller)this.transitioning=false}
  });this.tail=operation;return operation;
 }
 async destroy(){if(this.closed)return;this.pause();this.closed=true;for(const remove of this.events)remove();await this.tail.catch(()=>{});for(const media of Object.values(this.elements)){media.removeAttribute('src');media.load()}this.listeners.clear();if(this.context)await this.context.close()}
}
