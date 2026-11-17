import test from 'node:test';import assert from 'node:assert/strict';import {localServer} from './helpers/local-server.mjs';
test('metadata pagination bounds the wire by bytes and neither skips nor duplicates long Unicode titles',async t=>{
 const server=await localServer(t),headers=await server.session();
 await fetch(server.url+'/api/local/library/configure',{method:'POST',headers,body:JSON.stringify({useDefault:true})});
 const expected=[];
 for(let i=0;i<60;i++){const response=await fetch(server.url+'/api/local/records',{method:'POST',headers,body:JSON.stringify({title:'界'.repeat(490)+i})});assert.equal(response.status,201);expected.push((await response.json()).id)}
 const seen=[];let cursor=null,pages=0;
 do{const params=new URLSearchParams({limit:'100'});if(cursor)params.set('cursor',cursor);const response=await fetch(server.url+'/api/local/records?'+params,{headers});assert.equal(response.status,200);const raw=await response.text();assert.ok(Buffer.byteLength(raw)<65536);const result=JSON.parse(raw);seen.push(...result.items.map(r=>r.id));cursor=result.nextCursor;pages++;assert.ok(pages<20)}while(cursor);
 assert.deepEqual(seen.sort(),expected.sort());assert.ok(pages>=2);
});
