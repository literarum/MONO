import {spawn} from 'node:child_process';import {mkdtemp,rm} from 'node:fs/promises';import {tmpdir} from 'node:os';import path from 'node:path';import net from 'node:net';import {once} from 'node:events';import {fileURLToPath} from 'node:url';
export async function localServer(t,extraEnv={}){
 const root=await mkdtemp(path.join(tmpdir(),'mono-consumer-')),listener=net.createServer();listener.listen(0,'127.0.0.1');await once(listener,'listening');const port=listener.address().port;await new Promise(r=>listener.close(r));let child,logs='';
 const url='http://127.0.0.1:'+port;
 // A signal-terminated child has exitCode=null and a non-null signalCode.
 // Teardown may run both in start()'s catch and in the test's after hook.
 const stop=async()=>{if(!child||child.exitCode!==null||child.signalCode!==null)return;child.stdin.end();const timer=setTimeout(()=>child.kill('SIGKILL'),8000);await once(child,'exit');clearTimeout(timer)};
 const start=async()=>{
  child=spawn(process.execPath,['server.mjs'],{env:{...process.env,PORT:String(port),MONO_DATA_DIR:path.join(root,'server'),MONO_CONFIG_DIR:path.join(root,'config'),MONO_DEFAULT_LIBRARY_ROOT:path.join(root,'library'),MONO_LAUNCHER:'1',MONO_CORE_EXECUTABLE:'python',MONO_CORE_PACKAGED:'0',MONO_CORE_SCRIPT:fileURLToPath(new URL('../../launcher/local_core/worker.py',import.meta.url)),MONO_STARTUP_TRACE:'1',GROQ_API_KEY:'',GROQ_API_KEY_FILE:'',...extraEnv},stdio:['pipe','pipe','pipe']});
  for(const stream of [child.stdout,child.stderr])stream.on('data',data=>{logs=(logs+data.toString('utf8')).slice(-500000)});
  const started=performance.now();
  try{await new Promise((resolve,reject)=>{let data='';const timer=setTimeout(()=>reject(new Error('Server startup timeout')),10000);child.stdout.on('data',b=>{data+=b;if(data.includes('"event":"listening"')){clearTimeout(timer);resolve()}});child.on('error',reject);child.on('exit',()=>{clearTimeout(timer);reject(new Error('Server exited before ready'))})})}
  catch(error){
   const elapsedMs=Math.round(performance.now()-started),cleanupStarted=performance.now();
   const allowed=new Set(['worker.begin','worker.end','imports.ready','runtime.ffmpeg.begin','runtime.ffmpeg.end','runtime.ffprobe.begin','runtime.ffprobe.end','directories.begin','directories.end','vault.begin','vault.end','recovery.begin','recovery.end','listening']);
   const phasesAtFailure=logs.split('\n').filter(line=>line.startsWith('{"event":"startup_phase",')).flatMap(line=>{try{const row=JSON.parse(line);return allowed.has(row.phase)&&Number.isSafeInteger(row.ms)&&row.ms>=0?[{phase:row.phase,ms:row.ms}]:[]}catch{return []}}).slice(-20);
   // Stop this private child before collecting its final diagnostic trace.
   // Success deadline, ready packet and teardown deadline stay unchanged.
   try{await stop()}catch(cleanup){throw new AggregateError([error,cleanup],'Private server startup and shutdown failed')}
   const trace=logs.split('\n').filter(line=>line.startsWith('MONO_STARTUP_TRACE ')).map(line=>line.slice('MONO_STARTUP_TRACE '.length)).slice(-1);
   error.message+='; diagnostics '+JSON.stringify({deadlineMs:10000,elapsedMs,cleanupMs:Math.round(performance.now()-cleanupStarted),pid:child.pid,exitCode:child.exitCode,signalCode:child.signalCode,outputChars:logs.length,phasesAtFailure,trace});throw error;
  }
 };
 const session=async()=>{const r=await fetch(url+'/api/local/session');const d=await r.json();return {Cookie:r.headers.get('set-cookie').split(';')[0],Origin:url,'X-Mono-CSRF':d.csrf}};
 t.after(async()=>{await stop();await rm(root,{recursive:true,force:true,maxRetries:10,retryDelay:50})});await start();return {root,url,session,logs:()=>logs,restart:async()=>{await stop();await start()},stop,start};
}
export function wavFixture(){
 const b=Buffer.alloc(44+1600*2);b.write('RIFF');b.writeUInt32LE(b.length-8,4);b.write('WAVE',8);b.write('fmt ',12);b.writeUInt32LE(16,16);b.writeUInt16LE(1,20);b.writeUInt16LE(1,22);b.writeUInt32LE(16000,24);b.writeUInt32LE(32000,28);b.writeUInt16LE(2,32);b.writeUInt16LE(16,34);b.write('data',36);b.writeUInt32LE(3200,40);for(let i=0;i<1600;i++)b.writeInt16LE(Math.round(1000*Math.sin(2*Math.PI*440*i/16000)),44+i*2);return b;
}
