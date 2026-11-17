import test from 'node:test';import assert from 'node:assert/strict';import {createHash,randomUUID} from 'node:crypto';import {readFile} from 'node:fs/promises';import path from 'node:path';import {localServer,wavFixture} from './helpers/local-server.mjs';
test('browser migration resumes after restart, verifies repeated bytes and refuses same-ID different content',async t=>{
 const server=await localServer(t);let headers=await server.session();
 const json=async(route,body)=>{const r=await fetch(server.url+'/api/local'+route,{method:'POST',headers,body:JSON.stringify(body)});return {status:r.status,data:await r.json()}};
 await json('/library/configure',{useDefault:true});
 const id=randomUUID(),audio=wavFixture(),text=JSON.stringify({model:'legacy fixture',segments:[{start:0,end:.1,text:'Правка из браузера',original:'Исходный текст'}]});
 const input={sourceId:randomUUID(),meta:{id,title:'Миграция',createdAt:'2026-10-01T10:00:00.000Z',duration:.1,mime:'audio/wav',size:audio.length,status:'completed'},expectedParts:1,transcriptHash:createHash('sha256').update(text).digest('hex')};
 const begin=await json('/migration/begin',input);assert.equal(begin.status,201);assert.equal(begin.data.complete,false);
 const putPart=()=>fetch(server.url+`/api/local/migration/${id}/parts/0`,{method:'PUT',headers,body:audio});assert.ok((await putPart()).ok);
 await server.restart();headers=await server.session();const resumed=await json('/migration/begin',input);assert.equal(resumed.data.committedParts,1);assert.equal(resumed.data.complete,false);
 const transcript=await fetch(server.url+`/api/local/migration/${id}/transcript`,{method:'PUT',headers,body:text});assert.ok(transcript.ok);
 const complete=await json(`/migration/${id}/finish`,{});assert.equal(complete.status,200);assert.equal(complete.data.status,'completed');
 const again=await json('/migration/begin',input);assert.equal(again.data.complete,true);assert.ok((await putPart()).ok);assert.equal((await json(`/migration/${id}/finish`,{})).status,200);
 const list=await fetch(server.url+'/api/local/records',{headers});assert.equal((await list.json()).items.length,1);
 const changed=await json('/migration/begin',{...input,meta:{...input.meta,title:'Другое содержимое'}});assert.equal(changed.status,409);
 const conflict=await fetch(server.url+`/api/local/migration/${id}/parts/0`,{method:'PUT',headers,body:Buffer.alloc(audio.length,1)});assert.equal(conflict.status,409);
 assert.deepEqual(await readFile(path.join(server.root,'library','records',id,'original','original','000000.part')),audio);
 const page=await fetch(server.url+`/api/local/records/${id}/transcript`,{headers});const s=(await page.json()).segments[0];assert.equal(s.text,'Правка из браузера');assert.equal(s.original,'Исходный текст');
});
