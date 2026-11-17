import test from 'node:test';import assert from 'node:assert/strict';import http from 'node:http';import {once} from 'node:events';import {mkdtemp,readFile,rm,mkdir,writeFile} from 'node:fs/promises';import {tmpdir} from 'node:os';import path from 'node:path';
import {WorkerClient} from '../backend/local/worker-client.mjs';
let KeyManager;try{({KeyManager}=await import('../backend/groq/key-manager.mjs'))}catch{}
const CANARY='gsk_'+('MonoKeyCanary83'.repeat(4));
async function context(t){
 assert.ok(KeyManager,'Runtime key manager is missing');const root=await mkdtemp(path.join(tmpdir(),'mono-key-'));const old={MONO_CONFIG_DIR:process.env.MONO_CONFIG_DIR,MONO_CORE_SCRIPT:process.env.MONO_CORE_SCRIPT,MONO_CORE_PACKAGED:process.env.MONO_CORE_PACKAGED};
 process.env.MONO_CONFIG_DIR=path.join(root,'config');delete process.env.MONO_CORE_SCRIPT;process.env.MONO_CORE_PACKAGED='0';
 let status=200,delay=0,errorCode;const requests=[];const server=http.createServer(async(req,res)=>{requests.push({method:req.method,url:req.url,authorization:req.headers.authorization});if(delay)await new Promise(r=>setTimeout(r,delay));res.writeHead(status,{'Content-Type':'application/json'});res.end(JSON.stringify(status===200?{data:[{id:'whisper-large-v3-turbo'}]}:{error:{message:CANARY,code:errorCode}}))});server.listen(0,'127.0.0.1');await once(server,'listening');
 let worker=new WorkerClient();const options=()=>({worker,endpoint:`http://127.0.0.1:${server.address().port}/openai/v1/models`});
 t.after(async()=>{await worker.close();await new Promise(r=>server.close(r));await rm(root,{recursive:true,force:true,maxRetries:10,retryDelay:50});for(const [k,v] of Object.entries(old))if(v===undefined)delete process.env[k];else process.env[k]=v});
 return {root,requests,options,setStatus:value=>status=value,setErrorCode:value=>errorCode=value,setDelay:value=>delay=value,restart:async()=>{await worker.close();worker=new WorkerClient()}};
}
test('verified key reaches real user vault, survives worker restart and never enters public status or plaintext',async t=>{
 const c=await context(t);let manager=new KeyManager(c.options());assert.equal((await manager.status()).configured,false);
 const saved=await manager.configure(CANARY);assert.equal(saved.configured,true);assert.equal(saved.verified,true);assert.equal(saved.managed,false);assert.ok(!JSON.stringify(saved).includes(CANARY));assert.equal(await manager.getKey(),CANARY);assert.deepEqual(c.requests.map(r=>[r.method,r.url]),[['GET','/openai/v1/models']]);
 assert.equal(c.requests[0].authorization,'Bearer '+CANARY);if(process.platform==='win32')assert.ok(!(await readFile(path.join(c.root,'config/groq.dpapi'))).includes(Buffer.from(CANARY)));
 await c.restart();manager=new KeyManager(c.options());assert.equal((await manager.status()).configured,true);assert.equal(await manager.getKey(),CANARY);await manager.delete();assert.equal((await manager.status()).configured,false);await assert.rejects(manager.getKey(),error=>error.code==='KEY_NOT_CONFIGURED');
});
test('provider rejection, timeout, cancellation and double click never store or expose a key',async t=>{
 const c=await context(t);let manager=new KeyManager(c.options());
 for(const [status,code] of [[401,'INVALID_KEY'],[403,'KEY_FORBIDDEN'],[429,'RATE_LIMITED'],[500,'PROVIDER_UNAVAILABLE']]){c.setStatus(status);await assert.rejects(manager.configure(CANARY),error=>error.code===code&&!error.message.includes(CANARY));assert.equal((await manager.status()).configured,false)}
 manager=new KeyManager({...c.options(),timeoutMs:60});c.setStatus(200);c.setDelay(200);const pending=manager.configure(CANARY);await assert.rejects(manager.configure(CANARY),e=>e.code==='KEY_BUSY');await assert.rejects(pending,e=>e.code==='KEY_TIMEOUT');assert.equal((await manager.status()).configured,false);
 const controller=new AbortController();const cancelled=manager.configure(CANARY,{signal:controller.signal});controller.abort();await assert.rejects(cancelled,e=>e.code==='CANCELLED');assert.equal((await manager.status()).configured,false);assert.ok(c.requests.every(r=>r.method==='GET'&&r.url==='/openai/v1/models'));
});
test('quota and connection failures give distinct safe actions and a real OS write failure cannot claim saved',async t=>{
 const c=await context(t);let manager=new KeyManager(c.options());c.setStatus(400);c.setErrorCode('blocked_api_access');await assert.rejects(manager.configure(CANARY),e=>e.code==='BILLING_LIMIT'&&!e.message.includes(CANARY));assert.equal((await manager.status()).configured,false);
 manager=new KeyManager({...c.options(),endpoint:'http://127.0.0.1:1/openai/v1/models'});await assert.rejects(manager.configure(CANARY),e=>e.code==='NETWORK_ERROR');assert.equal((await manager.status()).configured,false);
 if(process.platform==='win32'){
  await mkdir(path.join(c.root,'config/groq.dpapi'),{recursive:true});c.setStatus(200);manager=new KeyManager(c.options());await assert.rejects(manager.configure(CANARY),e=>e.code==='VAULT_UNAVAILABLE');assert.equal((await manager.status()).configured,false);
 }
});
test('externally managed key is compatible and cannot be silently replaced or removed',async t=>{
 const c=await context(t);const manager=new KeyManager({...c.options(),externalKey:CANARY});const status=await manager.status();assert.equal(status.managed,true);assert.equal(status.configured,true);assert.equal(status.verified,false);assert.equal(await manager.getKey(),CANARY);await assert.rejects(manager.configure(CANARY),e=>e.code==='KEY_MANAGED');await assert.rejects(manager.delete(),e=>e.code==='KEY_MANAGED');assert.equal(c.requests.length,0);
});
