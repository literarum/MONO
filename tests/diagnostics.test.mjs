import test from 'node:test';import assert from 'node:assert/strict';import {mkdtemp,rm,readFile} from 'node:fs/promises';import {tmpdir} from 'node:os';import path from 'node:path';
import {scrub,Journal,findings,probeGroq,collect,networkCode} from '../backend/local/diagnostics.mjs';
import {signalStats,frameStats,windowFindings,formatReport,sortFindings} from '../public/diagnostics.js';

test('reports never carry keys, paths or e-mail addresses',()=>{
 const text=scrub('Bearer gsk_ABCdef123 failed at C:\\Users\\Anna\\Documents\\MONO\\x.wav and /home/anna/mono, mail anna@example.com');
 assert.doesNotMatch(text,/gsk_ABC|Anna|anna|example\.com/);assert.match(text,/\(путь\)/);
});
test('journal: mirrors console warnings, survives a restart, counts starts',async t=>{
 const dir=await mkdtemp(path.join(tmpdir(),'mono-journal-'));t.after(()=>rm(dir,{recursive:true,force:true}));const file=path.join(dir,'j.json');
 const fake={warn(){},error(){}};const j=new Journal({file});j.capture(fake);j.note('start','MONO запущен');
 fake.error(JSON.stringify({event:'request_error',message:'boom at /home/anna/x'}));
 assert.deepEqual(j.rows.map(r=>r.level),['start','error']);assert.equal(j.rows[1].message,'request_error · boom at (путь)');
 await new Promise(r=>setTimeout(r,700));
 const again=new Journal({file});assert.equal(again.rows.length,2);assert.equal(again.starts(3600e3),1);
 assert.ok(JSON.parse(await readFile(file,'utf8')).length===2);
});
test('conclusions name the cause and the fix',()=>{
 const f=findings({core:{responds:true,ms:20},app:{startsLastHour:4},tools:{ffmpeg:true,ffprobe:true},archive:{configured:true,available:true,writeProbe:'blocked',hoursLeft:.1,freeGB:.4,records:{damaged:1}},
  capture:{privacy:{blocked:false},inputs:[{name:'USB Mic',state:'active',default:true,muted:true,volume:80}],heldBy:['Zoom']},groq:{configured:true,error:'ENOTFOUND'},jobs:{recentErrors:[]},system:{freeMemoryGB:4,memoryGB:16}});
 const titles=f.map(x=>x.title);
 for(const t of ['Ядро перезапускалось','Windows блокирует запись в папку архива','Мало места на диске','Есть повреждённые записи','Микрофон выключен в Windows','Микрофон может держать другое приложение','Нет связи с Groq'])assert.ok(titles.includes(t),t);
 assert.match(f.find(x=>x.title==='Нет связи с Groq').action,/DNS/);
 assert.match(findings({groq:{configured:true,error:'UNABLE_TO_VERIFY_LEAF_SIGNATURE'}})[0].action,/прокси|антивирус/);
 assert.equal(findings({groq:{configured:true,http:401}})[0].level,'warning');
 assert.deepEqual(findings({core:{responds:true,ms:10},groq:{configured:true,http:200,whisper:true,ms:200},capture:{inputs:[{name:'m',state:'active',default:true,muted:false,volume:70}]}}),[]);
});
test('groq probe: status, latency, rate limits, models — and the real network reason on failure',async()=>{
 const keyManager={status:async()=>({configured:true}),getKey:async()=>'k'};
 const ok=await probeGroq({keyManager,fetch:async()=>({ok:true,status:200,headers:new Headers({'x-ratelimit-remaining-requests':'13'}),json:async()=>({data:[{id:'whisper-large-v3-turbo'},{id:'openai/gpt-oss-120b'}]})})});
 assert.equal(ok.http,200);assert.equal(ok.whisper,true);assert.equal(ok.remainingRequests,13);assert.deepEqual(ok.chat,['openai/gpt-oss-120b']);
 const failed=await probeGroq({keyManager,fetch:async()=>{throw Object.assign(new TypeError('fetch failed'),{cause:{code:'ECONNRESET'}})}});
 assert.equal(failed.error,'ECONNRESET');assert.equal(networkCode(new Error('x')),'Error');
 assert.deepEqual(await probeGroq({keyManager:{status:async()=>({configured:false})}}),{configured:false});
});
test('collect: one failing system never breaks the report',async()=>{
 const worker={call:async m=>{if(m==='status')return {libraryConfigured:true,libraryAvailable:false};throw Object.assign(new Error('x'),{code:'CORE_GONE'})}};
 const report=await collect({worker,runtime:async()=>({ffmpeg:true,ffprobe:true}),keyManager:{status:async()=>{throw new Error()}},journal:new Journal(),privacy:async()=>{throw new Error()},users:async()=>[]});
 assert.equal(report.core.responds,true);assert.equal(report.capture.module.error,'CORE_GONE');assert.equal(report.archive.available,false);
 assert.ok(report.findings.some(f=>f.title==='Папка архива недоступна'));assert.equal(report.groq.configured,false);
});
test('window side: signal, frames and plain-language microphone findings',()=>{
 const s=signalStats(Float32Array.from([0,.5,-1,.25]));assert.equal(s.peakDb,0);assert.equal(s.clippedShare,.25);
 assert.equal(signalStats(new Float32Array(10)).peakDb,-120);
 const fr=frameStats([16.7,16.7,16.6,16.8,50,16.7]);assert.equal(fr.fps,60);assert.ok(fr.slowShare>0);
 assert.equal(windowFindings({},{ok:false,error:'NotReadableError'})[0].title,'Микрофон занят или драйвер не отдаёт звук');
 assert.match(windowFindings({},{ok:true,peakDb:-120,rmsDb:-120,clippedShare:0,openMs:100,label:'USB'})[0].title,/полную тишину/);
 assert.equal(windowFindings({gpu:{software:true,renderer:'SwiftShader'}},{ok:true,peakDb:-20,clippedShare:0,openMs:100})[0].title,'Графика работает без видеокарты');
 const text=formatReport({generatedAt:'t',findings:sortFindings([{level:'advisory',title:'Б'},{level:'warning',title:'А',action:'сделать'}]),server:{app:{version:'0.4.0'}},window:{}});
 assert.ok(text.indexOf('✖ А')<text.indexOf('● Б'));assert.match(text,/Что сделать: сделать/);assert.match(text,/ДАННЫЕ ДЛЯ ПОДДЕРЖКИ/);
});
