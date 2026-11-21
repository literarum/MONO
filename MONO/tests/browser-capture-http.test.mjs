import test from 'node:test';import assert from 'node:assert/strict';
import {localServer,wavFixture} from './helpers/local-server.mjs';

test('browser microphone shares capture ownership, commits real PCM, preserves pause and needs cookie/CSRF',async t=>{
 const server=await localServer(t),headers=await server.session();
 const call=async(route,body)=>{const response=await fetch(server.url+'/api/local/'+route,{method:'POST',headers:{...headers,'Content-Type':'application/json'},body:JSON.stringify(body)});return {http:response.status,data:await response.json()}};
 assert.equal((await call('library/configure',{useDefault:true})).http,200);
 const blocked=await fetch(server.url+'/api/local/capture/browser_start',{method:'POST',headers:{Origin:server.url,'Content-Type':'application/json'},body:JSON.stringify({sampleRate:16000})});assert.equal(blocked.status,401);
 const started=await call('capture/browser_start',{sampleRate:16000});assert.equal(started.http,202);const sid=started.data.sessionId,rid=started.data.recordId;
 assert.equal((await call('capture/start',{mode:'mic'})).http,409,'Native cannot acquire audio over the browser owner');
 const chunk=async(index,bytes=wavFixture(),session=sid)=>{const response=await fetch(server.url+'/api/local/capture/browser_segment',{method:'PUT',headers:{...headers,'Content-Type':'audio/wav','X-Mono-Session':session,'X-Mono-Index':String(index)},body:bytes});return {http:response.status,data:await response.json()}};
 assert.equal((await chunk(0,wavFixture(),'00000000-0000-0000-0000-000000000000')).http,400);
 const ack=await chunk(0);assert.equal(ack.http,200);assert.equal(ack.data.frames,1600);
 assert.equal((await chunk(0)).data.frames,1600,'Uncertain duplicate cannot double committed duration');
 assert.equal((await call('capture/browser_pause',{sessionId:sid,frames:1600})).data.state,'paused');
 const silent=Buffer.from(wavFixture());silent.fill(0,44);assert.equal((await chunk(1,silent)).http,200);
 assert.equal((await call('capture/browser_resume',{sessionId:sid,frames:3200})).data.state,'recording');
 assert.equal((await chunk(2)).http,200);
 assert.equal((await call('capture/browser_finish',{sessionId:sid,frames:4799})).http,400);
 assert.equal((await call('capture/browser_finish',{sessionId:sid,frames:4800})).data.state,'ready');
 const record=await (await fetch(server.url+'/api/local/records/'+rid,{headers})).json();assert.equal(record.status,'saved');assert.equal(record.duration,.3);assert.ok(record.size>0);assert.deepEqual(record.gapMarkers,[{start:.1,end:.2,reason:'paused'}]);
 await server.restart();const again=await server.session();const retained=await (await fetch(server.url+'/api/local/records/'+rid,{headers:again})).json();assert.equal(retained.size,record.size);assert.equal(retained.status,'saved');
});
