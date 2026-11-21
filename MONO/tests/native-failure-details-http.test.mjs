import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {localServer} from './helpers/local-server.mjs';

for(const unsafe of [false,true])test('native failure details cross actual worker/HTTP without raw diagnostics: '+(unsafe?'invalid':'valid'),async t=>{
 const server=await localServer(t,{MONO_CORE_SCRIPT:fileURLToPath(new URL('./fixtures/capture-worker.py',import.meta.url)),MONO_TEST_AUDIO_BEHAVIOR:unsafe?'open-failure-unsafe':'open-failure'});
 const headers=await server.session();
 const request=async(route,body)=>{const response=await fetch(server.url+'/api/local'+route,{headers,method:body===undefined?'GET':'POST',body:body===undefined?undefined:JSON.stringify(body)});assert.ok(response.ok);return response.json()};
 assert.equal((await fetch(server.url+'/api/local/capture/status')).status,401);
 await request('/library/configure',{useDefault:true});
 let capabilities;for(let i=0;i<80;i++){capabilities=await request('/capture/capabilities');if(capabilities.ready)break;await new Promise(resolve=>setTimeout(resolve,25))}assert.equal(capabilities.ready,true);
 const start=await request('/capture/start',{mode:'mic',inputId:'mic-fixture'});
 let status;for(let i=0;i<80;i++){status=await request('/capture/status');if(status.errorCode)break;await new Promise(resolve=>setTimeout(resolve,25))}
 assert.equal(status.state,'interrupted');assert.equal(status.errorCode,'INTERNAL');assert.equal(status.savedBytes,0);
 assert.deepEqual(status.failureDetails,unsafe?null:{stage:'capture-mic/initialize',nativeCode:'80070057'});
 const record=await request('/records/'+start.recordId);assert.equal(record.status,'interrupted');assert.equal(record.size,0);
 const manifest=await readFile(path.join(server.root,'library','records',start.recordId,'record.json'),'utf8');
 assert.ok(!manifest.includes('nativeCode'));assert.ok(!server.logs().includes('PRIVATE_INVALID_EXCEPTION'));
 let next,fresh;for(let i=0;i<80;i++){next=await request('/capture/capabilities');fresh=await request('/capture/status');if(next.ready&&fresh.sessionId===null)break;await new Promise(resolve=>setTimeout(resolve,25))}assert.equal(next.ready,true);assert.equal(fresh.sessionId,null,'Wait for an actually new helper, not a dying previous process');
 assert.equal(fresh.failureDetails,null,'New helper cannot inherit the previous failure details');
});
