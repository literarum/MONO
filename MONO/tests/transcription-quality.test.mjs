import test from 'node:test';import assert from 'node:assert/strict';
import {planSegments,alignToSilence,parseSilences,contextPrompt,dedupeBoundaries,isHallucination,normalizeSegments,rateLimitWait} from '../core.mjs';
test('segment cuts move into the nearest pause within ±20 s and stay contiguous',()=>{
 const plans=alignToSilence(planSegments(600,240),[{start:230,end:231},{start:250,end:252},{start:470,end:470.6},{start:599.5,end:599.9}]);
 assert.deepEqual(plans.map(p=>[p.start,p.end]),[[0,230.5],[230.5,470.3],[470.3,600]]);
 for(let i=1;i<plans.length;i++)assert.equal(plans[i].start,plans[i-1].end);
 assert.ok(plans.every(p=>p.mediaStart<=p.start&&p.mediaEnd>=p.end));
 assert.deepEqual(alignToSilence(planSegments(600,240),[]).map(p=>p.start),[0,240,480],'no pause nearby: fixed plan');
 assert.deepEqual(alignToSilence(planSegments(600,240),[{start:100,end:101}]).map(p=>p.start),[0,240,480],'pause too far away is ignored');
});
test('silencedetect output is parsed into pauses',()=>{
 assert.deepEqual(parseSilences('silence_start: 1.5\nsilence_end: 2.25 | silence_duration: 0.75\nsilence_start: 9\n'),[{start:1.5,end:2.25}]);
});
test('context prompt keeps the user terms first and a bounded tail of the previous segment',()=>{
 const prompt=contextPrompt('PostgreSQL, Ирина','слово '.repeat(200));
 assert.ok(prompt.startsWith('PostgreSQL, Ирина '));assert.ok(prompt.length<=381);assert.ok(!/\s\s/.test(prompt));
 assert.equal(contextPrompt('','короткий хвост'),'короткий хвост');assert.equal(contextPrompt('термины',''),'термины');
});
test('repetitive low-confidence decodes and boundary duplicates are removed, real speech is kept',()=>{
 assert.equal(isHallucination({text:'да да да да да',compression_ratio:3.1,avg_logprob:-1.4}),true);
 assert.equal(isHallucination({text:'да да да да да',compression_ratio:3.1,avg_logprob:-0.2}),false,'confident repetition is speech');
 assert.equal(dedupeBoundaries([{start:0,end:2,text:'Добрый день.',chunk:0},{start:1.7,end:2.3,text:'добрый день',chunk:1},{start:5,end:6,text:'Добрый день.',chunk:1}]).length,2);
 assert.equal(dedupeBoundaries([{start:0,end:1,text:'Да.',chunk:0},{start:1,end:2,text:'Да.',chunk:0}]).length,2,'a real repeat is speech');
 const out=normalizeSegments([{plan:{index:0,start:0,end:10,mediaStart:0,mediaEnd:10.8},data:{text:'',segments:[{start:9,end:10.5,text:'Итак'}]}},{plan:{index:1,start:10,end:20,mediaStart:9.2,mediaEnd:20},data:{text:'',segments:[{start:0.2,end:1,text:'итак'},{start:2,end:3,text:'продолжим'}]}}]);
 assert.deepEqual(out.map(s=>s.text),['Итак','продолжим']);
});
test('Groq budget headers pause before a request that would be refused',()=>{
 const headers=map=>({get:k=>map[k]??null});
 assert.equal(rateLimitWait(headers({'x-ratelimit-remaining-requests':'5','x-ratelimit-reset-requests':'2m59.56s'})),0);
 assert.equal(Math.round(rateLimitWait(headers({'x-ratelimit-remaining-requests':'1','x-ratelimit-reset-requests':'2m59.56s'}))),179560);
 assert.equal(rateLimitWait(headers({'x-ratelimit-remaining-requests':'0','x-ratelimit-reset-requests':'7.66s'})),7660);
 assert.equal(rateLimitWait(headers({})),0);
});
