// Studio helpers that make the main action self-explanatory:
// a live input level before recording starts, bookmarks during recording,
// "saved N s ago" feedback and a laptop battery watch.

/** "Говорите — шкала должна двигаться": level of the system default (or chosen
 * browser) microphone while idle. Opens the device only when the microphone
 * permission is already granted, so it never triggers a surprise prompt. */
export class LevelPreview{
 constructor({devices=globalThis.navigator?.mediaDevices,permissions=globalThis.navigator?.permissions,contextFactory=()=>new AudioContext()}={}){
  this.devices=devices;this.permissions=permissions;this.contextFactory=contextFactory;this.stream=null;this.context=null;this.analyser=null;this.buffer=null;this.opening=null;this.wanted=false;
 }
 get active(){return Boolean(this.analyser)}
 async granted(){try{return (await this.permissions?.query({name:'microphone'}))?.state==='granted'}catch{return false}}
 async start(deviceId=null){
  this.wanted=true;if(this.opening||this.analyser)return this.opening;
  this.opening=(async()=>{
   if(!this.devices?.getUserMedia||!await this.granted()||!this.wanted)return false;
   const stream=await this.devices.getUserMedia({audio:{...(deviceId?{deviceId:{exact:deviceId}}:{}),echoCancellation:false,noiseSuppression:false,autoGainControl:false},video:false});
   if(!this.wanted){stream.getTracks().forEach(track=>track.stop());return false}
   const context=this.contextFactory(),analyser=context.createAnalyser();analyser.fftSize=1024;context.createMediaStreamSource(stream).connect(analyser);
   Object.assign(this,{stream,context,analyser,buffer:new Float32Array(analyser.fftSize)});return true;
  })().catch(()=>false).finally(()=>{this.opening=null});
  return this.opening;
 }
 rms(){
  if(!this.analyser)return 0;this.analyser.getFloatTimeDomainData(this.buffer);
  let sum=0;for(const v of this.buffer)sum+=v*v;return Math.sqrt(sum/this.buffer.length);
 }
 stop(){
  this.wanted=false;this.stream?.getTracks().forEach(track=>track.stop());void this.context?.close().catch(()=>{});
  Object.assign(this,{stream:null,context:null,analyser:null,buffer:null});
 }
}

/** Bookmarks: {at: seconds from the start of the take, label}. Sorted, deduplicated within 1 s. */
export function addBookmark(list,at,label='Важно'){
 const seconds=Math.max(0,Math.round(Number(at)*10)/10);const marks=[...(Array.isArray(list)?list:[])];
 if(marks.some(mark=>Math.abs(mark.at-seconds)<1))return marks;
 marks.push({at:seconds,label:String(label).slice(0,200)});return marks.sort((a,b)=>a.at-b.at).slice(-1000);
}

/** "Сохранено 3 с назад": time since the archive last confirmed new audio. */
export class SaveClock{
 constructor(now=()=>performance.now()){this.now=now;this.session=null;this.duration=0;this.at=0}
 observe(sessionId,duration){
  if(sessionId!==this.session){this.session=sessionId;this.duration=duration||0;this.at=this.now();return}
  if((duration||0)>this.duration){this.duration=duration;this.at=this.now()}
 }
 text(){const seconds=Math.max(0,Math.round((this.now()-this.at)/1000));return seconds<2?'только что':`${seconds} с назад`}
 stale(limit=10000){return this.now()-this.at>limit}
}

/** Laptop on battery during a long recording: warn at 20 % and 10 %, once each per take. */
export class BatteryWatch{
 constructor({battery=()=>globalThis.navigator?.getBattery?.(),onWarn}={}){this.battery=battery;this.onWarn=onWarn;this.warned=new Set();this.device=null;this.listening=false}
 reset(){this.warned.clear()}
 async check(){
  try{this.device??=await this.battery()}catch{return null}const b=this.device;if(!b)return null;
  if(!this.listening){this.listening=true;b.addEventListener?.('levelchange',()=>void this.check())}
  if(b.charging||!this.active)return null;
  for(const limit of [.1,.2])if(b.level<=limit&&!this.warned.has(limit)){
   this.warned.add(limit);this.warned.add(.2);
   const minutes=Number.isFinite(b.dischargingTime)?Math.round(b.dischargingTime/60):null;
   const message=`Заряд батареи ${Math.round(b.level*100)} %${minutes?` (~${minutes} мин)`:''}. Подключите зарядку: запись сохраняется, но ноутбук может выключиться.`;
   this.onWarn?.(message);return message;
  }
  return null;
 }
}

/** A record still carrying its automatic name («Запись 18.11.2026 14:05»). */
export const DEFAULT_TITLE=/^Запись \d\d\.\d\d\.\d{4} \d\d:\d\d( · продолжение)?$/;
const FILLER=/^(?:(?:ну|так|вот|итак|э+|а+|м+|алло|короче|в общем|значит|слушай(?:те)?|окей|ок|да|ага|угу)[\s,.!?…-]+)+/i;
/** Title from the first meaningful words of a transcript: fillers dropped, cut at a sentence
 * end or a word boundary (≤ 60 chars), first letter capitalised. null when nothing usable. */
export function suggestTitle(segments,limit=60){
 let text='';
 for(const s of segments||[]){text+=' '+String(s?.text||'');if(text.trim().length>=limit*1.5)break}
 text=text.replace(/\s+/g,' ').trim().replace(FILLER,'').trim();
 if(text.replace(/[^\p{L}\p{N}]/gu,'').length<8)return null;
 const sentence=/^(.{12,}?[.!?…])(\s|$)/u.exec(text);let title=sentence&&sentence[1].length<=limit?sentence[1].replace(/[.!?…]+$/,''):text;
 if(title.length>limit){title=title.slice(0,limit);const cut=title.lastIndexOf(' ');if(cut>limit*.5)title=title.slice(0,cut);title=title.replace(/[,;:\-–—]+$/,'')+'…'}
 return title.charAt(0).toUpperCase()+title.slice(1);
}
