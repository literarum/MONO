import test from 'node:test';import assert from 'node:assert/strict';import {spawn} from 'node:child_process';import {mkdtemp,rm} from 'node:fs/promises';import path from 'node:path';import {tmpdir} from 'node:os';import net from 'node:net';import {once} from 'node:events';
test('an occupied listener fails with nonzero exit and never reports successful startup',async t=>{
 const socket=net.createServer();socket.listen(0,'127.0.0.1');await once(socket,'listening');const port=socket.address().port,temp=await mkdtemp(path.join(tmpdir(),'mono-busy-'));
 t.after(async()=>{await new Promise(r=>socket.close(r));await rm(temp,{recursive:true,force:true,maxRetries:5,retryDelay:50})});
 const child=spawn(process.execPath,['server.mjs'],{env:{...process.env,PORT:String(port),MONO_DATA_DIR:temp,GROQ_API_KEY:'',GROQ_API_KEY_FILE:''},stdio:['ignore','pipe','ignore']});let output='';child.stdout.on('data',b=>output+=b);
 const timer=setTimeout(()=>child.kill('SIGKILL'),10000);const [code]=await once(child,'exit');clearTimeout(timer);assert.notEqual(code,0);assert.notEqual(code,null);assert.ok(!output.includes('"event":"listening"'));
});
