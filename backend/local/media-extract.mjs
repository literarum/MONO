// Video of any length → its audio track, so the archive keeps (and transcribes) only the sound.
// The stream is copied without re-encoding when the browser can play it as is (AAC → MP4 audio,
// Opus/Vorbis → WebM audio, MP3 → MP3): fast even for hours of video, and lossless. Any other
// codec is re-encoded to Opus 96 kbit/s, which keeps speech intelligible for recognition.
import {execFile} from 'node:child_process';

export const VIDEO_EXTENSIONS=/\.(mp4|m4v|mov|mkv|webm|avi|wmv|flv|ts|mts|m2ts|3gp|mpg|mpeg|ogv)$/i;
const run=(file,args,timeout)=>new Promise((resolve,reject)=>execFile(file,args,{timeout,windowsHide:true,maxBuffer:4*1024*1024},(error,stdout,stderr)=>error?reject(Object.assign(error,{stderr:String(stderr||'')})):resolve(String(stdout))));

/** First audio stream of a media file: {codec, duration} or null when it has no sound. */
export async function probeAudio(ffprobe,input,{exec=run}={}){
 const out=await exec(ffprobe,['-v','error','-select_streams','a:0','-show_entries','stream=codec_name:format=duration','-of','json',input],60000);
 let value;try{value=JSON.parse(out)}catch{return null}
 const codec=value?.streams?.[0]?.codec_name;if(!codec)return null;
 const duration=Number(value?.format?.duration);return {codec:String(codec),duration:Number.isFinite(duration)&&duration>0?duration:0};
}

/** How the audio is written: container, MIME type and codec arguments. */
export function extractionPlan(codec){
 if(codec==='aac')return {format:'ipod',mime:'audio/mp4',args:['-c:a','copy','-movflags','+faststart']};
 if(codec==='opus'||codec==='vorbis')return {format:'webm',mime:'audio/webm',args:['-c:a','copy']};
 if(codec==='mp3')return {format:'mp3',mime:'audio/mpeg',args:['-c:a','copy']};
 return {format:'webm',mime:'audio/webm',args:['-c:a','libopus','-b:a','96k']};
}

/** Write the first audio track of `input` to `output`. Returns {mime, duration, copied}. */
export async function extractAudio({ffmpeg,ffprobe,input,output,exec=run,timeoutMs=6*3600e3}){
 if(!ffmpeg||!ffprobe){const error=new Error('FFmpeg недоступен: звук из видео извлечь нельзя');error.code='TOOLS_UNAVAILABLE';throw error}
 const audio=await probeAudio(ffprobe,input,{exec});
 if(!audio){const error=new Error('В этом видео нет звуковой дорожки');error.code='NO_AUDIO';throw error}
 const plan=extractionPlan(audio.codec);
 try{await exec(ffmpeg,['-nostdin','-v','error','-y','-i',input,'-map','0:a:0','-vn','-sn','-dn',...plan.args,'-f',plan.format,output],timeoutMs)}
 catch(error){
  if(plan.args.includes('copy')){ // a damaged or unusual stream: re-encode instead of failing
   await exec(ffmpeg,['-nostdin','-v','error','-y','-i',input,'-map','0:a:0','-vn','-sn','-dn','-c:a','libopus','-b:a','96k','-f','webm',output],timeoutMs);
   return {mime:'audio/webm',duration:audio.duration,copied:false};
  }
  const failure=new Error('Не удалось извлечь звук из видео');failure.code='EXTRACT_FAILED';failure.detail=String(error.stderr||'').slice(-300);throw failure;
 }
 return {mime:plan.mime,duration:audio.duration,copied:plan.args.includes('copy')};
}
