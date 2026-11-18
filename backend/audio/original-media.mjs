import {readFile,unlink} from 'node:fs/promises';import {createReadStream} from 'node:fs';import {createHash} from 'node:crypto';import path from 'node:path';
import {renderNative,NATIVE_PIPELINE} from './native-render.mjs';import {runAudio,audioError} from './process.mjs';
import {AudioWorkQueue} from './queue.mjs';import {speakerProfile} from './speakers.mjs';import {tmpdir} from 'node:os';
const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
export class OriginalMedia{
 constructor(worker,{queue=new AudioWorkQueue()}={}){this.worker=worker;this.queue=queue;this.entries=new Map();this.tail=Promise.resolve();this.readers=0;this.closed=false;this.runtime=null;this.operations=new Set();this.controllers=new Set()}
 ensure(id,{signal,onProgress}={}){
  if(this.closed)return Promise.reject(audioError('CANCELLED'));
  const controller=new AbortController();this.controllers.add(controller);const combined=signal?AbortSignal.any([signal,controller.signal]):controller.signal;
  const operation=this._ensure(id,{signal:combined,onProgress}).finally(()=>{this.controllers.delete(controller);this.operations.delete(operation)});this.operations.add(operation);return operation;
 }
 /** Loudness profile of a two-track take (cached per source); null for one track. */
 async speakers(id,{ffmpeg='ffmpeg'}={}){
  const source=await this.sources(id);if(source.kind!=='native')return null;this.speakerCache??=new Map();
  const cached=this.speakerCache.get(id);if(cached?.hash===source.sourceHash)return cached.profile;
  const profile=await this.queue.run(()=>speakerProfile(source,{ffmpeg,directory:tmpdir()}));
  this.speakerCache.set(id,{hash:source.sourceHash,profile});if(this.speakerCache.size>32)this.speakerCache.delete(this.speakerCache.keys().next().value);return profile;
 }
 async sources(id){
  const stage=await this.worker.call('records.sources.file',{id},{timeoutMs:60000});
  try{if(stage.size>32*1024**2)throw audioError('SOURCE_TOO_LARGE');return JSON.parse(await readFile(stage.path,'utf8'))}
  finally{await this.worker.call('stage.discard',{id:stage.id})}
 }
 async _ensure(id,{signal,onProgress}={}){
  if(this.closed||signal?.aborted)throw audioError('CANCELLED');if(this.readers>=4)throw audioError('PREPARATION_BUSY');this.readers++;
  try{
   const source=await this.sources(id);if(this.closed||signal?.aborted)throw audioError('CANCELLED');
   if(source.kind==='container')return this.worker.call('records.audio',{id},{signal,timeoutMs:60000});
   if(source.kind!=='native'||!/^[a-f0-9]{64}$/.test(source.sourceHash))throw audioError('INVALID_SOURCE');
   if(!this.runtime)this.runtime=runAudio('ffmpeg',['-version']).then(value=>hash(value)).catch(error=>{this.runtime=null;throw error});
   const parametersHash=hash({runtime:await this.runtime,rate:48000,bits:24,codec:'flac',mix:'equal-headroom-limiter-0.891251',resampler:'swr-async1000-min0.00001-hard0.1'});
   if(this.closed||signal?.aborted)throw audioError('CANCELLED');
   const versionId=hash([source.sourceHash,NATIVE_PIPELINE,'original',parametersHash]),key=id+':'+versionId;
   let entry=this.entries.get(key);
   if(!entry){
    const controller=new AbortController();entry={controller,users:0,observers:new Set(),promise:null};this.entries.set(key,entry);
    const work=this.queue.run(async()=>{
     if(controller.signal.aborted)throw audioError('CANCELLED');
     const existing=await this.worker.call('records.version.get',{id,versionId,sourceHash:source.sourceHash},{signal:controller.signal,timeoutMs:600000});if(existing)return existing;
     const stage=await this.worker.call('stage.allocate');
     try{
      // stage.allocate reserves this opaque name and freezes archive moves.
      // The encoder obtains it exclusively, never replacing an existing file.
      await unlink(stage.path);const result=await renderNative(source,{directory:path.dirname(stage.path),output:stage.path,signal:controller.signal,onProgress:seconds=>{for(const observer of entry.observers)observer(seconds)}});
      const digest=createHash('sha256');for await(const bytes of createReadStream(stage.path)){if(controller.signal.aborted)throw audioError('CANCELLED');digest.update(bytes)}
      if(controller.signal.aborted)throw audioError('CANCELLED');
      return await this.worker.call('records.version.commit',{id,stagingId:stage.id,sha256:digest.digest('hex'),metadata:{id:versionId,sourceHash:source.sourceHash,pipelineVersion:NATIVE_PIPELINE,profile:'original',parametersHash,frames:result.frames,sampleRate:result.sampleRate,channels:result.channels,mime:result.mime}},{timeoutMs:600000});
     }finally{await this.worker.call('stage.discard',{id:stage.id})}
    },{signal:controller.signal});
    entry.promise=work.finally(()=>{if(this.entries.get(key)===entry)this.entries.delete(key)});this.tail=entry.promise.catch(()=>{});
   }
   entry.users++;if(onProgress)entry.observers.add(onProgress);
   return await new Promise((resolve,reject)=>{
    let released=false;
    const release=()=>{if(released)return;released=true;signal?.removeEventListener('abort',abort);if(onProgress)entry.observers.delete(onProgress);if(--entry.users===0)entry.controller.abort()};
    const abort=()=>{release();reject(audioError('CANCELLED'))};
    signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted){abort();return}
    entry.promise.then(value=>{release();resolve(value)},error=>{release();reject(error)});
   });
  }finally{this.readers--}
 }
 async close(){this.closed=true;for(const controller of this.controllers)controller.abort();for(const entry of this.entries.values())entry.controller.abort();await Promise.allSettled([...this.operations]);await this.tail}
}
