import test from 'node:test';import assert from 'node:assert/strict';import {spawn} from 'node:child_process';import {mkdtemp,rm} from 'node:fs/promises';import {tmpdir} from 'node:os';import path from 'node:path';import net from 'node:net';import {once} from 'node:events';
async function start(t){
 const temp=await mkdtemp(path.join(tmpdir(),'mono-local-')),s=net.createServer();s.listen(0,'127.0.0.1');await once(s,'listening');const port=s.address().port;await new Promise(r=>s.close(r));
 const child=spawn(process.execPath,['server.mjs'],{env:{...process.env,PORT:String(port),MONO_DATA_DIR:temp,GROQ_API_KEY:'',GROQ_API_KEY_FILE:''},stdio:['ignore','pipe','pipe']});
 t.after(async()=>{if(child.exitCode===null){child.kill('SIGKILL');await once(child,'exit')}await rm(temp,{recursive:true,force:true})});
 await new Promise((resolve,reject)=>{let text='';child.stdout.on('data',b=>{text+=b;if(text.includes('"event":"listening"'))resolve()});child.on('exit',()=>reject(new Error('startup failure')))});
 return 'http://127.0.0.1:'+port;
}
test('desktop session and CSRF gates reject foreign reads and mutations at the real HTTP boundary',async t=>{
 const url=await start(t);
 assert.equal((await fetch(url+'/api/local/status')).status,401);
 assert.equal((await fetch(url+'/api/local/session',{headers:{Origin:'https://foreign.test','Sec-Fetch-Site':'cross-site'}})).status,403);
 const bootstrap=await fetch(url+'/api/local/session');assert.equal(bootstrap.status,200);
 const cookie=bootstrap.headers.get('set-cookie').split(';')[0],session=await bootstrap.json();assert.ok(session.csrf.length>=32);
 assert.match(bootstrap.headers.get('set-cookie'),/HttpOnly/);assert.match(bootstrap.headers.get('set-cookie'),/SameSite=Strict/);
 assert.equal((await fetch(url+'/api/local/status',{headers:{Cookie:cookie}})).status,200);
 assert.equal((await fetch(url+'/api/local/ping',{method:'POST',headers:{Cookie:cookie,'Content-Type':'application/json'},body:'{}'})).status,403);
 const good=await fetch(url+'/api/local/ping',{method:'POST',headers:{Cookie:cookie,Origin:url,'X-Mono-CSRF':session.csrf,'Content-Type':'application/json'},body:'{}'});
 assert.equal(good.status,200);assert.equal((await good.json()).protocol,1);
 assert.equal((await fetch(url+'/api/local/status',{headers:{Cookie:cookie,Origin:'https://foreign.test'}})).status,403);
 const id='00000000-0000-4000-8000-000000000001';
 const protectedRoutes=[['POST','/api/jobs'],['GET','/api/jobs/by-key/private_lookup_key'],['GET','/api/jobs/'+id],['GET','/api/jobs/'+id+'/result'],['POST','/api/jobs/'+id+'/retry'],['POST','/api/jobs/'+id+'/cancel'],['POST','/api/jobs/'+id+'/ack'],['DELETE','/api/jobs/'+id],['GET','/api/metrics'],['GET','/api/%6aobs/'+id],['GET','/api/jobs%2f'+id]];
 for(const [method,route] of protectedRoutes){
  assert.equal((await fetch(url+route,{method})).status,401,method+' '+route+' is private');
  assert.equal((await fetch(url+route,{method,headers:{Cookie:cookie,Origin:'https://foreign.test','X-Mono-CSRF':session.csrf}})).status,403,'Foreign origin '+route);
  if(!['GET','HEAD'].includes(method))assert.equal((await fetch(url+route,{method,headers:{Cookie:cookie,Origin:url}})).status,403,'Missing CSRF '+route);
 }
 assert.equal((await fetch(url+'/api/jobs/'+id,{headers:{Cookie:cookie}})).status,404,'Authorized missing job retains404 contract');
 assert.equal((await fetch(url+'/api/metrics',{headers:{Cookie:cookie}})).status,200);
});
