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
