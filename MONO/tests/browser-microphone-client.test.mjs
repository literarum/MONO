import test from 'node:test';import assert from 'node:assert/strict';
import {localServer} from './helpers/local-server.mjs';import {LibraryClient} from '../public/library-client.js';import {PcmCapture} from '../public/microphone-pcm.js';
import {BrowserMicrophoneClient} from '../public/browser-microphone.js';
async function fixture(t,{denied=false,race=false}={}){
 const server=await localServer(t);let cookie='',starts=0;const diagnostics=[];
 const library=new LibraryClient({fetch:async(route,options={})=>{if(route.endsWith('/browser_start'))starts++;if(route.endsWith('/browser_diagnostic'))diagnostics.push(JSON.parse(options.body));const headers=new Headers(options.headers);headers.set('Origin',server.url);if(cookie)headers.set('Cookie',cookie);const r=await fetch(new URL(route,server.url),{...options,headers});if(r.headers.get('set-cookie'))cookie=r.headers.get('set-cookie').split(';')[0];return r}});
 await library.init();await library.configure({useDefault:true});
 const native={library,init:()=>Promise.resolve(library.status),status:()=>library.json('/capture/status'),capabilities:async()=>({supported:false,ready:false,modes:[],inputDevices:[],outputDevices:[]}),stop:()=>library.json('/capture/stop',{method:'POST',body:{}})};
 let ended=0,closed=0,node;const tracks=[{stop(){ended++},addEventListener(){},getSettings:()=>({deviceId:'selected-browser-mic'})}];
 const devices={getUserMedia:async()=>{if(denied)throw Object.assign(new Error('denied'),{name:'NotAllowedError'});return {getTracks:()=>tracks,getAudioTracks:()=>tracks}},enumerateDevices:async()=>[{kind:'audioinput',deviceId:'selected-browser-mic',label:'Physical microphone'}]};
 const contextFactory=()=>({sampleRate:16000,state:'suspended',audioWorklet:{addModule:async()=>{if(race)await library.json('/capture/browser_start',{method:'POST',body:{sampleRate:16000}})}},suspend:async()=>{},resume:async()=>{},close:async()=>{closed++},destination:{},createMediaStreamSource:()=>({connect(){},disconnect(){}}),createGain:()=>({gain:{value:1},connect(){},disconnect(){}})});
 const nodeFactory=()=>{const port={onmessage:null,postMessage(message){queueMicrotask(()=>{const frames=message.type==='stop'?(node.core.stop(),node.core.frames):node.core.setPaused(message.type==='pause');port.onmessage?.({data:{type:'ack',id:message.id,frames}})})}};node={port,connect(){},disconnect(){}};node.core=new PcmCapture(16000,p=>port.onmessage?.({data:{type:'chunk',...p}}),frames=>port.onmessage?.({data:{type:'ended',frames}}));return node};
 const client=new BrowserMicrophoneClient(native,{devices,contextFactory,nodeFactory,page:null});t.after(()=>client.close());return {client,library,devices,tracks,diagnostics,node:()=>node,ended:()=>ended,closed:()=>closed,starts:()=>starts};
}
test('real archive receives browser PCM, pause zeros and exact stop; tracks/context are released',async t=>{
 const f=await fixture(t);const started=await f.client.start({mode:'browser',inputId:'selected-browser-mic'});f.node().core.append([new Float32Array(32000).fill(.25)]);
 await f.client.pause();f.node().core.append([new Float32Array(32000).fill(.8)]);await f.client.resume();f.node().core.append([new Float32Array(100).fill(-.25)]);
 const end=await f.client.stop();assert.equal(end.state,'ready');assert.equal(end.savedFrames,64100);assert.ok(f.ended()>0&&f.closed()>0);
 const record=await f.library.get(started.recordId);assert.equal(record.status,'saved');assert.equal(record.duration,64100/16000);assert.deepEqual(record.gapMarkers,[{start:2,end:4,reason:'paused'}]);
});

test('selected-device refresh requests that exact input rather than opening a broken default',async t=>{
 const f=await fixture(t);let constraints;f.devices.getUserMedia=async value=>{constraints=value;return {getTracks:()=>f.tracks}};
 await f.client.requestDevices('selected-browser-mic');assert.deepEqual(constraints.audio.deviceId,{exact:'selected-browser-mic'});assert.ok(f.ended()>0);assert.equal(f.starts(),0);
});

test('device-open failure is actionable and reports only bounded standardized local diagnostics',async t=>{
 const f=await fixture(t);f.devices.getUserMedia=async()=>{throw Object.assign(new Error('PRIVATE_DEVICE_PATH_OR_MESSAGE'),{name:'NotReadableError'})};
 await assert.rejects(f.client.start({mode:'browser',inputId:'PRIVATE_DEVICE_ID'}),e=>e.code==='BROWSER_OPEN_FAILED'&&/не обязательно значит, что микрофон занят/.test(e.message));
 assert.deepEqual(f.diagnostics,[{operation:'start',stage:'access',code:'BROWSER_OPEN_FAILED',errorName:'NotReadableError'}]);assert.equal(f.starts(),0);assert.deepEqual((await f.library.list()).items,[]);
});

test('worklet-load failure retains its distinct stage and always releases the acquired microphone',async t=>{
 const f=await fixture(t);const factory=f.client.contextFactory;f.client.contextFactory=()=>{const context=factory();context.audioWorklet.addModule=async()=>{throw Object.assign(new Error('PRIVATE_MODULE_URL'),{name:'NotSupportedError'})};return context};
 await assert.rejects(f.client.start({mode:'browser'}),e=>e.code==='BROWSER_AUDIO_ERROR');assert.ok(f.ended()>0&&f.closed()>0);assert.equal(f.starts(),0);
 assert.deepEqual(f.diagnostics,[{operation:'start',stage:'worklet',code:'BROWSER_AUDIO_ERROR',errorName:'NotSupportedError'}]);
});

test('diagnostic delivery failure cannot replace the microphone error or create a record',async t=>{
 const f=await fixture(t);const json=f.library.json.bind(f.library);f.library.json=(route,options)=>route.endsWith('/browser_diagnostic')?Promise.reject(new Error('diagnostic unavailable')):json(route,options);
 f.devices.getUserMedia=async()=>{throw Object.assign(new Error('missing'),{name:'NotFoundError'})};
 await assert.rejects(f.client.start({mode:'browser'}),e=>e.code==='DEVICE_LOST');assert.equal(f.starts(),0);assert.deepEqual((await f.library.list()).items,[]);
});

test('device refresh closes its permission stream before optional failure diagnostics',async t=>{
 const f=await fixture(t),json=f.library.json.bind(f.library);let openAtReport=null;
 f.devices.enumerateDevices=async()=>{throw Object.assign(new Error('enumeration unavailable'),{name:'NotFoundError'})};
 f.library.json=(route,options)=>{if(route.endsWith('/browser_diagnostic')){openAtReport=f.ended()===0;return Promise.resolve({received:true})}return json(route,options)};
 await assert.rejects(f.client.requestDevices('selected-browser-mic'),e=>e.code==='DEVICE_LOST');assert.equal(openAtReport,false);assert.ok(f.ended()>0);
});
test('denied microphone permission creates no record and never submits capture start',async t=>{
 const f=await fixture(t,{denied:true});await assert.rejects(f.client.start({mode:'browser'}),e=>e.code==='ACCESS_DENIED');assert.equal(f.starts(),0);assert.deepEqual((await f.library.list()).items,[]);
});
test('server ownership conflict after device opening still releases all browser audio',async t=>{
 const f=await fixture(t,{race:true});await assert.rejects(f.client.start({mode:'browser'}),e=>e.code==='CAPTURE_BUSY');assert.ok(f.ended()>0&&f.closed()>0);
});
test('cancel during an unanswered permission request settles promptly and releases a late microphone grant',async t=>{
 const f=await fixture(t),abort=new AbortController();let entered,grant;
 const called=new Promise(resolve=>entered=resolve);f.devices.getUserMedia=()=>new Promise(resolve=>{grant=resolve;entered()});
 const started=f.client.start({mode:'browser'},{signal:abort.signal});await called;abort.abort();let timer;
 try{await assert.rejects(Promise.race([started,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('Permission abort did not settle')),300)})]),e=>e.name==='AbortError')}
 finally{clearTimeout(timer);grant({getTracks:()=>f.tracks,getAudioTracks:()=>f.tracks});await started.catch(()=>{});await new Promise(resolve=>setImmediate(resolve))}
 assert.ok(f.ended()>0,'Late permission grant must never leave an open microphone');assert.equal(f.starts(),0);
});
