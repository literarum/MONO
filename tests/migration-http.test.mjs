import test from 'node:test';import assert from 'node:assert/strict';import {writeFile,readFile,realpath} from 'node:fs/promises';import path from 'node:path';import {fileURLToPath} from 'node:url';import {localServer,wavFixture} from './helpers/local-server.mjs';
test('native archive workflows use opaque picker choices, verify bytes, switch after move and restore idempotently',async t=>{
 const server=await localServer(t,{MONO_CORE_SCRIPT:fileURLToPath(new URL('./fixtures/folder-worker.py',import.meta.url))});let headers=await server.session();
 const request=async(route,method='GET',body)=>{const r=await fetch(server.url+'/api/local'+route,{method,headers,body:body===undefined?undefined:JSON.stringify(body)});assert.ok(r.ok,`${r.status} ${route}`);return r.json()};
 await request('/library/configure','POST',{useDefault:true});
 const wav=wavFixture(),upload=await fetch(server.url+'/api/local/records/import',{method:'POST',headers:{...headers,'X-Mono-Record':encodeURIComponent(JSON.stringify({title:'Native backup fixture',mime:'audio/wav'}))},body:wav});assert.equal(upload.status,201);const record=await upload.json();
 const transcript=await fetch(server.url+`/api/local/records/${record.id}/transcript`,{method:'PUT',headers:{...headers,'X-Mono-Version':String(record.version)},body:JSON.stringify({segments:[{start:0,end:1,text:'Правка',original:'Оригинал'}]})});assert.ok(transcript.ok);
 const choices={backup:path.join(server.root,'backups'),move:path.join(server.root,'moved'),create:path.join(server.root,'restored')};
 const setChoices=()=>writeFile(path.join(server.root,'test-picker.json'),JSON.stringify(choices));await setChoices();
 const transfer=async(kind,purpose)=>{
  const choice=await request('/library/choose','POST',{purpose});let operation=await request('/library/transfer','POST',{kind,choiceId:choice.choiceId});
  for(let i=0;i<120&&operation.state==='running';i++){await new Promise(r=>setTimeout(r,25));operation=await request('/library/transfer/status','POST',{id:operation.id})}
  return operation;
 };
 const exported=await transfer('export','backup');assert.equal(exported.state,'completed',JSON.stringify(exported));
 const backup=exported.result.displayPath,manifest=JSON.parse(await readFile(path.join(backup,'backup.json'),'utf8'));assert.equal(manifest.format,'mono-archive-v2');assert.equal(manifest.complete,true);
 const original=path.join(server.root,'library','records',record.id,'original','original','000000.part');assert.deepEqual(await readFile(original),wav);
 const moved=await transfer('move','move');assert.equal(moved.state,'completed',JSON.stringify(moved));assert.equal(await realpath((await request('/status')).libraryPath),await realpath(choices.move));assert.deepEqual(await readFile(original),wav);
 await server.restart();headers=await server.session();const media=await fetch(server.url+`/api/local/records/${record.id}/audio`,{headers});assert.deepEqual(Buffer.from(await media.arrayBuffer()),wav);
 const fresh=await request('/library/choose','POST',{purpose:'create'});await request('/library/configure','POST',{choiceId:fresh.choiceId});choices.import=backup;await setChoices();
 const restored=await transfer('import','import');assert.equal(restored.state,'completed',JSON.stringify(restored));assert.equal((await request('/records')).items.length,1);
 const repeated=await transfer('import','import');assert.equal(repeated.state,'completed');assert.equal((await request('/records')).items.length,1);
 const page=await request(`/records/${record.id}/transcript`);assert.equal(page.segments[0].text,'Правка');assert.equal(page.segments[0].original,'Оригинал');
 const audioFile=manifest.files.find(item=>item.path.endsWith('.part'));await writeFile(path.join(backup,audioFile.path),Buffer.from('corrupt'));
 const rejected=await transfer('import','import');assert.equal(rejected.state,'failed');assert.equal(rejected.errorCode,'BACKUP_CHECKSUM');assert.deepEqual(await readFile(original),wav);assert.equal((await request('/records')).items.length,1);
});
