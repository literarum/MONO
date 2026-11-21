import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn,spawnSync} from 'node:child_process';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import net from 'node:net';
import http from 'node:http';
import {fileURLToPath} from 'node:url';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const delay=ms=>new Promise(r=>setTimeout(r,ms));
async function freePort(){
 const s=net.createServer();
 await new Promise(r=>s.listen(0,'127.0.0.1',r));
 const p=s.address().port;
 await new Promise(r=>s.close(r));return p;
}
async function request(url,headers={}){
 return await new Promise((resolve,reject)=>{
  const req=http.get(url,{headers},res=>{
   const bufs=[];res.on('data',b=>bufs.push(b));
   res.on('end',()=>{
     const raw=Buffer.concat(bufs).toString('utf8');
     let body;try{body=JSON.parse(raw)}catch{body=raw}
     resolve({status:res.statusCode,body});
   });
  });
  req.on('error',reject);
 });
}
async function getReady(url,headers){
 for(let i=0;i<60;i++){
  try{const r=await request(url+'/api/health',headers);return r}catch{}
  await delay(100);
 }
 throw new Error('Server failed to bind');
}
test('local deployment fails closed on remote bind and invalid configuration', async ()=>{
 for(const env of [
  {MONO_DEPLOY_MODE:'local',MONO_HOST:'0.0.0.0'},
  {MONO_DEPLOY_MODE:'proxy',MONO_HOST:'0.0.0.0',MONO_PUBLIC_ORIGIN:'http://unsafe.test'},
  {MONO_DEPLOY_MODE:'proxy',MONO_HOST:'0.0.0.0',MONO_PUBLIC_ORIGIN:'https://mono.example.test',MONO_PROXY_SECRET:'weak'},
  {MONO_MAX_UPLOAD_BYTES:'NaN'}
 ]){
  const child=spawn(process.execPath,['server.mjs'],{cwd:root,env:{...process.env,...env},stdio:'ignore'});
  const exited=await Promise.race([new Promise(r=>child.on('exit',code=>r(code))),delay(3500).then(()=>null)]);
  if(exited===null)child.kill('SIGKILL');
  assert.notEqual(exited,null,'Invalid config should exit immediately');
  assert.notEqual(exited,0,'Invalid config cannot succeed');
 }
});
test('proxy secret, Host and Origin gates protect both UI and API; health, metrics and graceful host shutdown', {timeout:20000},async t=>{
 const tmp=await mkdtemp(path.join(tmpdir(),'mono-proxy-'));
 const port=await freePort(),secret='0123456789abcdefghijklmnopqrstuvwxyz-secret';
 const secretFile=path.join(tmp,'proxy_secret'),keyFile=path.join(tmp,'groq_key');
 await writeFile(secretFile,secret);
 await writeFile(keyFile,'fake-for-test');
 const env={...process.env,PORT:String(port),MONO_DATA_DIR:tmp,MONO_DEPLOY_MODE:'proxy',
  MONO_HOST:'127.0.0.1',MONO_PUBLIC_ORIGIN:'https://mono.example.test',
  MONO_PROXY_SECRET_FILE:secretFile,GROQ_API_KEY_FILE:keyFile,MONO_LAUNCHER:'1'};
 const child=spawn(process.execPath,['server.mjs'],{cwd:root,env,stdio:['pipe','ignore','ignore']});
 t.after(async()=>{if(child.exitCode===null)child.kill('SIGKILL');await rm(tmp,{recursive:true,force:true})});
 const url='http://127.0.0.1:'+port;
 const good={'Host':'mono.example.test','X-Mono-Proxy-Secret':secret,'Origin':'https://mono.example.test'};
 assert.equal((await getReady(url,good)).status,200);
 assert.equal((await request(url+'/api/health',{Host:'mono.example.test'})).status,403);
 assert.equal((await request(url+'/',{Host:'mono.example.test'})).status,403);
 const shell=await request(url+'/',good);
 assert.equal(shell.status,200);
 assert(shell.body.includes('MONO'));
 assert.equal((await request(url+'/api/health',{...good,Origin:'https://evil.example.test'})).status,403);
 assert.equal((await request(url+'/api/health',{...good,Host:'evil.example.test'})).status,403);
 const check=spawnSync(process.execPath,['healthcheck.mjs'],{cwd:root,env,timeout:6000});
 assert.equal(check.status,0,'Container healthcheck must send proxy credentials');
 const health=(await request(url+'/api/ready',good)).body;
 assert.equal(health.ready,true);
 assert.equal(health.mode,'proxy');
 const metrics=(await request(url+'/api/metrics',good)).body;
 assert(metrics.requests>=5);
 assert.equal((await request(url+'/nope/%ZZ',good)).status,400);
 // Windows kill(SIGTERM) is an unconditional termination, not a deliverable POSIX
 // signal. Exercise the same graceful EOF channel the production supervisor uses.
 if(process.platform==='win32')child.stdin.end();else child.kill('SIGTERM');
 const code=await Promise.race([new Promise(resolve=>child.on('exit',resolve)),delay(5000).then(()=>null)]);
 assert.equal(code,0,'Supported graceful shutdown channel should drain and exit cleanly');
});
