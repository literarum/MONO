import test from 'node:test';import assert from 'node:assert/strict';import {mkdtemp} from 'node:fs/promises';import {tmpdir} from 'node:os';import path from 'node:path';
import {preflight} from '../backend/local/preflight.mjs';import {Preflight,windowChecks} from '../public/preflight.js';
const worker=(status,capture={ready:false,supported:false,modes:[]})=>({call:async method=>method==='status'?status:method==='capture.capabilities'?capture:null});
const key={status:async()=>({configured:false})};
test('a missing archive folder is a blocking warning; Groq only degrades, a missing module is not reported',async()=>{
 const result=await preflight({worker:worker({libraryConfigured:false}),runtime:()=>({ffmpeg:true,ffprobe:true}),keyManager:key});
 assert.equal(result.canRecord,false);assert.equal(result.level,'warning');
 assert.equal(result.checks.find(c=>c.id==='library').level,'warning');
 assert.equal(result.checks.find(c=>c.id==='groq').level,'caution');assert.equal(result.checks.find(c=>c.id==='capture'),undefined,'a missing module is not a fault: the microphone records through the window');
});
test('a healthy writable archive with free space can record',async()=>{
 const folder=await mkdtemp(path.join(tmpdir(),'mono-preflight-'));
 const result=await preflight({worker:worker({libraryConfigured:true,libraryAvailable:true,libraryPath:folder},{ready:true,modes:['mic']}),runtime:()=>({ffmpeg:true,ffprobe:true}),keyManager:{status:async()=>({configured:true})}});
 assert.equal(result.canRecord,true);assert.ok(['ok','advisory','caution'].includes(result.level));
 assert.match(result.checks.find(c=>c.id==='disk').detail,/ч записи/);
});
test('an archive copy in progress blocks recording, an interrupted one does not',async()=>{
 const folder=await mkdtemp(path.join(tmpdir(),'mono-preflight-'));const base={libraryConfigured:true,libraryAvailable:true,libraryPath:folder};
 assert.equal((await preflight({worker:worker({...base,libraryBusy:true}),runtime:()=>({}),keyManager:key})).canRecord,false);
 assert.equal((await preflight({worker:worker({...base,transfer:{id:'x'}}),runtime:()=>({ffmpeg:true,ffprobe:true}),keyManager:key})).canRecord,true);
});
test('an unresponsive core is a warning, never an exception',async()=>{
 const result=await preflight({worker:{call:async()=>{throw new Error('WORKER_UNAVAILABLE')}},runtime:()=>({ffmpeg:true,ffprobe:true}),keyManager:key});
 assert.equal(result.checks.find(c=>c.id==='core').level,'warning');assert.equal(result.canRecord,false);
});
test('a failing diagnostics endpoint never blocks recording (fail-operational gate)',async()=>{
 const model=new Preflight({json:async()=>{throw new Error('offline')}});assert.equal(await model.gate(),null);
});
test('window checks report a denied microphone and a missing input as cautions',async()=>{
 const nav={mediaDevices:{getUserMedia(){},enumerateDevices:async()=>[]},permissions:{query:async()=>({state:'denied'})},locks:{request(){}}};
 const checks=await windowChecks({nav,scope:{AudioContext:class{},AudioWorkletNode:class{}}});
 assert.equal(checks.find(c=>c.id==='mic-permission').level,'caution');assert.equal(checks.find(c=>c.id==='mic-device').level,'caution');
 assert.ok(!checks.some(c=>c.level==='warning'),'window state alone never blocks: the browser asks for permission itself');
});
