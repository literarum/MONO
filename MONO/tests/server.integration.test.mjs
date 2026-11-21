import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {mkdtemp,readFile,readdir,rm} from 'node:fs/promises';
import {spawn,spawnSync} from 'node:child_process';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {once} from 'node:events';
import {fileURLToPath} from 'node:url';

const here=path.dirname(fileURLToPath(import.meta.url));
const root=path.resolve(here,'..');
const delay=ms=>new Promise(r=>setTimeout(r,ms));
async function serverStart(server){server.listen(0,'127.0.0.1');await once(server,'listening');return server.address().port}
async function awaitHealth(url){
 for(let i=0;i<80;i++){
  // FFmpeg detection is asynchronous; ask the server to answer once it has finished.
  try{const res=await fetch(url+'/api/health?wait=tools');if(res.ok)return await res.json()}catch{}
  await delay(100);
 }
 throw new Error('Server did not start');
}
async function waitDone(url,id,headers){
 for(let i=0;i<110;i++){
  const res=await fetch(url+'/api/jobs/'+id,{headers});
  if(res.ok){
   const job=await res.json();
   if(['completed','failed','cancelled'].includes(job.status))return job;
  }
  await delay(120);
 }
 throw new Error('Job timeout');
}
async function sessionHeaders(url){const response=await fetch(url+'/api/local/session');assert.equal(response.status,200);return {Cookie:response.headers.get('set-cookie').split(';')[0],Origin:url,'X-Mono-CSRF':(await response.json()).csrf}}
test('real FFmpeg + HTTP stub: retry, billing, idempotency, recovery lookup, ack cleanup, and upload limits', {timeout:40000},async t=>{
 const temp=await mkdtemp(path.join(tmpdir(),'mono-int-'));
 const responses={calls:0,parameters:[]};
 const stub=http.createServer(async(req,res)=>{
  const chunks=[];for await(const part of req)chunks.push(part);
  const body=Buffer.concat(chunks).toString('utf8');
  responses.calls++;
  responses.parameters.push({
   auth:req.headers.authorization,
   hasLanguage:body.includes('name="language"')&&body.includes('ru'),
   hasModel:body.includes('whisper-large-v3-turbo'),
   hasVerbose:body.includes('verbose_json'),
   hasRussianPrompt:body.includes('Проверка кириллицы')
  });
  if(responses.calls===1){
    res.writeHead(429,{'Content-Type':'application/json','Retry-After':'0.05'});
    res.end(JSON.stringify({error:'rate limited'}));return;
  }
  res.writeHead(200,{'Content-Type':'application/json'});
  res.end(JSON.stringify({text:'Привет проверка',segments:[{start:0,end:0.9,text:'Привет проверка'}]}));
 });
 const stubPort=await serverStart(stub);
 const service=http.createServer();const nodePort=await serverStart(service);service.close();await once(service,'close');
 const env={...process.env,PORT:String(nodePort),MONO_DATA_DIR:temp,
  GROQ_API_KEY:'stub-only-test-key',MONO_GROQ_ENDPOINT:`http://127.0.0.1:${stubPort}/transcribe`,
  MONO_MAX_UPLOAD_BYTES:'100000'};
 const child=spawn(process.execPath,['server.mjs'],{cwd:root,env,stdio:'ignore'});
 t.after(async()=>{child.kill('SIGKILL');stub.close();await rm(temp,{recursive:true,force:true})});
 const url=`http://127.0.0.1:${nodePort}`;
 const health=await awaitHealth(url);
 assert(health.ffmpeg&&health.ffprobe&&health.groq);
 const wav=path.join(temp,'audio.wav');
 const ff=spawnSync('ffmpeg',['-hide_banner','-loglevel','error','-f','lavfi','-i','sine=frequency=400:duration=1.1',
 '-ar','16000','-ac','1','-c:a','pcm_s16le',wav],{timeout:12000});
 assert.equal(ff.status,0,ff.stderr?.toString());
 const data=await readFile(wav);
 const key='recovery_integration_2026';
 const auth=await sessionHeaders(url),headers={...auth,'Content-Type':'audio/wav','X-Client-Task-Key':key,'X-Transcription-Prompt':encodeURIComponent('Проверка кириллицы')};
 const submit=await fetch(url+'/api/jobs?profile=cautious',{method:'POST',headers,body:data});
 assert.equal(submit.status,202);
 const output=await submit.json();
 const lookup=await fetch(url+'/api/jobs/by-key/'+key,{headers:auth});
 assert.equal(lookup.status,200);
 assert.equal((await lookup.json()).id,output.id);
 const same=await fetch(url+'/api/jobs?profile=cautious',{method:'POST',headers,body:data});
 assert.equal(same.status,200);
 assert.equal((await same.json()).id,output.id);
 const finished=await waitDone(url,output.id,auth);
 assert.equal(finished.status,'completed',JSON.stringify(finished));
 assert.equal(finished.completed,1);
 assert.equal(finished.attempts,2);
 assert(finished.estimatedUSD>=2*.04*10/3600);
 assert.equal(responses.calls,2);
 assert(responses.parameters.every(p=>p.auth==='Bearer stub-only-test-key'&&p.hasLanguage&&p.hasModel&&p.hasVerbose&&p.hasRussianPrompt));
 const result=await fetch(url+'/api/jobs/'+output.id+'/result',{headers:auth});
 assert.equal(result.status,200);
 assert.deepEqual((await result.json()).segments.map(s=>s.text),['Привет проверка']);
 const ack=await fetch(url+'/api/jobs/'+output.id+'/ack',{method:'POST',headers:auth});
 assert.equal(ack.status,200);
 assert.equal((await fetch(url+'/api/jobs/'+output.id,{headers:auth})).status,404);
 assert.deepEqual(await readdir(path.join(temp,'audio')),[]);
 assert.deepEqual(await readdir(path.join(temp,'segments')),[]);
 assert.deepEqual(await readdir(path.join(temp,'jobs')),[]);
 const oversized=await fetch(url+'/api/jobs',{method:'POST',
    headers:{...headers,'X-Client-Task-Key':'oversized_int_test2026'},body:Buffer.alloc(100001)});
 assert.equal(oversized.status,413);
});

test('crash restart resumes cached segment without a second provider charge', {timeout:25000},async t=>{
 const temp=await mkdtemp(path.join(tmpdir(),'mono-restart-'));
 const folders=['jobs','audio','segments'];
 const {mkdir,writeFile}=await import('node:fs/promises');
 for(const name of folders)await mkdir(path.join(temp,name));
 const id='aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa';
 const wav=path.join(temp,'audio',id+'.wav');
 const ff=spawnSync('ffmpeg',['-hide_banner','-loglevel','error','-f','lavfi','-i',
  'sine=frequency=500:duration=1.2','-ar','16000','-ac','1',wav],{timeout:12000});
 assert.equal(ff.status,0);
 const job={id,clientKey:'cached_restart_test',createdAt:new Date().toISOString(),
  status:'processing',profile:'cautious',prompt:'',audioPath:wav,completed:0,total:1,
  attempts:1,estimatedUSD:.04*10/3600,received:0,cancelRequested:false};
 await writeFile(path.join(temp,'jobs',id+'.json'),JSON.stringify(job));
 await writeFile(path.join(temp,'segments',id+'-0.json'),
  JSON.stringify({text:'Не повторять запрос',segments:[{start:0,end:1.0,text:'Не повторять запрос'}]}));
 const placeholder=http.createServer();
 const port=await serverStart(placeholder);placeholder.close();await once(placeholder,'close');
 const child=spawn(process.execPath,['server.mjs'],{cwd:root,env:{
  ...process.env,PORT:String(port),MONO_DATA_DIR:temp,
  GROQ_API_KEY:'fake-restart-key',MONO_GROQ_ENDPOINT:'http://127.0.0.1:1/should-not-be-called'
 },stdio:'ignore'});
 t.after(async()=>{child.kill('SIGKILL');await rm(temp,{recursive:true,force:true})});
 const url=`http://127.0.0.1:${port}`;
 await awaitHealth(url);
 const auth=await sessionHeaders(url),final=await waitDone(url,id,auth);
 assert.equal(final.status,'completed',JSON.stringify(final));
 assert.equal(final.attempts,1); // no duplicate billing attempt
 assert.equal(final.completed,1);
 const result=await fetch(url+'/api/jobs/'+id+'/result',{headers:auth});
 assert.equal((await result.json()).text,'Не повторять запрос');
 assert.equal((await fetch(url+'/api/jobs/'+id+'/ack',{method:'POST',headers:auth})).status,200);
 assert.deepEqual(await readdir(path.join(temp,'jobs')),[]);
});
