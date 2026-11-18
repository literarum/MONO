// Safety track (dissimilar redundancy): while the system module records the microphone,
// this window records the same microphone along a different path — browser audio stack,
// Opus encoder, the window's private storage (OPFS) — so a failure of the main path
// (helper crash, driver error, archive disk) does not lose the meeting.
// Windows shared-mode capture lets several clients open one microphone at once.
// Chunks are separate files ("one chunk = one file"), written every few seconds; a crash
// loses at most the last chunk. Nothing here ever blocks or fails the main recording.

const ROOT='mono-safety';
const KEEP_CLEAN_MS=24*3600e3,KEEP_FAILED_MS=7*24*3600e3;
const pad=n=>String(n).padStart(6,'0');

export class SafetyTrack{
 constructor({nav=globalThis.navigator,Recorder=globalThis.MediaRecorder,storage=()=>globalThis.navigator?.storage?.getDirectory?.(),timeslice=4000,now=()=>Date.now(),onIssue=()=>{}}={}){
  Object.assign(this,{nav,Recorder,storage,timeslice,now,onIssue});this.active=null;this.writing=Promise.resolve();
 }
 get supported(){return Boolean(this.Recorder&&this.nav?.mediaDevices?.getUserMedia&&this.nav?.storage?.getDirectory)}
 async root(){const base=await this.storage();return base.getDirectoryHandle(ROOT,{create:true})}
 async folder(id,create=false){return (await this.root()).getDirectoryHandle(id,{create})}
 async writeFile(dir,name,data){const handle=await dir.getFileHandle(name,{create:true});const stream=await handle.createWritable();await stream.write(data);await stream.close()}
 async meta(dir){try{return JSON.parse(await (await (await dir.getFileHandle('meta.json')).getFile()).text())}catch{return null}}
 async saveMeta(dir,meta){await this.writeFile(dir,'meta.json',JSON.stringify(meta))}

 /** Start recording a backup of `recordId`. Returns false (quietly) when it cannot. */
 async start(recordId,{deviceId=null,title=''}={}){
  if(!this.supported||!recordId)return false;
  if(this.active?.recordId===recordId)return true;
  if(this.active)await this.stop({outcome:'superseded'});
  let stream;
  try{
   stream=await this.nav.mediaDevices.getUserMedia({audio:{...(deviceId?{deviceId:{exact:deviceId}}:{}),echoCancellation:false,noiseSuppression:false,autoGainControl:false},video:false});
   const mime=['audio/webm;codecs=opus','audio/webm','audio/ogg;codecs=opus'].find(type=>this.Recorder.isTypeSupported?.(type))||'';
   const recorder=new this.Recorder(stream,{...(mime?{mimeType:mime}:{}),audioBitsPerSecond:32000});
   const dir=await this.folder(recordId,true);const meta={recordId,title:String(title).slice(0,200),mime:recorder.mimeType||mime||'audio/webm',startedAt:this.now(),chunks:0,bytes:0,outcome:'recording'};
   await this.saveMeta(dir,meta);
   const session={recordId,stream,recorder,dir,meta,index:0};this.active=session;
   recorder.ondataavailable=event=>{if(!event.data?.size)return;const index=++session.index;
    this.writing=this.writing.then(async()=>{await this.writeFile(dir,pad(index)+'.part',event.data);meta.chunks=index;meta.bytes+=event.data.size;meta.updatedAt=this.now();await this.saveMeta(dir,meta)}).catch(error=>this.onIssue('SAFETY_WRITE',error))};
   recorder.onerror=event=>this.onIssue('SAFETY_RECORDER',event.error||event);
   stream.getAudioTracks()[0]?.addEventListener?.('ended',()=>this.onIssue('SAFETY_TRACK_ENDED',null));
   recorder.start(this.timeslice);return true;
  }catch(error){stream?.getTracks().forEach(t=>t.stop());this.active=null;this.onIssue('SAFETY_START',error);return false}
 }
 pause(){try{if(this.active?.recorder.state==='recording')this.active.recorder.pause()}catch{}}
 resume(){try{if(this.active?.recorder.state==='paused')this.active.recorder.resume()}catch{}}
 /** Stop and flush. outcome: 'clean' (main take saved), 'failed' (main take interrupted). */
 async stop({outcome='clean'}={}){
  const session=this.active;if(!session)return null;this.active=null;
  await new Promise(resolve=>{if(session.recorder.state==='inactive')return resolve();session.recorder.addEventListener('stop',resolve,{once:true});try{session.recorder.stop()}catch{resolve()}setTimeout(resolve,3000)});
  session.stream.getTracks().forEach(t=>t.stop());
  await this.writing.catch(()=>{});
  Object.assign(session.meta,{outcome,stoppedAt:this.now()});try{await this.saveMeta(session.dir,session.meta)}catch{}
  return {...session.meta};
 }
 /** All stored backups: [{recordId,title,mime,startedAt,stoppedAt,chunks,bytes,outcome}]. */
 async list(){
  if(!this.supported)return [];const out=[];
  try{for await(const [name,handle] of (await this.root()).entries()){if(handle.kind!=='directory')continue;const meta=await this.meta(handle);if(meta)out.push(meta);else out.push({recordId:name,chunks:0,bytes:0,outcome:'unknown'})}}catch{}
  return out.sort((a,b)=>(b.startedAt||0)-(a.startedAt||0));
 }
 /** One playable file: the chunks of a single MediaRecorder joined in order. */
 async blob(recordId){
  const dir=await this.folder(recordId);const meta=await this.meta(dir)||{};const parts=[];
  for await(const [name,handle] of dir.entries())if(handle.kind==='file'&&name.endsWith('.part'))parts.push([name,handle]);
  parts.sort((a,b)=>a[0].localeCompare(b[0]));
  const files=await Promise.all(parts.map(([,handle])=>handle.getFile()));
  return new Blob(files,{type:meta.mime||'audio/webm'});
 }
 async discard(recordId){try{await (await this.root()).removeEntry(recordId,{recursive:true})}catch{}}
 /** Retention: a clean backup is kept a day (in case the main file later proves damaged), a failed one a week. */
 async prune(){
  for(const meta of await this.list()){
   if(this.active?.recordId===meta.recordId)continue;
   const age=this.now()-(meta.stoppedAt||meta.updatedAt||meta.startedAt||0);
   if(age>(meta.outcome==='failed'||meta.outcome==='recording'?KEEP_FAILED_MS:KEEP_CLEAN_MS)||!meta.chunks&&age>3600e3)await this.discard(meta.recordId);
  }
 }
}
