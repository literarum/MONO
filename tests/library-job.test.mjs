import test from 'node:test';import assert from 'node:assert/strict';import http from 'node:http';import {once} from 'node:events';import {readFile,readdir} from 'node:fs/promises';import path from 'node:path';import {localServer,wavFixture} from './helpers/local-server.mjs';
import {LibraryClient} from '../public/library-client.js';
test('local file submission reaches real FFmpeg without browser audio reupload and ACK preserves source',async t=>{
 let providerCalls=0;const stub=http.createServer(async(req,res)=>{for await(const part of req){}providerCalls++;res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({text:'Проверка результата',segments:[{start:0,end:.1,text:'Проверка результата'}]}))});
 stub.listen(0,'127.0.0.1');await once(stub,'listening');t.after(()=>{stub.closeAllConnections();stub.close()});
 const server=await localServer(t,{GROQ_API_KEY:'fixture-only',MONO_GROQ_ENDPOINT:`http://127.0.0.1:${stub.address().port}/transcribe`}),headers=await server.session();
 await fetch(server.url+'/api/local/library/configure',{method:'POST',headers,body:JSON.stringify({useDefault:true})});
 const data=wavFixture(),imported=await fetch(server.url+'/api/local/records/import',{method:'POST',headers:{...headers,'X-Mono-Record':encodeURIComponent(JSON.stringify({title:'Локальный исходник',mime:'audio/wav',duration:.1}))},body:data});const r=await imported.json();
 const endpoint=server.url+`/api/local/records/${r.id}/transcribe`,options={method:'POST',headers,body:JSON.stringify({clientKey:r.id,profile:'cautious',prompt:'Проверка'})};
 const submitted=await fetch(endpoint,options);assert.equal(submitted.status,202);const job=await submitted.json();
 const duplicate=await fetch(endpoint,options);assert.equal((await duplicate.json()).id,job.id);
 let result;
 for(let i=0;i<100;i++){const response=await fetch(server.url+'/api/jobs/'+job.id,{headers});result=await response.json();if(['completed','failed'].includes(result.status))break;await new Promise(r=>setTimeout(r,100))}
 assert.equal(result.status,'completed',result.error);assert.equal(providerCalls,1);
 const denied=await fetch(server.url+'/api/jobs/'+job.id+'/result');assert.equal(denied.status,401);assert.ok(!(await denied.text()).includes('Проверка результата'));
 assert.equal((await fetch(server.url+'/api/jobs/'+job.id+'/ack',{method:'POST',headers:{Cookie:headers.Cookie,Origin:server.url}})).status,403);
 let cookie=headers.Cookie,bootstraps=0;const client=new LibraryClient({fetch:async(route,options={})=>{if(route.endsWith('/session'))bootstraps++;const h=new Headers(options.headers);h.set('Cookie',cookie);h.set('Origin',server.url);const response=await fetch(server.url+route,{...options,headers:h});if(response.headers.get('set-cookie'))cookie=response.headers.get('set-cookie').split(';')[0];return response}});await client.init();
 assert.equal((await client.jobRequest('/api/jobs/'+job.id)).status,200);assert.throws(()=>client.jobRequest('https://foreign.test/api/jobs/'+job.id),e=>e.code==='INVALID_ROUTE');
 await server.restart();const recovered=await client.jobRequest('/api/jobs/'+job.id);assert.equal((await recovered.json()).status,'completed');assert.equal(bootstraps,2,'one shared renewal after server restart');assert.equal(providerCalls,1);
 assert.deepEqual(await readdir(path.join(server.root,'server','audio')),[],'single immutable source must not be copied to upload spool');
 const payload=await client.jobRequest('/api/jobs/'+job.id+'/result');assert.equal((await payload.json()).text,'Проверка результата');
 const ack=await client.jobRequest('/api/jobs/'+job.id+'/ack',{method:'POST'});assert.ok(ack.ok);
 const missing=await client.jobRequest('/api/jobs/'+job.id);assert.equal(missing.status,404,'queue UI retains the missing-job response');
 const source=await readFile(path.join(server.root,'library','records',r.id,'original','original','000000.part'));assert.deepEqual(source,data);
 const media=await client.request(`/records/${r.id}/audio`);assert.deepEqual(Buffer.from(await media.arrayBuffer()),data);
});
