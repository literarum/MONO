// The whole path: archive transcript → Groq chat (local fake) → summary stored in the record.
import test from 'node:test';import assert from 'node:assert/strict';import http from 'node:http';import {once} from 'node:events';
import {localServer} from './helpers/local-server.mjs';

async function fakeGroq(t){
 const requests=[];const server=http.createServer(async(req,res)=>{let body='';for await(const part of req)body+=part;requests.push({url:req.url,auth:req.headers.authorization,body:body?JSON.parse(body):null});
  res.setHeader('Content-Type','application/json');
  if(req.url.endsWith('/models')){res.end(JSON.stringify({data:[{id:'whisper-large-v3-turbo'},{id:'openai/gpt-oss-120b'}]}));return}
  res.end(JSON.stringify({model:'openai/gpt-oss-120b',choices:[{message:{content:JSON.stringify({overview:'Договорились о запуске.',decisions:[{text:'Запуск в пятницу',at:'00:02'}],actions:[{text:'Подготовить релиз',owner:'Ирина',at:'00:04'}],questions:[],topics:[]})}}]}));
 });server.listen(0,'127.0.0.1');await once(server,'listening');t.after(()=>server.close());return {base:`http://127.0.0.1:${server.address().port}/openai/v1`,requests};
}
test('summary needs consent, sends only text, and is saved into the record with confidence kept',async t=>{
 const groq=await fakeGroq(t);
 const server=await localServer(t,{GROQ_API_KEY:'gsk_test_key_for_summary',MONO_GROQ_CHAT_BASE:groq.base});const headers=await server.session();
 const json=async(route,method='GET',body)=>{const r=await fetch(server.url+route,{method,headers:{...headers,'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});return {status:r.status,data:await r.json()}};
 await json('/api/local/library/configure','POST',{useDefault:true});
 let record=(await json('/api/local/records','POST',{title:'Планёрка'})).data;
 assert.equal((await json(`/api/local/records/${record.id}/summary`,'POST',{consent:true})).status,409,'no transcript yet');
 const transcript={model:'fixture',segments:[{id:0,start:0,end:3,text:'Запускаем в пятницу.',confidence:.91},{id:1,start:3,end:6,text:'Ирина готовит релиз.',confidence:.2}]};
 const put=await fetch(`${server.url}/api/local/records/${record.id}/transcript`,{method:'PUT',headers:{...headers,'Content-Type':'application/json','X-Mono-Version':String(record.version)},body:JSON.stringify(transcript)});assert.equal(put.status,200);
 const page=(await json(`/api/local/records/${record.id}/transcript?offset=0&limit=5`)).data;assert.deepEqual(page.segments.map(s=>s.confidence),[.91,.2],'confidence survives the archive');
 assert.equal((await json(`/api/local/records/${record.id}/summary`,'POST',{})).status,400,'no consent → refused');
 assert.equal(groq.requests.length,0);
 assert.equal((await json(`/api/local/records/${record.id}/summary`,'POST',{consent:true})).status,202);
 let state;for(let i=0;i<60;i++){state=(await json(`/api/local/records/${record.id}/summary`)).data;if(state.status!=='running')break;await new Promise(r=>setTimeout(r,100))}
 assert.equal(state.status,'done',JSON.stringify(state));
 record=(await json(`/api/local/records/${record.id}`)).data;
 assert.equal(record.summary.overview,'Договорились о запуске.');assert.deepEqual(record.summary.actions,[{text:'Подготовить релиз',owner:'Ирина',at:4}]);
 assert.equal(record.summary.sourceSegments,2);assert.equal(record.summary.model,'openai/gpt-oss-120b');
 const chat=groq.requests.find(r=>r.url.endsWith('/chat/completions'));assert.equal(chat.auth,'Bearer gsk_test_key_for_summary');
 assert.match(chat.body.messages[1].content,/\[00:00\] Запускаем в пятницу\.\n\[00:03\] Ирина готовит релиз\./);
 assert.ok(!JSON.stringify(groq.requests).includes('RIFF'),'no audio is sent');
 // A later transcript edit keeps the summary; a version conflict cannot lose it.
 const edited=await fetch(`${server.url}/api/local/records/${record.id}/transcript/edit`,{method:'PUT',headers:{...headers,'Content-Type':'application/json','X-Mono-Version':String(record.version)},body:JSON.stringify({index:0,text:'Запускаем в субботу.'})});assert.equal(edited.status,200);
 assert.equal((await edited.json()).summary.overview,'Договорились о запуске.');
});
