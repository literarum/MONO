import {spawn} from 'node:child_process';
import {lstat} from 'node:fs/promises';
import path from 'node:path';
import {runAudio,audioError} from './process.mjs';
import {getProfile} from './profiles.mjs';
import {DefectMeter} from './defects.mjs';

export const ANALYSIS_VERSION='audio-analysis-2';
const formats='wav,flac,mp3,mov,matroska,webm,ogg,aac';
const inputArgs=input=>['-protocol_whitelist','file,pipe','-format_whitelist',formats,'-i',input];
const number=value=>typeof value==='string'&&value.trim()!==''&&Number.isFinite(Number(value))?Number(value):null;
const db=value=>value>0?20*Math.log10(value):null;

/** Read-only whole-record measurement. PCM is streamed, never retained in RAM. */
export async function analyzeAudio(input,{signal,onProgress,analysisProfile='original',preFilter:customFilter=null,outputRate:customRate=null,ffmpeg='ffmpeg',ffprobe='ffprobe'}={}){
 const preset=getProfile(analysisProfile),preFilter=customFilter??preset.preFilter;
 if(signal?.aborted)throw audioError('CANCELLED');
 if(typeof input!=='string'||!path.isAbsolute(input)||/[\r\n\0]/.test(input))throw audioError('INVALID_AUDIO_INPUT');
 let file;try{file=await lstat(input)}catch{throw audioError('INVALID_AUDIO_INPUT')}
 if(!file.isFile()||file.isSymbolicLink()||file.size<1||file.size>32*1024**3)throw audioError('INVALID_AUDIO_INPUT');
 let probe;try{probe=JSON.parse(await runAudio(ffprobe,['-v','error',...inputArgs(input),'-select_streams','a:0','-show_entries','stream=codec_name,sample_rate,channels,bits_per_sample,bits_per_raw_sample:format=format_name,duration','-of','json'],{signal,timeoutMs:30000,maxOutput:32000}))}catch(error){throw audioError(['CANCELLED','AUDIO_TOOL_UNAVAILABLE','AUDIO_TIMEOUT'].includes(error.code)?error.code:'INVALID_AUDIO_INPUT')}
 const stream=probe.streams?.[0],sampleRate=customRate||(customFilter===null?preset.outputRate:null)||Number(stream?.sample_rate),channels=stream?.channels,estimatedDuration=Number(probe.format?.duration);
 if(!Number.isInteger(sampleRate)||sampleRate<8000||sampleRate>384000||!Number.isInteger(channels)||channels<1||channels>64||!Number.isFinite(estimatedDuration)||estimatedDuration<=0||estimatedDuration>30*86400||typeof stream.codec_name!=='string')throw audioError('INVALID_AUDIO_INPUT');
 const bits=Number(stream.bits_per_raw_sample)||Number(stream.bits_per_sample),integerPCM=/^pcm_[su]\d/.test(stream.codec_name)||stream.codec_name==='flac',clipThreshold=integerPCM&&bits>=8&&bits<=32?1-2**(1-bits):1;
 const defects=new DefectMeter(sampleRate),stride=channels*4,windowFrames=Math.max(1,Math.round(sampleRate*.02));let frames=0,peak=0,energy=0,clippedSamples=0,silentFrames=0,windowEnergy=0,windowCount=0,remainder=Buffer.alloc(0),diagnostics='';
 const finishWindow=()=>{if(windowCount&&Math.sqrt(windowEnergy/(windowCount*channels))<=.001)silentFrames+=windowCount;windowCount=0;windowEnergy=0};
 const args=['-hide_banner','-nostdin','-v','info','-threads','1',...inputArgs(input),'-filter_complex_threads','1','-filter_complex',`[0:a:0]${preFilter?preFilter+',':''}asplit=2[raw][measure];[measure]loudnorm=I=-19:TP=-2:LRA=11:print_format=json[stats]`,'-map','[raw]','-c:a','pcm_f32le','-f','f32le','pipe:1','-map','[stats]','-f','null','-'];
 await new Promise((resolve,reject)=>{
  const child=spawn(ffmpeg,args,{windowsHide:true,stdio:['ignore','pipe','pipe']});let fault=null,settled=false;
  const fail=code=>{if(!fault)fault=audioError(code);child.kill('SIGKILL')},abort=()=>fail('CANCELLED');signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();
  const timer=setTimeout(()=>fail('AUDIO_TIMEOUT'),Math.max(30000,Math.min(7200000,estimatedDuration*1000)));
  const done=error=>{if(settled)return;settled=true;clearTimeout(timer);signal?.removeEventListener('abort',abort);error?reject(error):resolve()};
  child.stderr.setEncoding('utf8');child.stderr.on('data',data=>diagnostics=(diagnostics+data).slice(-65536));
  child.stdout.on('data',part=>{
   if(fault)return;const bytes=remainder.length?Buffer.concat([remainder,part]):part,end=bytes.length-bytes.length%stride;
   for(let offset=0;offset<end;offset+=stride){
    let frameEnergy=0,mono=0;for(let channel=0;channel<channels;channel++){const value=bytes.readFloatLE(offset+channel*4);if(!Number.isFinite(value)){fail('INVALID_AUDIO_SAMPLES');return}peak=Math.max(peak,Math.abs(value));frameEnergy+=value*value;mono+=value;if(Math.abs(value)>=clipThreshold)clippedSamples++}defects.push(mono/channels);
    frames++;energy+=frameEnergy;windowCount++;windowEnergy+=frameEnergy;if(windowCount===windowFrames)finishWindow();if(frames>sampleRate*30*86400){fail('AUDIO_TOO_LONG');return}
   }
   remainder=Buffer.from(bytes.subarray(end));try{onProgress?.(frames/sampleRate)}catch{fail('AUDIO_ANALYSIS_FAILED')}
  });
  child.on('error',()=>done(audioError('AUDIO_TOOL_UNAVAILABLE')));child.on('close',code=>done(fault||(code===0?null:audioError('AUDIO_PROCESS_FAILED'))));
 });
 if(signal?.aborted)throw audioError('CANCELLED');if(remainder.length||!frames||!Number.isFinite(energy))throw audioError('INVALID_AUDIO_SAMPLES');finishWindow();
 const match=/\{\s*"input_i"\s*:[\s\S]*?\}/g;let stats;for(const block of diagnostics.matchAll(match)){try{stats=JSON.parse(block[0])}catch{}}
 if(!stats||!Object.hasOwn(stats,'input_tp')||!Object.hasOwn(stats,'input_thresh'))throw audioError('INVALID_AUDIO_ANALYSIS');
 const duration=frames/sampleRate,integrated=number(stats.input_i),valid=duration>=.4&&integrated!==null;
 return {schema:1,analysisVersion:ANALYSIS_VERSION,duration,frames,sampleRate,channels,format:{codec:stream.codec_name,container:probe.format.format_name},peak:db(peak),rms:db(Math.sqrt(energy/(frames*channels))),truePeak:peak>0?number(stats.input_tp):null,
  clipping:{samples:clippedSamples,fraction:clippedSamples/(frames*channels),threshold:clipThreshold,heuristic:true},silence:{seconds:silentFrames/sampleRate,fraction:silentFrames/frames,thresholdDbFS:-60,windowMs:20,heuristic:true},noiseHeuristic:null,defects:defects.result(),
  loudness:{valid,integrated:valid?integrated:null,range:valid&&duration>=3?number(stats.input_lra):null,threshold:valid?number(stats.input_thresh):null,reason:valid?null:duration<.4?'too-short':'below-gate'}};
}
