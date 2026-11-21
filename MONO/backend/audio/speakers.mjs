// Meeting mode without ML: in a two-track take ("Микрофон и компьютер") the
// microphone carries the person and the system track carries everyone else.
// A per-track loudness profile (RMS per bin, dBFS) lets the editor label each
// transcript segment «Я» or «Собеседники». Tracks are decoded by FFmpeg at
// 8 kHz mono and reduced to bins on the fly (1 h ≈ 7 200 values per track).
import {spawn} from 'node:child_process';import {writeFile,unlink} from 'node:fs/promises';import {randomUUID} from 'node:crypto';import path from 'node:path';
import {audioError} from './process.mjs';
const RATE=8000;
function quote(file){if(typeof file!=='string'||/[\r\n\0]/.test(file))throw audioError('UNSAFE_PATH');return "'"+file.replaceAll('\\','/').replaceAll("'","'\\''")+"'"}
export function binsFromSamples(samples,state,binFrames){
 for(const value of samples){state.sum+=value*value;if(++state.count===binFrames){state.out.push(state.sum>0?Math.round(10*Math.log10(state.sum/state.count))/1:-120);state.sum=0;state.count=0}}
}
async function trackProfile(track,{ffmpeg,directory,signal,bin,duration}){
 let concat='ffconcat version 1.0\n';
 for(const [index,part] of track.parts.entries()){const length=index+1<track.parts.length?track.parts[index+1].start-part.start:part.end-part.start;if(!(length>0))throw audioError('INVALID_SOURCE');concat+=`file ${quote(part.path)}\nduration ${length.toFixed(9)}\n`}
 const list=path.join(directory,'speakers-'+randomUUID()+'.ffconcat');await writeFile(list,concat,{flag:'wx',mode:0o600});
 try{
  const frames=Math.round(duration*RATE);
  const args=['-hide_banner','-loglevel','error','-nostdin','-f','concat','-safe','0','-protocol_whitelist','file,pipe','-i',list,
   '-af',`asetpts=PTS+${track.parts[0].start.toFixed(9)}/TB,aresample=${RATE}:async=1000:first_pts=0,apad=whole_len=${frames},atrim=end_sample=${frames}`,'-ac','1','-ar',String(RATE),'-f','f32le','pipe:1'];
  const child=spawn(ffmpeg,args,{stdio:['ignore','pipe','pipe'],windowsHide:true});
  const abort=()=>child.kill();signal?.addEventListener('abort',abort,{once:true});
  const state={sum:0,count:0,out:[]},binFrames=Math.round(bin*RATE);let rest=Buffer.alloc(0),errors='';
  child.stderr.on('data',b=>{errors=(errors+b).slice(-2000)});
  child.stdout.on('data',chunk=>{const data=rest.length?Buffer.concat([rest,chunk]):chunk;const usable=data.length-data.length%4;binsFromSamples(new Float32Array(data.buffer.slice(data.byteOffset,data.byteOffset+usable)),state,binFrames);rest=Buffer.from(data.subarray(usable))});
  const code=await new Promise((resolve,reject)=>{child.on('error',reject);child.on('close',resolve)});
  signal?.removeEventListener('abort',abort);if(signal?.aborted)throw audioError('CANCELLED');
  if(code!==0)throw Object.assign(audioError('AUDIO_TOOL_FAILED'),{detail:errors});
  return state.out;
 }finally{await unlink(list).catch(()=>{})}
}
export async function speakerProfile(source,{ffmpeg='ffmpeg',directory,signal,bin=0.5}={}){
 if(source?.kind!=='native'||!Array.isArray(source.tracks))return null;
 const mic=source.tracks.find(t=>t.id==='mic'),system=source.tracks.find(t=>t.id==='system');
 if(!mic||!system||!(source.duration>0)||source.duration>30*86400)return null;
 const [a,b]=await Promise.all([trackProfile(mic,{ffmpeg,directory,signal,bin,duration:source.duration}),trackProfile(system,{ffmpeg,directory,signal,bin,duration:source.duration})]);
 return {bin,tracks:{mic:a,system:b}};
}
