import test from 'node:test';import assert from 'node:assert/strict';
import {paragraphs,isDoubtful,nextDoubtful,silenceSkips,skipTarget,savedSeconds,cleanText,transcriptStats,learnTerms,rememberTerms,promptWithTerms,DOUBT_THRESHOLD} from '../public/intelligence.js';
import {normalizeSegments} from '../core.mjs';

const seg=(start,end,text,extra={})=>({start,end,text,...extra});

test('paragraphs break on long pauses and speaker changes, never on short ones',()=>{
 const list=[seg(0,2,'Начнём.'),seg(2.3,4,'Первый пункт.'),seg(7,9,'После паузы.'),seg(9.2,11,'Ответ.',{who:'others'})];
 const groups=paragraphs(list,{speakerOf:s=>s.who||'me'});
 assert.deepEqual(groups.map(g=>g.indices),[[0,1],[2],[3]]);
 assert.equal(groups[0].text,'Начнём. Первый пункт.');assert.equal(groups[2].speaker,'others');
});
test('a very long paragraph is split at a sentence end',()=>{
 const list=Array.from({length:30},(_,i)=>seg(i*3,i*3+2.9,'Фраза номер '+i+' довольно длинная, чтобы набрать объём текста.'));
 const groups=paragraphs(list,{maxChars:300});assert.ok(groups.length>3);assert.ok(groups.every(g=>/[.]$/.test(g.text)));
});
test('doubtful places follow Whisper’s −1 log-probability rule and navigation wraps',()=>{
 assert.ok(Math.abs(DOUBT_THRESHOLD-0.3679)<1e-3);
 const list=[seg(0,1,'a',{confidence:.9}),seg(1,2,'b',{confidence:.2}),seg(2,3,'c'),seg(3,4,'d',{confidence:.3})];
 assert.equal(isDoubtful(list[2]),false,'no score → never flagged');
 assert.equal(nextDoubtful(list,-1),1);assert.equal(nextDoubtful(list,1),3);assert.equal(nextDoubtful(list,3),1);
 assert.equal(nextDoubtful([seg(0,1,'x',{confidence:.99})]),-1);
});
test('the model’s avg_logprob becomes a stored confidence',()=>{
 const out=normalizeSegments([{plan:{index:0,start:0,end:10,mediaStart:0,mediaEnd:10},data:{segments:[{start:0,end:2,text:'Привет',avg_logprob:-0.1},{start:2,end:4,text:'Без оценки'}]}}]);
 assert.equal(out[0].confidence,Math.round(Math.exp(-0.1)*1000)/1000);assert.equal('confidence' in out[1],false);
});
test('smart speed shortens only real pauses between phrases and keeps some air',()=>{
 const list=[seg(0,2,'a'),seg(2.5,4,'b'),seg(10,12,'c')];
 const skips=silenceSkips(list,{minGap:1.2,keep:.4,duration:20});
 assert.deepEqual(skips.map(s=>[+s.from.toFixed(2),+s.to.toFixed(2)]),[[4.2,9.8],[12.2,19.95]]);
 assert.equal(skipTarget(skips,3),null);assert.equal(skipTarget(skips,5),skips[0].to);assert.equal(skipTarget(skips,9.79),null,'already at the end of the pause');
 assert.ok(Math.abs(savedSeconds(skips)-(5.6+7.75))<1e-6);
 assert.deepEqual(silenceSkips([]),[]);
});
test('clean text removes hesitation sounds and stutters but keeps meaningful words and real repeats',()=>{
 assert.equal(cleanText('Э-э, мы, мм, решили решили запускать в в пятницу.'),'Мы, решили запускать в пятницу.');
 assert.equal(cleanText('Ну вот, типа это важно.'),'Ну вот, типа это важно.');
 assert.equal(cleanText('Да. Да.'),'Да. Да.');
 assert.equal(cleanText('Это самое, бюджет утвердили.'),'Бюджет утвердили.');
 assert.equal(cleanText('Экономика и мэр'),'Экономика и мэр','words starting with э/м survive');
});
test('speaking statistics: pace and share of talk time',()=>{
 const list=[seg(0,30,'раз два три четыре пять шесть семь восемь девять десять',{who:'me'}),seg(30,40,'один два три',{who:'others'})];
 const stats=transcriptStats(list,{speakerOf:s=>s.who,duration:60});
 assert.equal(stats.words,13);assert.equal(stats.wordsPerMinute,Math.round(13/(40/60)));
 assert.equal(Math.round(stats.speakers.me.share*100),75);assert.equal(Math.round(stats.silenceShare*100),33);
 assert.equal(transcriptStats([seg(0,5,'мало')]).wordsPerMinute,null,'too little speech for a rate');
});
test('vocabulary is learned only from term-like corrections',()=>{
 assert.deepEqual(learnTerms('мы перешли на постгрес и грок','мы перешли на PostgreSQL и Groq'),['PostgreSQL','Groq']);
 assert.deepEqual(learnTerms('встреча с ириной','встреча с Ириной'),[],'case-only fix of a known word is not a new term');
 assert.deepEqual(learnTerms('встреча с ирой','встреча с Кузнецовой'),['Кузнецовой']);
 assert.deepEqual(learnTerms('завтра','Завтра'),[],'sentence-initial capital is grammar');
 assert.deepEqual(learnTerms('модель гпт','модель GPT-5'),['GPT-5']);
 assert.deepEqual(learnTerms('сделали отчёт','сделали квартальный отчёт'),[],'ordinary lowercase words are never learned');
 const book=rememberTerms(rememberTerms({}, ['Groq']),['Groq','PostgreSQL']);assert.deepEqual(Object.keys(book),['Groq','PostgreSQL']);
 assert.equal(promptWithTerms('Ирина',{Groq:2,'ирина':1}),'Ирина, Groq');
 assert.ok(promptWithTerms('x'.repeat(345),{Groq:1}).length<=350,'never exceeds the prompt budget');
});
