import test from 'node:test';import assert from 'node:assert/strict';
import {readFile,writeFile,rm,realpath,readdir} from 'node:fs/promises';import path from 'node:path';import {fileURLToPath} from 'node:url';
import {localServer,wavFixture} from './helpers/local-server.mjs';
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
test('authenticated consumer resumes an exact library move after actual worker death',async t=>{
 const server=await localServer(t,{MONO_CORE_SCRIPT:fileURLToPath(new URL('./fixtures/transfer-worker.py',import.meta.url))});let headers=await server.session();
 const json=async(route,body)=>{const response=await fetch(server.url+'/api/local'+route,{method:'POST',headers:{...headers,'Content-Type':'application/json'},body:JSON.stringify(body)});return {status:response.status,data:await response.json()}};
 assert.equal((await json('/library/configure',{useDefault:true})).status,200);
 const original=wavFixture(),uploaded=await fetch(server.url+'/api/local/records/import',{method:'POST',headers:{...headers,'Content-Type':'audio/wav','X-Mono-Record':encodeURIComponent(JSON.stringify({title:'Kill/reopen fixture',mime:'audio/wav',duration:.1}))},body:original});assert.equal(uploaded.status,201);const record=await uploaded.json();
 const destination=path.join(server.root,'destination');await writeFile(path.join(server.root,'test-picker.json'),JSON.stringify({move:destination,backup:path.join(server.root,'exports')}));
 await writeFile(path.join(server.root,'hold-copy'),'fault injection');
 try{
  const choice=await json('/library/choose',{purpose:'move'}),start=await json('/library/transfer',{kind:'move',choiceId:choice.data.choiceId});assert.equal(start.status,202);assert.equal(start.data.state,'running');
  let held;for(let i=0;i<200;i++){try{held=JSON.parse(await readFile(path.join(server.root,'held-copy.json'),'utf8'));break}catch{await pause(25)}}assert.equal(held?.copied,true,'real copy must reach the durable-file boundary before kill');
  assert.equal((await fetch(server.url+'/api/local/records',{method:'POST',headers:{...headers,'Content-Type':'application/json'},body:'{"title":"must be blocked"}'})).status,409);
  process.kill(held.pid,'SIGKILL');await rm(path.join(server.root,'hold-copy'));
  let pending;for(let i=0;i<100;i++){const r=await fetch(server.url+'/api/local/status',{headers});if(r.ok){pending=await r.json();if(pending.transfer?.state==='interrupted')break}await pause(25)}
  assert.equal(pending.transfer.id,start.data.id);assert.equal(pending.transfer.state,'interrupted');assert.equal(await realpath(pending.libraryPath),await realpath(path.join(server.root,'library')));
  const newChoice=await json('/library/choose',{purpose:'backup'});assert.equal((await json('/library/transfer',{kind:'export',choiceId:newChoice.data.choiceId})).data.code,'TRANSFER_PENDING');
  assert.equal((await json('/library/transfer/resume',{id:'00000000-0000-4000-8000-000000000001'})).status,404);
  const route=server.url+'/api/local/library/transfer/resume',body=JSON.stringify({id:start.data.id});
  assert.equal((await fetch(route,{method:'POST',headers:{'Content-Type':'application/json'},body})).status,401);
  assert.equal((await fetch(route,{method:'POST',headers:{Cookie:headers.Cookie,Origin:server.url,'Content-Type':'application/json'},body})).status,403);
  assert.equal((await fetch(route,{method:'POST',headers:{...headers,Origin:'https://foreign.test','Content-Type':'application/json'},body})).status,403);
  let operation=await json('/library/transfer/resume',{id:start.data.id});assert.equal(operation.status,202);
  for(let i=0;i<200&&operation.data.state==='running';i++){await pause(25);operation=await json('/library/transfer/status',{id:start.data.id})}
  assert.equal(operation.data.state,'completed',JSON.stringify(operation.data));
  const status=await (await fetch(server.url+'/api/local/status',{headers})).json();assert.equal(status.transfer,undefined);assert.equal(await realpath(status.libraryPath),await realpath(destination));
  const manifest=JSON.parse(await readFile(path.join(server.root,'library','records',record.id,'record.json'),'utf8'));
  const sourceBytes=await readFile(path.join(server.root,'library',manifest._segments[0].path));
  assert.deepEqual(sourceBytes,original);
  const played=await fetch(server.url+'/api/local/records/'+record.id+'/audio',{headers});assert.equal(played.status,200);assert.deepEqual(Buffer.from(await played.arrayBuffer()),original);
  assert.equal((await readFile(path.join(destination,'backup.json'),'utf8')).includes(record.id),true);
  await writeFile(path.join(server.root,'config','transfer.json'),'{broken');await server.restart();headers=await server.session();
  const corrupted=await(await fetch(server.url+'/api/local/status',{headers})).json();assert.equal(corrupted.transferRecoveryError,'TRANSFER_JOURNAL_INVALID');
  const recovery=server.url+'/api/local/library/transfer/recover';
  assert.equal((await fetch(recovery,{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'})).status,401);
  assert.equal((await fetch(recovery,{method:'POST',headers:{Cookie:headers.Cookie,Origin:server.url,'Content-Type':'application/json'},body:'{}'})).status,403);
  assert.equal((await fetch(recovery,{method:'POST',headers:{...headers,Origin:'https://foreign.test','Content-Type':'application/json'},body:'{}'})).status,403);
  const recovered=await json('/library/transfer/recover',{});assert.equal(recovered.status,200);assert.deepEqual(recovered.data,{recovered:true});
  const preserved=(await readdir(path.join(server.root,'config'))).filter(name=>/^transfer-invalid-.*\.json$/.test(name));assert.equal(preserved.length,1);assert.equal(await readFile(path.join(server.root,'config',preserved[0]),'utf8'),'{broken');
  assert.equal((await(await fetch(server.url+'/api/local/status',{headers})).json()).transferRecoveryError,undefined);
  const afterRecovery=await fetch(server.url+'/api/local/records/'+record.id+'/audio',{headers});assert.equal(afterRecovery.status,200);assert.deepEqual(Buffer.from(await afterRecovery.arrayBuffer()),original);
 }finally{await rm(path.join(server.root,'hold-copy'),{force:true})}
});
