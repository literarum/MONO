import test from 'node:test';import assert from 'node:assert/strict';import {readFile} from 'node:fs/promises';import path from 'node:path';import {fileURLToPath} from 'node:url';import {localServer} from './helpers/local-server.mjs';
test('native capture commits without UI polling, enforces one session and flushes on worker EOF',async t=>{
 const server=await localServer(t,{MONO_CORE_SCRIPT:fileURLToPath(new URL('./fixtures/capture-worker.py',import.meta.url))});let headers=await server.session();
 const json=async(route,method='GET',body)=>{const response=await fetch(server.url+'/api/local'+route,{method,headers,body:body===undefined?undefined:JSON.stringify(body)});return {status:response.status,data:await response.json()}};
 await json('/library/configure','POST',{useDefault:true});assert.equal((await fetch(server.url+'/api/local/capture/status')).status,401);
 let capabilities;for(let i=0;i<80;i++){capabilities=await json('/capture/capabilities');if(capabilities.data.ready)break;await new Promise(r=>setTimeout(r,30))}
 assert.equal(capabilities.data.ready,true);assert.equal(capabilities.data.inputDevices[0].id,'mic-fixture');
 const start=await json('/capture/start','POST',{mode:'both',inputId:'mic-fixture',outputId:'system-fixture'});assert.equal(start.status,202);
 // Read the real persisted manifest independently. No capture/status HTTP calls
 // can cause the commit being asserted here.
 const manifestPath=path.join(server.root,'library','records',start.data.recordId,'record.json');let manifest;const deadline=Date.now()+5000;
 do{manifest=JSON.parse(await readFile(manifestPath,'utf8'));if(manifest._segments.length===2)break;await new Promise(resolve=>setTimeout(resolve,25))}while(Date.now()<deadline);
 assert.equal(manifest._segments.length,2,JSON.stringify({state:manifest.status,errorCode:manifest._capture?.errorCode,version:manifest.version,logs:server.logs()}));assert.ok(manifest.size>0);assert.equal(manifest.status,'recording');
 // An idle UI must not be needed to keep the independent capture supervisor alive.
 await new Promise(r=>setTimeout(r,5500));
 const beforeDuplicate=await json('/capture/status');assert.equal(beforeDuplicate.data.state,'recording',JSON.stringify(beforeDuplicate.data));
 const duplicate=await json('/capture/start','POST',{mode:'mic'});assert.equal(duplicate.status,409,JSON.stringify(duplicate.data));
 await server.restart();headers=await server.session();
 const record=await json('/records/'+start.data.recordId);assert.equal(record.data.status,'saved');assert.equal(record.data.duration,2);assert.equal(record.data.tracks.length,2);
});
