import test from 'node:test';import assert from 'node:assert/strict';
import {chooseChatModel,transcriptParts,normalizeSummary,extractJSON,parseStamp,Summarizer} from '../backend/groq/summary.mjs';

test('model choice: production GPT-OSS first, never a speech or guard model',()=>{
 assert.equal(chooseChatModel(['whisper-large-v3-turbo','openai/gpt-oss-20b','openai/gpt-oss-120b','meta-llama/llama-guard-4-12b']),'openai/gpt-oss-120b');
 assert.equal(chooseChatModel(['whisper-large-v3','openai/gpt-oss-safeguard-20b','openai/gpt-oss-20b']),'openai/gpt-oss-20b');
 assert.equal(chooseChatModel(['whisper-large-v3','playai-tts']),null);
});
test('transcript parts carry time stamps and speakers and respect the size limit',()=>{
 const segments=Array.from({length:50},(_,i)=>({start:i*61,text:'фраза '+i,speaker:i%2?'others':'me'}));
 const parts=transcriptParts(segments,200);assert.ok(parts.length>1);assert.ok(parts.every(p=>p.length<=200));
 assert.match(parts[0],/^\[00:00\] Я: фраза 0\n\[01:01\] Собеседники: фраза 1/);
 assert.match(parts.at(-1),/\[49:49\]/);
});
test('model answers are validated: invented fields dropped, times parsed and bounded',()=>{
 assert.equal(parseStamp('01:02:03'),3723);assert.equal(parseStamp('2:05'),125);assert.equal(parseStamp('скоро'),null);
 const value=normalizeSummary({overview:' Обсудили  запуск. ',hack:'x',decisions:[{text:'Запуск в пятницу',at:'12:30'},{text:''},'Строкой'],actions:[{text:'Подготовить отчёт',owner:'Ирина',due:'до среды',at:'99:00:00',extra:1}],questions:'не массив',topics:[{title:'Бюджет',points:['утвердили','',5],at:'00:10'}]},{duration:3600});
 assert.deepEqual(value,{overview:'Обсудили запуск.',topics:[{title:'Бюджет',points:['утвердили'],at:10}],decisions:[{text:'Запуск в пятницу',at:750},{text:'Строкой'}],actions:[{text:'Подготовить отчёт',owner:'Ирина',due:'до среды'}],questions:[]});
});
test('JSON is recovered from fenced or wrapped answers',()=>{
 assert.deepEqual(extractJSON('```json\n{"overview":"a"}\n```'),{overview:'a'});
 assert.deepEqual(extractJSON('Вот: {"overview":"b"} — готово'),{overview:'b'});
 assert.equal(extractJSON('нет'),null);
});
function fakeGroq(script){
 const calls=[];
 const fetch=async(url,options={})=>{calls.push({url,body:options.body?JSON.parse(options.body):null});const step=script(url,options,calls.length);
  return {ok:step.status===200,status:step.status,headers:new Headers(step.headers||{}),json:async()=>step.body}};
 return {fetch,calls};
}
const answer=content=>({status:200,body:{model:'openai/gpt-oss-120b',choices:[{message:{content:JSON.stringify(content)}}]}});
test('short meeting: one request, JSON mode, chosen model',async()=>{
 const {fetch,calls}=fakeGroq(url=>url.endsWith('/models')?{status:200,body:{data:[{id:'openai/gpt-oss-120b'},{id:'whisper-large-v3-turbo'}]}}:answer({overview:'Итог',actions:[{text:'Сделать',at:'00:05'}]}));
 const s=new Summarizer({getKey:async()=>'k',fetch,sleep:async()=>{}});
 const result=await s.summarize({segments:[{start:0,text:'Привет'},{start:5,text:'Сделаем'}],title:'Планёрка'});
 assert.equal(result.overview,'Итог');assert.deepEqual(result.actions,[{text:'Сделать',at:5}]);assert.equal(result.model,'openai/gpt-oss-120b');
 const chat=calls.filter(c=>c.url.endsWith('/chat/completions'));assert.equal(chat.length,1);
 assert.equal(chat[0].body.model,'openai/gpt-oss-120b');assert.deepEqual(chat[0].body.response_format,{type:'json_object'});
 assert.match(chat[0].body.messages[1].content,/Планёрка[\s\S]*\[00:05\] Сделаем/);
});
test('long meeting: map over parts, then one reduce; 429 waits by retry-after',async()=>{
 let limited=false;const waits=[];
 const {fetch,calls}=fakeGroq((url,options,n)=>{
  if(url.endsWith('/models'))return {status:503};
  if(!limited){limited=true;return {status:429,headers:{'retry-after':'2'}}}
  return answer({overview:'часть',decisions:[{text:'Решение '+n}]});
 });
 const s=new Summarizer({getKey:async()=>'k',fetch,partChars:120,sleep:async ms=>{waits.push(ms)}});
 const progress=[];
 const segments=Array.from({length:12},(_,i)=>({start:i*10,text:'Текст фрагмента номер '+i}));
 const result=await s.summarize({segments,onProgress:p=>progress.push(p.stage)});
 const chat=calls.filter(c=>c.url.endsWith('/chat/completions'));
 assert.ok(chat.length>=4,'several parts + reduce (+ one rate-limited retry)');
 assert.equal(chat.at(-1).body.model,'openai/gpt-oss-120b','falls back to the production model when the list is unavailable');
 assert.match(chat.at(-1).body.messages[0].content,/Объедини/);assert.deepEqual(waits,[2250]);
 assert.ok(progress.includes('Сводим части в один конспект'));assert.equal(result.decisions.length,1);
});
test('a model without JSON mode is asked again without it',async()=>{
 const {fetch,calls}=fakeGroq((url,options)=>{if(url.endsWith('/models'))return {status:200,body:{data:[{id:'llama-3.3-70b-versatile'}]}};const body=JSON.parse(options.body);return body.response_format?{status:400,body:{}}:{status:200,body:{choices:[{message:{content:'```json\n{"overview":"ок"}\n```'}}]}}});
 const s=new Summarizer({getKey:async()=>'k',fetch,sleep:async()=>{}});
 assert.equal((await s.summarize({segments:[{start:0,text:'Привет'}]})).overview,'ок');
 assert.equal(calls.filter(c=>c.url.endsWith('/chat/completions')).length,2);
});
test('an invalid key stops at once with a clear code',async()=>{
 const {fetch}=fakeGroq(url=>url.endsWith('/models')?{status:401}:{status:401});
 const s=new Summarizer({getKey:async()=>'k',fetch,sleep:async()=>{}});
 await assert.rejects(s.summarize({segments:[{start:0,text:'x'}]}),{code:'INVALID_KEY'});
});
