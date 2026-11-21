import test from 'node:test';import assert from 'node:assert/strict';import {localServer} from './helpers/local-server.mjs';
test('Unicode full-text search and maximum-size segments cross the private pipe without losing text',async t=>{
 const server=await localServer(t),headers=await server.session();
 const json=async(route,method='GET',body)=>{const r=await fetch(server.url+'/api/local'+route,{method,headers:{...headers,'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});assert.ok(r.ok,`${r.status} ${route}`);return r.json()};
 await json('/library/configure','POST',{useDefault:true});const r=await json('/records','POST',{title:'Обычное название'});
 const text='界'.repeat(20000);await fetch(server.url+`/api/local/records/${r.id}/transcript`,{method:'PUT',headers:{...headers,'X-Mono-Version':String(r.version)},body:JSON.stringify({segments:[{start:0,end:1,text},{start:1,end:2,text:'Согласование РАЗРАБОТКИ'}]})});
 const page=await json(`/records/${r.id}/transcript?offset=0&limit=65`);assert.equal(page.segments.length,2);assert.equal(page.segments[0].text,text);assert.equal(page.segments[0].original,text);
 const found=await json('/records?q='+encodeURIComponent('разработки'));assert.equal(found.items.length,1);assert.equal(found.items[0].id,r.id);
 const title=await json('/records?q='+encodeURIComponent('ОБЫЧНОЕ'));assert.equal(title.items.length,1);
});
