import test from 'node:test';
import assert from 'node:assert/strict';
import {localServer,wavFixture} from './helpers/local-server.mjs';
import {LibraryClient} from '../public/library-client.js';

function browserFetch(origin){
 let cookie='';
 return async(resource,options={})=>{
  const headers=new Headers(options.headers);headers.set('Origin',origin);
  if(cookie)headers.set('Cookie',cookie);
  const result=await fetch(new URL(resource,origin),{...options,headers});
  if(result.headers.get('set-cookie'))cookie=result.headers.get('set-cookie').split(';')[0];
  return result;
 };
}
test('browser library client streams audio, serializes edits, detects conflicts and survives restart',async t=>{
 const server=await localServer(t),client=new LibraryClient({fetch:browserFetch(server.url)});
 assert.equal((await client.init()).libraryConfigured,false);
 await assert.rejects(client.list(),{code:'LIBRARY_NOT_CONFIGURED'});
 await client.configure({useDefault:true});
 const record=await client.import({title:'Клиент архива',mime:'audio/wav',duration:.1},new Blob([wavFixture()]));
 const transcript={model:'fixture',segments:Array.from({length:160},(_,i)=>({start:i,end:i+1,text:`Текст ${i}`}))};
 await client.patch(record.id,{transcript,status:'completed'});
 const page=await client.transcript(record.id,{offset:65,limit:65});assert.equal(page.segments[0].index,65);assert.equal(page.total,160);
 await Promise.all([client.edit(record.id,65,'Первая правка'),client.edit(record.id,66,'Вторая правка')]);
 const full=await client.get(record.id,{transcript:true});assert.equal(full.transcript.segments[65].text,'Первая правка');assert.equal(full.transcript.segments[66].original,'Текст 66');
 const writer={parts:[],async write(part){this.parts.push(Buffer.from(part))}};
 await client.streamAudio(record.id,writer);assert.deepEqual(Buffer.concat(writer.parts),wavFixture());
 assert.match(client.audioURL(record.id),/^\/api\/local\/records\/[a-f0-9-]+\/audio\?variant=original$/);
 const rival=new LibraryClient({fetch:browserFetch(server.url)});await rival.init();await rival.get(record.id);
 await client.patch(record.id,{title:'Новое имя'});
 await assert.rejects(rival.patch(record.id,{title:'Потерянное изменение'}),{code:'VERSION_CONFLICT'});
 const trashed=await client.trash(record.id);assert.equal((await client.list()).items.length,0);
 await client.restore(record.id,trashed.version);await server.restart();
 assert.equal((await client.get(record.id)).title,'Новое имя','open window must renew an expired server session after restart');
 const reopened=new LibraryClient({fetch:browserFetch(server.url)});await reopened.init();
 assert.equal((await reopened.get(record.id,{transcript:true})).transcript.segments[66].text,'Вторая правка');
});
