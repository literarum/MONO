import {createReadStream} from 'node:fs';import {open,writeFile,unlink,stat,statfs} from 'node:fs/promises';import {createHash,randomUUID} from 'node:crypto';import path from 'node:path';
import {runAudio,audioError} from './process.mjs';
export const NATIVE_PIPELINE='native-timeline-1';
const positive=n=>typeof n==='number'&&Number.isFinite(n)&&n>0;
function fileQuote(file){if(typeof file!=='string'||/[\r\n\0]/.test(file))throw audioError('UNSAFE_PATH');return "'"+file.replaceAll('\\','/').replaceAll("'","'\\''")+"'"}
async function verify(part,signal){
 if(signal?.aborted)throw audioError('CANCELLED');if(!/^[a-f0-9]{64}$/.test(part.sha256)||!Number.isSafeInteger(part.size)||part.size<44)throw audioError('INVALID_SOURCE');
 const file=await stat(part.path);if(!file.isFile()||file.size!==part.size)throw audioError('AUDIO_DAMAGED');const hash=createHash('sha256');
 for await(const bytes of createReadStream(part.path)){if(signal?.aborted)throw audioError('CANCELLED');hash.update(bytes)}if(hash.digest('hex')!==part.sha256)throw audioError('AUDIO_DAMAGED');
}
export async function renderNative(source,{directory,output,signal,onProgress,ffmpeg='ffmpeg',ffprobe='ffprobe'}={}){
 if(signal?.aborted)throw audioError('CANCELLED');
 if(!positive(source.duration)||source.duration>30*86400||!Array.isArray(source.tracks)||!source.tracks.length||source.tracks.length>2)throw audioError('INVALID_SOURCE');
 const frames=Math.round(source.duration*48000);if(!Number.isSafeInteger(frames)||frames<1)throw audioError('INVALID_SOURCE');
 const files=[],inputs=[],filters=[];let created=false;
 try{
  for(const [i,track] of source.tracks.entries()){
   if(!['mic','system'].includes(track.id)||source.tracks.findIndex(t=>t.id===track.id)!==i||!Number.isInteger(track.channels)||track.channels<1||track.channels>64||!Array.isArray(track.parts)||!track.parts.length||track.parts.length>1000000)throw audioError('INVALID_SOURCE');
   let concat='ffconcat version 1.0\n';
   for(const [index,part] of track.parts.entries()){
    if(!Number.isFinite(part.start)||part.start<0||!positive(part.end)||part.end<=part.start||part.end>source.duration+.002||index>0&&part.start<track.parts[index-1].end-.002)throw audioError('INVALID_SOURCE');
    await verify(part,signal);const duration=index+1<track.parts.length?track.parts[index+1].start-part.start:part.end-part.start;if(!positive(duration))throw audioError('INVALID_SOURCE');
    concat+=`file ${fileQuote(part.path)}\nduration ${duration.toFixed(9)}\n`;
   }
   const list=path.join(directory,'native-'+randomUUID()+'.ffconcat');files.push(list);await writeFile(list,concat,{flag:'wx',mode:0o600});inputs.push('-f','concat','-safe','0','-protocol_whitelist','file,pipe','-i',list);
   filters.push(`[${i}:a]asetpts=PTS+${track.parts[0].start.toFixed(9)}/TB,aresample=48000:async=1000:min_comp=0.00001:min_hard_comp=0.1:first_pts=0,apad=whole_len=${frames},atrim=end_sample=${frames},asetpts=N/SR/TB[t${i}]`);
  }
  const channels=source.tracks.length===1?source.tracks[0].channels:Math.max(...source.tracks.map(t=>t.channels));const space=await statfs(directory);if(Number(space.bavail)*Number(space.bsize)<frames*channels*4+32*1024**2)throw audioError('DISK_FULL');
  const map=source.tracks.length===1?'[t0]':'[mix]';if(source.tracks.length>1)filters.push(`[t0][t1]amix=inputs=2:duration=longest:normalize=1:dropout_transition=0,alimiter=limit=0.891251:attack=1:release=20:level=0:latency=1,apad=whole_len=${frames},atrim=end_sample=${frames}[mix]`);
  // Exclusive reservation: a failure never deletes a pre-existing caller file.
  const handle=await open(output,'wx',0o600);await handle.close();created=true;
  await runAudio(ffmpeg,['-hide_banner','-loglevel','error','-nostdin','-y',...inputs,'-filter_complex',filters.join(';'),'-map',map,'-ar','48000','-c:a','flac','-sample_fmt','s32','-bits_per_raw_sample','24','-f','flac','-progress','pipe:1',output],{signal,timeoutMs:Math.max(900000,Math.min(7200000,source.duration*500)),onProgress});
  const raw=await runAudio(ffprobe,['-v','error','-select_streams','a:0','-show_entries','stream=sample_rate,channels,duration_ts,time_base,codec_name','-of','json',output],{signal});
  let stream;try{stream=JSON.parse(raw).streams?.[0]}catch{throw audioError('INVALID_OUTPUT')}
  if(stream?.codec_name!=='flac'||stream.time_base!=='1/48000'||Number(stream.sample_rate)!==48000||Number(stream.duration_ts)!==frames||stream.channels!==channels)throw audioError('INVALID_OUTPUT');
  const handleOut=await open(output,'r+');try{await handleOut.sync()}finally{await handleOut.close()}
  return {path:output,frames,sampleRate:48000,channels,mime:'audio/flac',pipelineVersion:NATIVE_PIPELINE};
 }catch(error){if(created)await unlink(output).catch(()=>{});throw error}
 finally{for(const file of files)await unlink(file).catch(()=>{})}
}
