import {createReadStream} from 'node:fs';import {open,unlink} from 'node:fs/promises';import {createHash,randomUUID} from 'node:crypto';
import {prepareAudio} from './prepare.mjs';import {ANALYSIS_VERSION,analyzeAudio} from './analyze.mjs';import {getProfile,recommendProfile,PREPARATION_PIPELINE} from './profiles.mjs';import {runAudio,audioError} from './process.mjs';
const hash=value=>createHash('sha256').update(typeof value==='string'?value:JSON.stringify(value)).digest('hex');
const terminal=job=>['ready','failed','canceled'].includes(job.state);
const safe=result=>{const {files,...value}=result;return {...value,audioURL:`/api/local/records/${result.id}/versions/${result.versionId}/audio`}};
export class AudioPreparation{
 constructor(worker,original){this.worker=worker;this.original=original;this.queue=original.queue;this.jobs=new Map();this.closed=false;this.runtime=null}
 prune(){for(const [key,job] of this.jobs)if(this.jobs.size>=64&&terminal(job)&&job.settled&&(job.state!=='canceled'||Date.now()-job.finishedAt>=600000))this.jobs.delete(key)}
 async create(recordId,{profile='gentle',start,duration=20,preview=false,requestId=randomUUID()}={}){
  if(typeof requestId!=='string'||!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(requestId))throw audioError('INVALID_PREPARATION');
  const signature=hash([recordId,profile,preview?{start,duration}:null]),existing=()=>{const previous=this.jobs.get(requestId);if(previous&&previous.signature&&previous.signature!==signature)throw audioError('PREPARATION_CONFLICT');return previous};
  getProfile(profile);const old=existing();if(old)return this.snapshot(old);
  getProfile(profile);if(this.closed)throw audioError('CANCELLED');if([...this.jobs.values()].filter(job=>!terminal(job)).length>=8)throw audioError('PREPARATION_BUSY');
  if(preview&&(!Number.isFinite(start)||start<0||!Number.isFinite(duration)||duration<=0||duration>20))throw audioError('INVALID_PREVIEW');
  const source=await this.original.sources(recordId),id=requestId,repeated=existing();if(repeated)return this.snapshot(repeated);if([...this.jobs.values()].filter(job=>!terminal(job)).length>=8)throw audioError('PREPARATION_BUSY');this.prune();if(this.jobs.size>=64)throw audioError('PREPARATION_BUSY');
  const job={id,recordId,signature,profile,sourceHash:source.sourceHash,state:'queued',stage:'queued',seconds:0,controller:new AbortController(),...(preview?{preview:{start,duration}}:{})};this.jobs.set(id,job);
  job.promise=this.work(job).then(result=>{if(job.state!=='canceled'){job.state='ready';job.stage='ready';job.result=safe(result);if(job.preview){if(job.preview.start>=result.frames/result.sampleRate)throw audioError('INVALID_PREVIEW');job.preview.duration=Math.min(job.preview.duration,result.frames/result.sampleRate-job.preview.start)}}}).catch(error=>{if(job.state!=='canceled'){job.state=error.code==='CANCELLED'?'canceled':'failed';job.errorCode=/^[A-Z_]{1,60}$/.test(error.code||'')?error.code:'PREPARATION_FAILED';job.stage=job.state;delete job.result}}).finally(()=>{job.settled=true;job.finishedAt=Date.now()});
  return this.snapshot(job);
 }
 snapshot(job){const {id,recordId,profile,state,stage,seconds,preview,result,errorCode,reason}=job;return {id,recordId,profile,state,stage,seconds,...(reason?{reason}:{}),...(preview?{preview}:{}),...(result?{result}:{}),...(errorCode?{errorCode}:{})}}
 async get(id){const job=this.jobs.get(id);if(!job)throw audioError('NOT_FOUND');if(job.state==='ready')await this.resolve(job.recordId,job.result.versionId);return this.snapshot(job)}
 cancel(id){if(typeof id!=='string'||!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(id))throw audioError('INVALID_PREPARATION');let job=this.jobs.get(id);if(!job){this.prune();if(this.jobs.size>=64)throw audioError('PREPARATION_BUSY');job={id,recordId:null,profile:null,state:'canceled',stage:'canceled',seconds:0,settled:true,finishedAt:Date.now()};this.jobs.set(id,job)}if(!terminal(job)){job.state='canceled';job.stage='canceled';job.controller.abort();delete job.result}return this.snapshot(job)}
 async resolve(recordId,versionId){if(!/^[a-f0-9]{64}$/.test(versionId))throw audioError('INVALID_AUDIO_VERSION');const source=await this.original.sources(recordId);const result=await this.worker.call('records.version.get',{id:recordId,versionId,sourceHash:source.sourceHash},{timeoutMs:600000});if(!result)throw audioError('NOT_FOUND');return result}
 async work(job){
  const signal=job.controller.signal,check=()=>{if(signal.aborted)throw audioError('CANCELLED')};let lease,stage;
  try{
   check();lease=await this.worker.call('stage.allocate');check();const source=await this.original.sources(job.recordId);if(source.sourceHash!==job.sourceHash)throw audioError('STALE_AUDIO_VERSION');
   job.stage='checking-source';const parts=source.kind==='native'?source.tracks.flatMap(track=>track.parts):source.files;
   for(const file of parts){const digest=createHash('sha256');let bytes=0;for await(const chunk of createReadStream(file.path)){check();bytes+=chunk.length;digest.update(chunk)}if(bytes!==file.size||digest.digest('hex')!==file.sha256)throw audioError('AUDIO_DAMAGED')}
   const original=await this.original.ensure(job.recordId,{signal});check();
   if(!this.runtime)this.runtime=runAudio('ffmpeg',['-version']).then(hash).catch(error=>{this.runtime=null;throw error});
   const runtime=await this.runtime,identify=profile=>{const parametersHash=hash({analysis:ANALYSIS_VERSION,runtime,preset:getProfile(profile),rate:48000,bits:24});return {parametersHash,versionId:hash([source.sourceHash,PREPARATION_PIPELINE,profile,parametersHash])}};
   // «Авто» is resolved from the measurement of this record's original, then stored as the concrete
   // profile it chose (so the version, its cache and its timeline are those of a real profile).
   const auto=job.profile==='auto';let {parametersHash,versionId}=auto?{}:identify(job.profile);check();
   return await this.queue.run(async()=>{
    check();job.state='processing';job.stage='checking-cache';
    if(!auto){const cached=await this.worker.call('records.version.get',{id:job.recordId,versionId,sourceHash:source.sourceHash},{timeoutMs:600000});if(cached)return cached}
    let input=original.files[0].path;
    if(original.files.length>1){
     if(!/^audio\/(webm|ogg)/.test(original.mime))throw audioError('PREPARATION_REQUIRED');
     const handle=await open(lease.path,'r+');try{for(const file of original.files)for await(const chunk of createReadStream(file.path)){check();let offset=0;while(offset<chunk.length){const {bytesWritten}=await handle.write(chunk,offset,chunk.length-offset);if(!bytesWritten)throw audioError('ARCHIVE_IO_ERROR');offset+=bytesWritten}}await handle.sync()}finally{await handle.close()}input=lease.path;
    }
    let measured=null;
    if(auto){
     job.stage='analyzing';measured=await analyzeAudio(input,{signal,onProgress:seconds=>{if(!terminal(job))job.seconds=seconds}});check();
     const choice=recommendProfile(measured);job.profile=choice.profile;job.reason=choice.reason;({parametersHash,versionId}=identify(job.profile));
     job.stage='checking-cache';const cached=await this.worker.call('records.version.get',{id:job.recordId,versionId,sourceHash:source.sourceHash},{timeoutMs:600000});if(cached)return cached;
    }
    stage=await this.worker.call('stage.allocate');await unlink(stage.path);check();
    const result=await prepareAudio(input,{output:stage.path,profile:job.profile,originalAnalysis:measured,signal,onProgress:value=>{if(!terminal(job)){job.stage=value.stage;job.seconds=value.seconds}}});check();
    const digest=createHash('sha256');for await(const bytes of createReadStream(stage.path)){check();digest.update(bytes)}
    const analysisJson=JSON.stringify(result.analysis),{analysis,...metadata}=result;delete metadata.profile;
    return this.worker.call('records.version.commit',{id:job.recordId,stagingId:stage.id,sha256:digest.digest('hex'),metadata:{...metadata,id:versionId,sourceHash:source.sourceHash,profile:job.profile,parametersHash,analysisJson,analysisHash:hash(analysisJson)}},{timeoutMs:600000});
   },{signal});
  }finally{try{if(stage)await this.worker.call('stage.discard',{id:stage.id})}finally{if(lease)await this.worker.call('stage.discard',{id:lease.id})}}
 }
 async close(){this.closed=true;for(const job of this.jobs.values())if(!terminal(job))job.controller.abort();await Promise.allSettled([...this.jobs.values()].map(job=>job.promise))}
}
