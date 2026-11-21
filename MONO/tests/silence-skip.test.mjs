import test from 'node:test';import assert from 'node:assert/strict';import http from 'node:http';import {once} from 'node:events';import {spawnSync} from 'node:child_process';import {readFile} from 'node:fs/promises';import path from 'node:path';
import {localServer} from './helpers/local-server.mjs';
test('a silent 240 s window is never sent to the provider and silence hallucinations never reach the transcript',async t=>{
 let providerCalls=0;const stub=http.createServer(async(req,res)=>{for await(const part of req){}providerCalls++;res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({text:'Тон. Субтитры сделал DimaTorzok',segments:[{start:1,end:5,text:'Тон.',no_speech_prob:.02,avg_logprob:-.2},{start:15,end:20,text:'Субтитры сделал DimaTorzok',no_speech_prob:.2,avg_logprob:-.4}]}))});
 stub.listen(0,'127.0.0.1');await once(stub,'listening');t.after(()=>{stub.closeAllConnections();stub.close()});
 const server=await localServer(t,{GROQ_API_KEY:'fixture-only',MONO_GROQ_ENDPOINT:`http://127.0.0.1:${stub.address().port}/transcribe`}),headers=await server.session();
 await fetch(server.url+'/api/local/library/configure',{method:'POST',headers,body:JSON.stringify({useDefault:true})});
 const wav=path.join(server.root,'silence-then-tone.wav');
 const made=spawnSync('ffmpeg',['-v','error','-f','lavfi','-i','anullsrc=r=8000:cl=mono:d=250','-f','lavfi','-i','sine=frequency=440:sample_rate=8000:duration=10','-filter_complex','[0][1]concat=n=2:v=0:a=1','-c:a','pcm_s16le',wav]);assert.equal(made.status,0,made.stderr?.toString());
 const imported=await fetch(server.url+'/api/local/records/import',{method:'POST',headers:{...headers,'X-Mono-Record':encodeURIComponent(JSON.stringify({title:'Тишина и тон',mime:'audio/wav',duration:260}))},body:await readFile(wav)});const record=await imported.json();assert.equal(imported.status,201);
 const submitted=await fetch(server.url+`/api/local/records/${record.id}/transcribe`,{method:'POST',headers,body:JSON.stringify({clientKey:record.id,profile:'cautious',prompt:''})});assert.equal(submitted.status,202);const job=await submitted.json();
 let state;for(let i=0;i<300;i++){state=await (await fetch(server.url+'/api/jobs/'+job.id,{headers})).json();if(['completed','failed'].includes(state.status))break;await new Promise(r=>setTimeout(r,100))}
 assert.equal(state.status,'completed',state.error);assert.equal(state.total,2);assert.equal(state.skippedSilent,1);assert.equal(providerCalls,1,'only the window containing sound is billed');
 const result=await (await fetch(server.url+'/api/jobs/'+job.id+'/result',{headers})).json();
 assert.deepEqual(result.segments.map(s=>s.text),['Тон.']);
});
