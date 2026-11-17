import test from 'node:test';import assert from 'node:assert/strict';import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';import path from 'node:path';import {tmpdir} from 'node:os';import {once} from 'node:events';import {WorkerClient} from '../backend/local/worker-client.mjs';
test('worker client decodes UTF-8 split across stdout chunks and recovers after request timeout',async t=>{
 const folder=await mkdtemp(path.join(tmpdir(),'mono-worker-fixture-')),script=path.join(folder,'fixture.py');
 await writeFile(script,`import json,sys,time\nprint(json.dumps({'event':'ready','protocol':1}),flush=True)\nfor line in sys.stdin:\n r=json.loads(line)\n if r['method']=='hang':continue\n data=json.dumps({'v':1,'id':r['id'],'result':{'value':'Я'}},ensure_ascii=False).encode('utf-8')+b'\\n'\n cut=data.index('Я'.encode('utf-8'))+1\n sys.stdout.buffer.write(data[:cut]);sys.stdout.buffer.flush();time.sleep(.05)\n sys.stdout.buffer.write(data[cut:]);sys.stdout.buffer.flush()\n`);
 const old=process.env.MONO_CORE_SCRIPT;process.env.MONO_CORE_SCRIPT=script;const client=new WorkerClient();
 t.after(async()=>{await client.close();if(old===undefined)delete process.env.MONO_CORE_SCRIPT;else process.env.MONO_CORE_SCRIPT=old;await rm(folder,{recursive:true,force:true})});
 assert.equal((await client.call('unicode')).value,'Я');
 await assert.rejects(client.call('hang',{}, {timeoutMs:20}),/WORKER_TIMEOUT/);
 assert.equal((await client.call('unicode')).value,'Я');
 const abort=new AbortController();const pending=client.call('hang',{}, {signal:abort.signal});await new Promise(r=>setTimeout(r,20));abort.abort();await assert.rejects(pending,/CANCELLED/);assert.equal(client.pending.size,0);
});
test('worker close waits for actual EOF flush before reporting completion',async t=>{
 const folder=await mkdtemp(path.join(tmpdir(),'mono-worker-flush-')),script=path.join(folder,'flush.py'),marker=path.join(folder,'flushed.txt');
 await writeFile(script,`import json,sys,time\nfrom pathlib import Path\nprint(json.dumps({'event':'ready','protocol':1}),flush=True)\nfor line in sys.stdin:\n r=json.loads(line);print(json.dumps({'v':1,'id':r['id'],'result':{}}),flush=True)\ntime.sleep(.15)\nPath(__file__).with_name('flushed.txt').write_text('durably closed')\n`);
 const old=process.env.MONO_CORE_SCRIPT;process.env.MONO_CORE_SCRIPT=script;const client=new WorkerClient();await client.call('ping');const child=client.child;
 t.after(async()=>{child.stdin.end();if(child.exitCode===null)await once(child,'exit');if(old===undefined)delete process.env.MONO_CORE_SCRIPT;else process.env.MONO_CORE_SCRIPT=old;await rm(folder,{recursive:true,force:true})});
 await client.close();assert.equal(await readFile(marker,'utf8'),'durably closed');assert.notEqual(child.exitCode,null);
});
