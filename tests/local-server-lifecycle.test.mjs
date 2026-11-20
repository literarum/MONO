import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {localServer} from './helpers/local-server.mjs';

test('private fixture cleanup is idempotent after forced startup termination', {timeout:45000}, async t=>{
 const fixture=await mkdtemp(path.join(tmpdir(),'mono-stopped-server-'));t.after(()=>rm(fixture,{recursive:true,force:true}));
 const worker=path.join(fixture,'never-ready.py');
 // Read EOF on the main thread so a killed server cannot orphan this fixture.
 await writeFile(worker,'import sys,time,threading\nthreading.Thread(target=lambda:time.sleep(60),daemon=True).start()\nfor line in sys.stdin: pass\n');
 let cleanup,diagnostic;
 const registrar={after(callback){cleanup=callback}};
 await assert.rejects(()=>localServer(registrar,{MONO_CORE_SCRIPT:worker,MONO_TEST_START_DEADLINE_MS:'10000'}),error=>{
  const match=error.message.match(/diagnostics (\{.*\})$/);assert.ok(match);diagnostic=JSON.parse(match[1]);
  assert.equal(diagnostic.deadlineMs,10000);assert.equal(diagnostic.exitCode,null);assert.equal(diagnostic.signalCode,'SIGKILL');return true;
 });
 assert.equal(typeof cleanup,'function');
 let timer;
 const completed=await Promise.race([cleanup().then(()=>true),new Promise(resolve=>{timer=setTimeout(()=>resolve(false),10000)})]);clearTimeout(timer);
 assert.ok(completed,'Cleanup must recognize an already signalled child and not wait for a second exit event');
});
