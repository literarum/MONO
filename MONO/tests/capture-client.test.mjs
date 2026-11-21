import test from 'node:test';import assert from 'node:assert/strict';import {fileURLToPath} from 'node:url';import {localServer} from './helpers/local-server.mjs';import {LibraryClient} from '../public/library-client.js';import {CaptureClient} from '../public/capture-client.js';
test('capture client waits for helper readiness and polls sequentially without requiring a provider key',async t=>{
 const server=await localServer(t,{MONO_CORE_SCRIPT:fileURLToPath(new URL('./fixtures/capture-worker.py',import.meta.url))});let cookie='',active=0,maxActive=0;
 const transport=async(resource,options={})=>{
  const h=new Headers(options.headers);h.set('Origin',server.url);if(cookie)h.set('Cookie',cookie);
  if(resource.endsWith('/capture/status')){active++;maxActive=Math.max(active,maxActive);await new Promise(resolve=>setTimeout(resolve,20))}
  try{const response=await fetch(new URL(resource,server.url),{...options,headers:h});if(response.headers.get('set-cookie'))cookie=response.headers.get('set-cookie').split(';')[0];return response}finally{if(resource.endsWith('/capture/status'))active--}
 };
 const library=new LibraryClient({fetch:transport}),client=new CaptureClient({library});await client.init();await library.configure({useDefault:true});
 const capability=await client.capabilities();assert.equal(capability.ready,true);assert.ok(capability.modes.includes('both'));
 const started=await client.start({mode:'mic'});assert.ok(started.recordId);const controller=new AbortController();let observed=0;
 await client.watch(state=>{assert.equal(state.recordId,started.recordId);observed++;if(observed===3)controller.abort()},{signal:controller.signal,interval:10});assert.equal(maxActive,1);assert.equal(observed,3);
 await client.stop();
});
