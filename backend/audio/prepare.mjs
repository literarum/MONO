import {open,unlink,statfs} from 'node:fs/promises';import path from 'node:path';
import {analyzeAudio} from './analyze.mjs';import {getProfile,recommendProfile,PREPARATION_PIPELINE} from './profiles.mjs';import {runAudio,audioError} from './process.mjs';
export async function prepareAudio(input,{output,profile='gentle',originalAnalysis=null,signal,onProgress,ffmpeg='ffmpeg',ffprobe='ffprobe'}={}){
 let preset=getProfile(profile),choice=null;if(signal?.aborted)throw audioError('CANCELLED');
 if(typeof output!=='string'||!path.isAbsolute(output)||path.resolve(input)===path.resolve(output))throw audioError('INVALID_AUDIO_OUTPUT');
 let owned=false;
 const stage=name=>seconds=>onProgress?.({stage:name,seconds});
 try{
  const handle=await open(output,'wx',0o600);await handle.close();owned=true;
  const original=originalAnalysis||await analyzeAudio(input,{signal,onProgress:stage('analyzing'),ffmpeg,ffprobe}),frames=Math.round(original.duration*48000);
  if(!Number.isSafeInteger(frames)||frames<1)throw audioError('INVALID_AUDIO_INPUT');
  if(profile==='auto'){choice=recommendProfile(original);preset=getProfile(choice.profile)}
  const space=await statfs(path.dirname(output));if(Number(space.bavail)*Number(space.bsize)<frames*original.channels*4+32*1024**2)throw audioError('DISK_FULL');
  const filters=preset.preFilter?[preset.preFilter]:[];
  if(preset.normalize){
   const measured=await analyzeAudio(input,{analysisProfile:preset.id,signal,onProgress:stage('measuring'),ffmpeg,ffprobe});
   if(measured.loudness.valid){
    const {integrated,range,threshold}=measured.loudness;
    if([integrated,range,threshold,measured.truePeak].every(Number.isFinite))filters.push(`loudnorm=I=-19:TP=-2:LRA=11:measured_I=${integrated}:measured_TP=${measured.truePeak}:measured_LRA=${range}:measured_thresh=${threshold}:linear=true`);
    else if(measured.truePeak!==null)filters.push(`volume=${Math.min(0,-2-measured.truePeak)}dB`);
   }else if(measured.truePeak!==null)filters.push(`volume=${Math.min(0,-2-measured.truePeak)}dB`);
  }
  filters.push('aresample=48000',`apad=whole_len=${frames}`,`atrim=end_sample=${frames}`,'asetpts=N/SR/TB');
  await runAudio(ffmpeg,['-hide_banner','-v','error','-nostdin','-threads','1','-protocol_whitelist','file,pipe','-format_whitelist','wav,flac,mp3,mov,matroska,webm,ogg,aac','-i',input,'-map','0:a:0','-af',filters.join(','),'-ar','48000','-c:a','flac','-sample_fmt','s32','-bits_per_raw_sample','24','-f','flac','-y','-progress','pipe:1',output],{signal,timeoutMs:Math.max(900000,Math.min(7200000,original.duration*1000)),onProgress:stage('rendering')});
  const prepared=await analyzeAudio(output,{signal,onProgress:stage('checking'),ffmpeg,ffprobe});
  if(prepared.frames!==frames||prepared.sampleRate!==48000||prepared.channels!==original.channels)throw audioError('AUDIO_TIMELINE_MISMATCH');
  if(preset.normalize&&prepared.truePeak!==null&&prepared.truePeak>-2)throw audioError('AUDIO_PEAK_TARGET');
  const synced=await open(output,'r+');try{await synced.sync()}finally{await synced.close()}
  return {profile,...(choice?{chosenProfile:choice.profile,reason:choice.reason}:{}),pipelineVersion:PREPARATION_PIPELINE,frames,sampleRate:48000,channels:original.channels,mime:'audio/flac',analysis:{original,prepared}};
 }catch(error){if(owned)await unlink(output).catch(()=>{});throw error}
}
