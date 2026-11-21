// A light «spectral waveform» for the player: loudness per slice of time, coloured by how bright
// the sound is. Audio is decoded once by FFmpeg to 8 kHz mono (≈100× faster than real time) and
// streamed through: nothing large is held in memory, so hours of audio are fine.
//   peak       — RMS of the slice, scaled for visibility (0…1)
//   brightness — zero-crossing rate of the slice: low for vowels and hum, high for sibilants and
//                hiss (0…1). A cheap, well-known proxy for spectral centroid.
import {spawn} from 'node:child_process';import {createReadStream} from 'node:fs';

const RATE=8000,BLOCK=400; // 50 ms blocks

export function binsFrom(blocks,bins){
 const out={peaks:[],brightness:[]};if(!blocks.rms.length)return out;
 const n=Math.max(1,Math.min(bins,blocks.rms.length)),step=blocks.rms.length/n;let max=0;
 for(let i=0;i<n;i++){
  const from=Math.floor(i*step),to=Math.max(from+1,Math.floor((i+1)*step));let energy=0,zcr=0,weight=0;
  for(let j=from;j<to;j++){const r=blocks.rms[j];energy+=r*r;zcr+=blocks.zcr[j]*r;weight+=r}
  const rms=Math.sqrt(energy/(to-from));out.peaks.push(rms);out.brightness.push(weight>0?zcr/weight:0);max=Math.max(max,rms);
 }
 // sqrt keeps quiet speech visible next to loud passages; brightness 0.3 crossings/sample ≈ full.
 out.peaks=out.peaks.map(value=>max>0?Number(Math.sqrt(value/max).toFixed(3)):0);
 out.brightness=out.brightness.map(value=>Number(Math.min(1,value/.3).toFixed(3)));
 return out;
}

export async function computePeaks(files,{ffmpeg='ffmpeg',bins=720,signal,timeoutMs=20*60e3}={}){
 const blocks={rms:[],zcr:[]};let carry=Buffer.alloc(0),energy=0,crossings=0,count=0,previous=0,total=0;
 const flush=()=>{if(!count)return;blocks.rms.push(Math.sqrt(energy/count)/32768);blocks.zcr.push(crossings/count);energy=0;crossings=0;count=0};
 await new Promise((resolve,reject)=>{
  const child=spawn(ffmpeg,['-hide_banner','-nostdin','-v','error','-i','pipe:0','-map','0:a:0','-ac','1','-ar',String(RATE),'-f','s16le','pipe:1'],{windowsHide:true,stdio:['pipe','pipe','pipe']});
  let settled=false,error='';const done=failure=>{if(settled)return;settled=true;clearTimeout(timer);signal?.removeEventListener('abort',abort);failure?reject(failure):resolve()};
  const abort=()=>{child.kill('SIGKILL');done(Object.assign(new Error('Отменено'),{code:'CANCELLED'}))};signal?.addEventListener('abort',abort,{once:true});
  const timer=setTimeout(()=>{child.kill('SIGKILL');done(Object.assign(new Error('Волна не построена вовремя'),{code:'AUDIO_TIMEOUT'}))},timeoutMs);
  child.stderr.setEncoding('utf8');child.stderr.on('data',text=>{error=(error+text).slice(-2000)});
  child.stdout.on('data',part=>{
   const bytes=carry.length?Buffer.concat([carry,part]):part,end=bytes.length-bytes.length%2;
   for(let offset=0;offset<end;offset+=2){const value=bytes.readInt16LE(offset);energy+=value*value;if((value>=0)!==(previous>=0))crossings++;previous=value;count++;total++;if(count===BLOCK)flush()}
   carry=Buffer.from(bytes.subarray(end));
  });
  child.on('error',()=>done(Object.assign(new Error('FFmpeg недоступен'),{code:'AUDIO_TOOL_UNAVAILABLE'})));
  child.on('close',code=>{flush();code===0?done():done(Object.assign(new Error('Не удалось прочитать звук'),{code:'AUDIO_PROCESS_FAILED',detail:error}))});
  // A record may be several files of one stream (window recordings are written in parts).
  (async()=>{try{for(const file of files){for await(const chunk of createReadStream(file))if(!child.stdin.write(chunk))await new Promise(r=>child.stdin.once('drain',r))}child.stdin.end()}catch{child.stdin.destroy()}})();
  child.stdin.on('error',()=>{});
 });
 return {duration:total/RATE,...binsFrom(blocks,bins)};
}
