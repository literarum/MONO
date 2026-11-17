import test from 'node:test';
import assert from 'node:assert/strict';
import {planSegments,normalizeSegments,estimateCostSeconds,safeName} from '../core.mjs';

test('segment windows cover audio continuously including 4-hour recording',()=>{
  const plans=planSegments(14400);
  assert.equal(plans.length,60);
  assert.equal(plans[0].start,0);assert.equal(plans.at(-1).end,14400);
  for(let i=1;i<plans.length;i++){
    assert.equal(plans[i-1].end,plans[i].start);
    assert(plans[i].mediaStart<plans[i].start);
    assert(plans[i-1].mediaEnd>plans[i].start);
  }
});
test('short audio remains a single segment and billed minimum is 10s',()=>{
  assert.equal(planSegments(0.1).length,1);
  assert.equal(estimateCostSeconds(.1),.04*10/3600);
  assert.equal(estimateCostSeconds(3600),.04);
});
test('no invalid lengths or runaway allocations',()=>{
  assert.throws(()=>planSegments(-1));assert.throws(()=>planSegments(NaN));
  assert.throws(()=>planSegments(10000*241));
});
test('overlap ownership drops duplicated text segments but keeps natural repetitions',()=>{
  const plans=planSegments(480);
  const result=normalizeSegments([
    {plan:plans[1],data:{segments:[{start:0.3,end:1.1,text:'фраза на стыке'}, {start:12,end:13,text:'нет нет'}]}},
    {plan:plans[0],data:{segments:[{start:239.4,end:240.2,text:'фраза на стыке'}, {start:100,end:101,text:'нет нет'}]}}
  ]);
  assert.equal(result.filter(s=>s.text==='фраза на стыке').length,1);
  assert.equal(result.filter(s=>s.text==='нет нет').length,2);
  assert(result[0].start<result[1].start);
});
test('safe file names cannot create path traversal',()=>{assert(!safeName('../../some name').includes('/'))});

test('segment data without provider timestamps remains available',()=>{
 const result=normalizeSegments([{plan:planSegments(120)[0],data:{text:'Проверка без временных меток'}}]);
 assert.equal(result.length,1);
 assert.equal(result[0].text,'Проверка без временных меток');
 assert.equal(result[0].start,0);
});

test('reject invalid segmentation settings and preserve text from malformed timestamp payload',()=>{
  assert.throws(()=>planSegments(120,0,0));
  assert.throws(()=>planSegments(120,4,4));
  assert.throws(()=>planSegments(120,4,-1));
  const plan=planSegments(80)[0];
  const segments=normalizeSegments([{plan,data:{text:'Нельзя терять текст',segments:[{start:'bad',end:null,text:'неверно'}]}}]);
  assert.equal(segments.length,1);
  assert.equal(segments[0].text,'Нельзя терять текст');
});

test('silence hallucinations are removed by Whisper skip rule, credit phrases and loop collapse',()=>{
 const plan=planSegments(60)[0];
 const result=normalizeSegments([{plan,data:{text:'ignored',segments:[
  {start:0,end:2,text:'Добрый день, коллеги.',no_speech_prob:0.01,avg_logprob:-0.2},
  {start:2,end:4,text:'Субтитры сделал DimaTorzok',no_speech_prob:0.1,avg_logprob:-0.3},
  {start:4,end:6,text:'Редактор субтитров А.Семкин Корректор А.Егорова'},
  {start:6,end:8,text:'Что-то в тишине',no_speech_prob:0.9,avg_logprob:-1.4},
  {start:8,end:9,text:'Продолжение следует...',no_speech_prob:0.8,avg_logprob:-0.5},
  {start:9,end:10,text:'Спасибо за внимание.',no_speech_prob:0.05,avg_logprob:-0.3},
  {start:10,end:11,text:'Да.'},{start:11,end:12,text:'Да.'},
  {start:12,end:13,text:'Повтор'},{start:13,end:14,text:'Повтор'},{start:14,end:15,text:'повтор'},{start:15,end:16,text:'Повтор'}
 ]}}]);
 assert.deepEqual(result.map(s=>s.text),['Добрый день, коллеги.','Спасибо за внимание.','Да.','Да.','Повтор']);
 assert.equal(result.at(-1).end,16,'collapsed loop keeps the full time span');
});
test('a chunk that is only a hallucination yields no text, even through the plain-text fallback',()=>{
 const plan=planSegments(30)[0];
 assert.deepEqual(normalizeSegments([{plan,data:{text:'Субтитры создавал DimaTorzok'}}]),[]);
 assert.deepEqual(normalizeSegments([{plan,data:{text:'Субтитры сделал DimaTorzok',segments:[{start:0,end:3,text:'Субтитры сделал DimaTorzok'}]}}]),[]);
});
test('natural speech resembling an outro is kept without a no-speech signal',()=>{
 const plan=planSegments(30)[0];
 assert.equal(normalizeSegments([{plan,data:{segments:[{start:0,end:2,text:'Продолжение следует'}]}}]).length,1);
});
