import {spawn} from 'node:child_process';
export function audioError(code){const error=new Error(code);error.code=code;return error}
export function runAudio(binary,args,{signal,timeoutMs=900000,maxOutput=1024*1024,onProgress}={}){
 if(signal?.aborted)return Promise.reject(audioError('CANCELLED'));
 return new Promise((resolve,reject)=>{
  const child=spawn(binary,args,{windowsHide:true,stdio:['ignore','pipe','pipe']});let output='',progress='',fault=null,settled=false;
  const abort=()=>{fault=audioError('CANCELLED');child.kill('SIGKILL')};signal?.addEventListener('abort',abort,{once:true});
  const timer=setTimeout(()=>{fault=audioError('AUDIO_TIMEOUT');child.kill('SIGKILL')},timeoutMs);
  const finish=error=>{if(settled)return;settled=true;clearTimeout(timer);signal?.removeEventListener('abort',abort);error?reject(error):resolve(output)};
  child.stdout.setEncoding('utf8');child.stdout.on('data',data=>{
   output=(output+data).slice(-maxOutput);
   if(onProgress){progress+=data;for(let lineEnd;(lineEnd=progress.indexOf('\n'))>=0;){const line=progress.slice(0,lineEnd).trim();progress=progress.slice(lineEnd+1);const match=/^out_time_us=(\d+)$/.exec(line);if(match)onProgress(Number(match[1])/1e6)}if(progress.length>65536)progress=''}
  });
  // Drain diagnostics, but never expose OS paths or user-controlled media text.
  child.stderr.resume();child.on('error',()=>finish(audioError('AUDIO_TOOL_UNAVAILABLE')));child.on('close',code=>finish(fault||(code===0?null:audioError('AUDIO_PROCESS_FAILED'))));
 });
}
