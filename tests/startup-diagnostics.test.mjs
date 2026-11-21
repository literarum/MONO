import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {localServer} from './helpers/local-server.mjs';

const canary='mono-synthetic-startup-canary';
function phases(logs){return logs.split('\n').filter(line=>line.startsWith('{"event":"startup_phase",')).map(line=>JSON.parse(line))}

test('opt-in startup phases identify completed checks without environment or credential values',async t=>{
 const server=await localServer(t,{MONO_STARTUP_TRACE:'1',MONO_DIAGNOSTIC_CANARY:canary});
 // FFmpeg detection is asynchronous by design (it never delays the first window): wait for it.
 await (await fetch(server.url+'/api/health?wait=tools',{signal:AbortSignal.timeout(70000)})).json();
 // stderr may trail the HTTP reply by a moment.
 for(let i=0;i<50&&!phases(server.logs()).some(row=>row.phase==='runtime.ffprobe.end');i++)await new Promise(resolve=>setTimeout(resolve,100));
 const rows=phases(server.logs());
 assert.ok(rows.some(row=>row.phase==='runtime.ffmpeg.end'));
 assert.ok(rows.some(row=>row.phase==='runtime.ffprobe.end'));
 assert.ok(rows.some(row=>row.phase==='vault.end'));
 for(const row of rows){assert.deepEqual(Object.keys(row).sort(),['event','ms','phase']);assert.ok(Number.isSafeInteger(row.ms)&&row.ms>=0);assert.match(row.phase,/^[a-z.]+$/)}
 assert.ok(!server.logs().includes(canary),'Startup trace must not copy environment values');
});

test('startup failure retains the original deadline and captures phases before cleanup', {timeout:30000}, async t=>{
 const fixture=await mkdtemp(path.join(tmpdir(),'mono-startup-phases-'));
 t.after(()=>rm(fixture,{recursive:true,force:true}));
 const worker=path.join(fixture,'delayed.py');
 await writeFile(worker,'import json,sys,time\ntime.sleep(12)\nprint(json.dumps({"event":"ready","protocol":1}),flush=True)\nfor line in sys.stdin:\n value=json.loads(line)\n print(json.dumps({"v":1,"id":value["id"],"result":{"configured":False,"verified":False,"masked":None}}),flush=True)\n');
 await assert.rejects(()=>localServer(t,{MONO_STARTUP_TRACE:'1',MONO_CORE_SCRIPT:worker,MONO_DIAGNOSTIC_CANARY:canary,MONO_TEST_START_DEADLINE_MS:'10000'}),error=>{
  assert.match(error.message,/Server startup timeout/);
  const match=error.message.match(/diagnostics (\{.*\})$/);assert.ok(match);
  const diagnostic=JSON.parse(match[1]);assert.equal(diagnostic.deadlineMs,10000);
  assert.ok(Array.isArray(diagnostic.phasesAtFailure),'Missing bounded startup phase snapshot');
  assert.ok(diagnostic.phasesAtFailure.length<=20);
  assert.ok(!diagnostic.phasesAtFailure.some(row=>row.phase==='listening'),'Post-timeout cleanup must not replace the failure snapshot');
  assert.ok(!error.message.includes(canary),'Failure diagnostic must not copy environment values');
  return true;
 });
});
