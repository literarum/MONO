import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,writeFile,unlink} from 'node:fs/promises';
import path from 'node:path';
import {localServer,wavFixture} from './helpers/local-server.mjs';

test('HTTP transcript edits survive projection loss, restart and denial without changing original audio',async t=>{
 const server=await localServer(t);let headers=await server.session();
 const json=async(route,method,body)=>{
  const response=await fetch(server.url+route,{method,headers:{...headers,'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});
  return {status:response.status,body:await response.json()};
 };
 assert.equal((await json('/api/local/library/configure','POST',{useDefault:true})).status,200);
 const audio=wavFixture();
 const imported=await fetch(server.url+'/api/local/records/import',{method:'POST',headers:{...headers,'Content-Type':'audio/wav','X-Mono-Record':encodeURIComponent(JSON.stringify({title:'Изолированный тест восстановления',mime:'audio/wav',duration:.1}))},body:audio});
 assert.equal(imported.status,201);let record=await imported.json();
 const route='/api/local/records/'+record.id,source='Исходный текст — ё',edited='Проверенная правка';
 const original={model:'isolated-fixture',language:'ru',rawText:source,segments:[{id:3,start:0,end:.1,text:source}]};
 const put=async(value,version)=>fetch(server.url+route+'/transcript',{method:'PUT',headers:{...headers,'Content-Type':'application/json','X-Mono-Version':String(version)},body:JSON.stringify(value)});
 let response=await put(original,record.version);assert.equal(response.status,200);record=await response.json();
 const folder=path.join(server.root,'library','records',record.id,'transcripts');
 const sourceBytes=await readFile(path.join(folder,'original.json'));
 const changes={...original,segments:[{...original.segments[0],text:edited,original:'Uncommitted replacement'}]};
 response=await put(changes,record.version);assert.equal(response.status,200);record=await response.json();
 assert.equal((await put(original,record.version-1)).status,409);
 assert.equal((await fetch(server.url+route+'/transcript')).status,401);
 const denied=await fetch(server.url+route+'/transcript',{method:'PUT',headers:{Cookie:headers.Cookie,Origin:server.url,'Content-Type':'application/json','X-Mono-Version':String(record.version)},body:JSON.stringify(original)});
 assert.equal(denied.status,403);
 assert.deepEqual(await readFile(path.join(folder,'original.json')),sourceBytes);
 // These files are only in this test's private directory. The real manifest and
 // SQLite retain the durable commit; restart must repair both projections.
 await unlink(path.join(folder,'original.json'));
 await writeFile(path.join(folder,'edits.json'),'{}','utf8');
 await server.restart();headers=await server.session();
 const page=await json(route+'/transcript?offset=0&limit=1','GET');
 assert.equal(page.status,200);assert.equal(page.body.segments[0].text,edited);
 assert.equal(page.body.segments[0].original,source);
 assert.deepEqual(await readFile(path.join(folder,'original.json')),sourceBytes);
 const restored=JSON.parse(await readFile(path.join(folder,'edits.json'),'utf8'));
 assert.equal(restored.segments[0].text,edited);assert.equal(restored.segments[0].original,source);
 assert.equal((await json(route,'GET')).body.version,record.version);
 const played=await fetch(server.url+route+'/audio',{headers});assert.equal(played.status,200);
 assert.deepEqual(Buffer.from(await played.arrayBuffer()),audio);
 await server.restart();headers=await server.session();
 assert.equal((await json(route+'/transcript?limit=1','GET')).body.segments[0].text,edited);
});
