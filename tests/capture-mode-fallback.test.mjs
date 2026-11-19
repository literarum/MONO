import test from 'node:test';import assert from 'node:assert/strict';
import {CaptureSources} from '../public/native-sources.js';
import {BrowserMicrophoneClient} from '../public/browser-microphone.js';
import {LibraryError} from '../public/library-client.js';

function memoryLibrary(capture={mode:'mic',inputId:null,outputId:null}){
 const patches=[];let stored={capture};
 return {patches,json:async(route,{method='GET',body}={})=>{
  assert.equal(route,'/preferences');
  if(method==='PATCH'){patches.push(body);stored={...stored,...body};}
  return stored;
 }};
}

test('a saved native mode falls back to the browser microphone when no native helper exists',async()=>{
 const library=memoryLibrary();
 const client={capabilities:async()=>({supported:true,ready:true,nativeReady:false,modes:['browser'],inputDevices:[],browserInputDevices:[]})};
 const model=new CaptureSources(client,library);await model.load();
 // Effective only: a module that is briefly unavailable must not pin the person to the browser forever.
 assert.equal(model.value.mode,'mic','the saved choice is kept');
 assert.equal(library.patches.length,0,'nothing is persisted');
 assert.deepEqual(await model.selection(),{mode:'browser',inputId:null,outputId:null});
});

test('an available native mode is never overridden',async()=>{
 const library=memoryLibrary();
 const client={capabilities:async()=>({supported:true,ready:true,modes:['browser','mic','system','both'],inputDevices:[],browserInputDevices:[]})};
 const model=new CaptureSources(client,library);await model.load();
 assert.equal(model.value.mode,'mic');assert.equal(library.patches.length,0);
 assert.deepEqual(await model.selection(),{mode:'mic',inputId:null,outputId:null});
});

test('the selection falls back even if persisting the fallback is refused',async()=>{
 const library={json:async(route,{method='GET'}={})=>{if(method==='PATCH')throw new LibraryError('CAPTURE_BUSY','busy',409);return {capture:{mode:'both',inputId:null,outputId:null}}}};
 const client={capabilities:async()=>({supported:true,ready:true,modes:['browser'],browserInputDevices:[]})};
 const model=new CaptureSources(client,library);await model.load();
 assert.equal((await model.selection()).mode,'browser');
});

test('native start without a helper retries the microphone through the browser engine',async()=>{
 const native={library:{},start:async()=>{throw new LibraryError('HELPER_UNAVAILABLE','В этом выпуске недоступен нативный модуль записи.')}};
 const seen=[];
 class Observed extends BrowserMicrophoneClient{start(options,extra){if(options.mode==='browser'){seen.push(options);return Promise.resolve({sessionId:'browser'})}return super.start(options,extra)}}
 const client=new Observed(native,{devices:{getUserMedia(){},enumerateDevices(){}},contextFactory:()=>({}),nodeFactory:()=>({}),page:null});
 assert.deepEqual(await client.start({mode:'mic',inputId:'native-id',outputId:null},{test:true}),{sessionId:'browser'});
 assert.deepEqual(seen,[{mode:'browser',inputId:null,outputId:null}],'a native endpoint id is never reused as a browser device id');
});

test('system-audio modes and other native errors are not silently converted to microphone capture',async()=>{
 for(const [mode,code] of [['system','HELPER_UNAVAILABLE'],['mic','DEVICE_BUSY']]){
  const native={library:{},start:async()=>{throw new LibraryError(code,code)}};
  const client=new BrowserMicrophoneClient(native,{devices:{getUserMedia(){},enumerateDevices(){}},contextFactory:()=>({}),nodeFactory:()=>({}),page:null});
  await assert.rejects(client.start({mode,inputId:null,outputId:null}),error=>error.code===code);
 }
});
