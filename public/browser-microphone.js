import {LibraryError} from './library-client.js';
import {pcmWave} from './microphone-pcm.js';
import {captureDiagnostic} from './capture-diagnostic.js';
import {captureErrors} from './capture-client.js';
/** Native-only failures raised before any capture was submitted: safe to retry with the browser microphone. */
const NATIVE_UNAVAILABLE=new Set(['HELPER_UNAVAILABLE','NOT_SUPPORTED','CAPTURE_NOT_READY','CAPTURE_HELPER_UNAVAILABLE']);
/** A person may need time to read a first-run permission prompt. */
const PERMISSION_PROMPT_MS=120000;
/** 2 s chunks: tolerate ~30 s of slow archive IO (antivirus scans, HDD spin-up) before failing. */
const MAX_QUEUED_CHUNKS=15,SEGMENT_TIMEOUT_MS=30000,HEARTBEAT_GRACE_MS=20000;
const active=value=>['requesting','recording','paused','stopping'].includes(value?.state);
function waitFor(promise,signal,onLate=()=>{},timeoutMs=10000){
 return new Promise((resolve,reject)=>{
  let settled=false;
  const finish=(error,value)=>{if(settled){if(!error)onLate(value);return}settled=true;clearTimeout(timer);signal?.removeEventListener('abort',aborted);error?reject(error):resolve(value)};
  const aborted=()=>finish(signal.reason||new DOMException('Cancelled','AbortError'));
  const timer=setTimeout(()=>finish(new LibraryError('ACCESS_TIMEOUT','Микрофон не подключён вовремя. Повторите проверку.')),10000);timer.unref?.();
  Promise.resolve(promise).then(value=>finish(null,value),error=>finish(error));
  if(signal?.aborted)aborted();else signal?.addEventListener('abort',aborted,{once:true});
 });
}
function microphoneError(error,stage){
 if(error instanceof LibraryError||error.name==='AbortError')return error;
 const code={NotAllowedError:'ACCESS_DENIED',SecurityError:'ACCESS_DENIED',NotFoundError:'DEVICE_LOST',OverconstrainedError:'DEVICE_LOST',NotReadableError:'BROWSER_OPEN_FAILED'}[error.name]||'BROWSER_AUDIO_ERROR';
 const message={ACCESS_DENIED:'Разрешите микрофон в запросе браузера.',DEVICE_LOST:'Выбранный микрофон недоступен этому окну. Обновите список и выберите его снова.',BROWSER_OPEN_FAILED:'Окно браузера не смогло открыть микрофон: система отклонила запуск записи. Это не обязательно значит, что микрофон занят. Выберите другой микрофон в студии или нажмите «Диагностика».'}[code];
 return new LibraryError(code,message||(stage==='worklet'?'Не удалось подготовить запись в этом окне. Обновите окно MONO и повторите.':'Не удалось подготовить запись. Перезапустите MONO и повторите.'));
}
/** Chrome/Edge list the system default as 'default' ("По умолчанию - X") and, on
 * Windows, a 'communications' alias. Keep the default (marked) and drop the alias. */
export function listDevices(devices,kind,fallback){
 return devices.filter(d=>d.kind===kind&&d.deviceId&&d.deviceId!=='communications').map((d,index)=>({id:d.deviceId,name:d.label||`${fallback} ${index+1}`,default:d.deviceId==='default',labelled:Boolean(d.label)}));
}
/** "По умолчанию - Микрофон (Realtek)" → "Микрофон (Realtek)". */
export function deviceName(device){return device?String(device.name).replace(/^(?:default|по умолчанию|standard|défaut)\s*[-–—:]\s*/i,''):''}
/** Constraint ladder for getUserMedia: exact device without processing → default without
 * processing → default with browser processing → plain audio:true.
 * Chromium ≥152 opens a microphone whose driver claims raw support with AUDCLNT_STREAMOPTIONS_RAW
 * and does not retry IAudioClient::Initialize without it; every such failure reaches the page as
 * NotReadableError. A processed request is a different path through the same code, so it is a
 * separate rung (whether it avoids raw mode on a given driver is not documented — measured by
 * «Глубокая диагностика»). NotReadableError gets short delayed retries. A denial never climbs. */
export const CONSTRAINT_LADDER=inputId=>[
 ...(inputId?[{channelCount:{ideal:1},echoCancellation:false,noiseSuppression:false,autoGainControl:false,deviceId:{exact:inputId}}]:[]),
 {channelCount:{ideal:1},echoCancellation:false,noiseSuppression:false,autoGainControl:false},
 {echoCancellation:true,noiseSuppression:true,autoGainControl:true},
 true];
const RETRYABLE=new Set(['NotReadableError','OverconstrainedError','NotFoundError','AbortError','TrackStartError']);
/** Explicit browser mode, under the same durable server owner as native capture. */
export class BrowserMicrophoneClient{
 async acquire(inputId,intent,accessTimeout){
  let last=null;
  for(const [rung,audio] of CONSTRAINT_LADDER(inputId).entries()){
   for(let attempt=0;attempt<3;attempt++){
    intent?.throwIfAborted?.();
    try{const stream=await waitFor(this.devices.getUserMedia({audio,video:false}),intent,late=>late.getTracks().forEach(track=>track.stop()),accessTimeout);if(last)this.recovered=last.name;return stream}
    catch(error){last=error;if(!RETRYABLE.has(error?.name)||error?.name==='AbortError'&&intent?.aborted)throw error;if(error.name!=='NotReadableError'||attempt>=(rung===0?2:0))break;/* retries only on the first rung: ~3 s, not ~10 s */await new Promise(resolve=>setTimeout(resolve,attempt?1200:300))}
   }
  }
  throw last;
 }
 constructor(native,{devices=globalThis.navigator?.mediaDevices,contextFactory=null,nodeFactory=null,page=globalThis.window}={}){
  this.native=native;this.library=native.library;this.devices=devices;this.runtime=null;this.opening=null;this.serial=0;
  this.supported=Boolean(devices?.getUserMedia&&devices?.enumerateDevices&&(contextFactory||globalThis.AudioContext)&&(nodeFactory||globalThis.AudioWorkletNode));
  this.contextFactory=contextFactory||(()=>new AudioContext());this.nodeFactory=nodeFactory||(context=>new AudioWorkletNode(context,'mono-microphone'));
  this.page=page;this.onHide=()=>{void this.close()};page?.addEventListener('pagehide',this.onHide);
 }
 init(){return this.native.init()}
 async inputs(){return listDevices(await this.devices.enumerateDevices(),'audioinput','Микрофон')}
 async outputs(){return listDevices(await this.devices.enumerateDevices(),'audiooutput','Динамики')}
 async capabilities(options){
  const value=await this.native.capabilities(options),inputs=this.supported?await this.inputs():[],outputs=this.supported?await this.outputs().catch(()=>[]):[];
  return {...value,nativeReady:value.ready,nativeStarting:!value.ready&&value.supported!==false&&!value.reason&&!value.browserActive,supported:value.supported||this.supported,ready:value.ready||this.supported,modes:[...(this.supported?['browser']:[]),...value.modes],browserInputDevices:inputs,browserOutputDevices:outputs};
 }
 devicesList(){return this.capabilities()}
 checkAccess(){return this.native.checkAccess()}
 async requestDevices(inputId=null){
  if(this.runtime||active(await this.native.status()))throw new LibraryError('CAPTURE_BUSY','Сначала остановите запись.');
  let stream,stage='access';try{stream=await waitFor(this.devices.getUserMedia({audio:inputId?{deviceId:{exact:inputId}}:true,video:false}),undefined,late=>late.getTracks().forEach(track=>track.stop()),await this.permissionTimeout());stage='devices';return await this.inputs()}catch(error){stream?.getTracks().forEach(track=>track.stop());stream=null;const normalized=microphoneError(error,stage);await this.diagnose('refresh',stage,error,normalized);throw normalized}finally{stream?.getTracks().forEach(track=>track.stop())}
 }
 async diagnose(operation,stage,error,normalized){
  if(error?.name==='AbortError')return;
  // Optional local metadata cannot mask the original error or delay it unboundedly.
  await this.library.json('/capture/browser_diagnostic',{method:'POST',body:captureDiagnostic(operation,stage,error,normalized.code),signal:AbortSignal.timeout(750)}).catch(()=>{});
 }
 async call(operation,body){try{return await this.library.json('/capture/browser_'+operation,{method:'POST',body,signal:AbortSignal.timeout(4000)})}catch(error){if(error instanceof LibraryError&&captureErrors[error.code])error.message=captureErrors[error.code];throw error}}
 async permissionTimeout(){try{const state=(await globalThis.navigator?.permissions?.query({name:'microphone'}))?.state;return state==='granted'?10000:PERMISSION_PROMPT_MS}catch{return PERMISSION_PROMPT_MS}}
 async status(options){
  let value;
  try{value=await this.native.status(options)}catch(error){if(this.runtime)void this.fail(this.runtime,error);throw error}
  const runtime=this.runtime;
  if(runtime){
   if(value.sessionId!==runtime.sessionId||!active(value))await this.release(runtime);
   else if(value.state==='stopping'&&!runtime.stopPromise)void this.stop().catch(()=>{});
   else if(runtime.level)value={...value,levels:{mic:{...runtime.level,ageMs:Math.max(0,performance.now()-runtime.levelAt)}}};
  }
  return value;
 }
 async start(options,{test=false,signal}={}){
  if(options.mode!=='browser'){
   try{return await this.native.start(options,{test,signal})}
   catch(error){
    // Builds without a native helper (macOS, Linux, dev checkouts) still record from the microphone.
    if(!(options.mode==='mic'&&this.supported&&NATIVE_UNAVAILABLE.has(error?.code)))throw error;
    return this.start({mode:'browser',inputId:null,outputId:null},{test,signal});
   }
  }
  if(!this.supported)throw new LibraryError('BROWSER_AUDIO_UNAVAILABLE','Этот браузер не поддерживает запись микрофона.');
  if(this.runtime||this.opening)throw new LibraryError('CAPTURE_BUSY','Сначала остановите текущую запись.');
  const opening=new AbortController();this.opening=opening;const intent=signal?AbortSignal.any([signal,opening.signal]):opening.signal;
  let stream,context,runtime,stage='status';
  try{
   if(active(await this.native.status()))throw new LibraryError('CAPTURE_BUSY','Сначала остановите текущую запись.');
   stage='access';intent.throwIfAborted();const accessTimeout=await this.permissionTimeout();stream=await this.acquire(options.inputId,intent,accessTimeout);
   stage='context';intent.throwIfAborted();context=this.contextFactory();await waitFor(context.suspend(),intent);stage='worklet';await waitFor(context.audioWorklet.addModule('/microphone-worklet.js'),intent);intent.throwIfAborted();
   stage='graph';const node=this.nodeFactory(context),source=context.createMediaStreamSource(stream),gain=context.createGain();gain.gain.value=0;
   runtime={stream,context,node,source,gain,sessionId:null,heartbeatAt:performance.now(),pending:Promise.resolve(),queued:0,nextIndex:0,ackedFrames:0,requests:new Map(),failed:false,cleaned:false};
   node.port.onmessage=event=>this.message(runtime,event.data);node.onprocessorerror=()=>void this.fail(runtime,new LibraryError('BROWSER_AUDIO_ERROR','Обработка микрофона остановилась.'));
   stage='acquire';const value=await this.call('start',{sampleRate:context.sampleRate,inputId:options.inputId||null,test});runtime.sessionId=value.sessionId;this.runtime=runtime;
   for(const track of stream.getTracks())track.addEventListener('ended',()=>{if(!runtime.stopPromise&&!runtime.cleaned)void this.fail(runtime,new LibraryError('DEVICE_LOST','Микрофон отключён.'))},{once:true});
   stage='graph';source.connect(node);node.connect(gain);gain.connect(context.destination);stage='resume';await waitFor(context.resume(),intent);intent.throwIfAborted();
   // Windows sleep/wake or an audio-device change can suspend or interrupt the context
   // outside the page's control; while this take is running, bring it back immediately.
   context.addEventListener?.('statechange',()=>{if(this.runtime===runtime&&!runtime.cleaned&&!runtime.paused&&['suspended','interrupted'].includes(context.state))void context.resume().catch(()=>{})});
   // The heartbeat goes on two independent clocks: a timer, and the audio itself (worklet messages
   // arrive from the audio thread). A hidden tab of the person's browser may have its timers slowed
   // to once a minute; the audio keeps flowing, so the archive keeps hearing from this take.
   runtime.ping=()=>{
    if(runtime.pinging||runtime.cleaned||performance.now()-(runtime.pingedAt||0)<900)return;
    runtime.pinging=true;runtime.pingedAt=performance.now();void this.call('heartbeat',{sessionId:runtime.sessionId}).then(state=>{runtime.heartbeatAt=performance.now();if(!active(state))return this.release(runtime);if(state.state==='stopping'&&!runtime.stopPromise)void this.stop().catch(()=>{})}).catch(error=>{
     // A rejected session is final; a slow or briefly unavailable archive is not.
     if(error?.status>=400&&error.status<500||performance.now()-runtime.heartbeatAt>HEARTBEAT_GRACE_MS)return this.fail(runtime,error);
    }).finally(()=>runtime.pinging=false);
   };
   runtime.heartbeat=setInterval(runtime.ping,1000);runtime.heartbeat.unref?.();
   // A page holding a Web Lock is not frozen by the browser while it sits in the background.
   if(globalThis.navigator?.locks?.request&&!test)void globalThis.navigator.locks.request('mono-recording',()=>new Promise(resolve=>{runtime.releaseLock=resolve})).catch(()=>{});
   if(test){runtime.testTimer=setTimeout(()=>{void this.stop().catch(()=>{})},5000);runtime.testTimer.unref?.()}
   return value;
  }catch(error){
   if(runtime){if(runtime.sessionId)await this.fail(runtime,error);else await this.release(runtime)}
   else{stream?.getTracks().forEach(track=>track.stop());if(context)await context.close()}
   const normalized=microphoneError(error,stage);await this.diagnose('start',stage,error,normalized);throw normalized;
  }finally{if(this.opening===opening)this.opening=null}
 }
 message(runtime,data){runtime.ping?.();
  if(runtime.failed||runtime.cleaned||!data)return;
  if(data.type==='level'){
   const v=data.value;if(!v||!['peak','rms'].every(key=>Number.isFinite(v[key])&&v[key]>=0&&v[key]<=1)||!Number.isInteger(v.clippedFrames)||v.clippedFrames<0){void this.fail(runtime,new LibraryError('INVALID_CAPTURE_PROTOCOL','Получен неверный уровень микрофона.'));return}
   runtime.level={peak:v.peak,rms:v.rms,clippedFrames:v.clippedFrames};runtime.levelAt=performance.now();return;
  }
  if(data.type==='ack'){
   const request=runtime.requests.get(data.id);if(request){clearTimeout(request.timer);runtime.requests.delete(data.id);request.resolve(data.frames)}return;
  }
  if(data.type==='fault'){void this.fail(runtime,new LibraryError('BROWSER_AUDIO_ERROR','Микрофон перестал передавать звук.'));return}
  if(data.type!=='chunk')return;
  try{
   if(data.index!==runtime.nextIndex++||!Number.isInteger(data.frames)||data.frames<1||data.frames>runtime.context.sampleRate*2||!(data.pcm instanceof ArrayBuffer)||data.pcm.byteLength!==data.frames*2)throw new LibraryError('INVALID_CAPTURE_PROTOCOL','Получен неверный аудиофрагмент.');
   if(++runtime.queued>MAX_QUEUED_CHUNKS)throw new LibraryError('CAPTURE_QUEUE_OVERFLOW','Архив не успевает сохранять запись.');
   const bytes=pcmWave(data.pcm,runtime.context.sampleRate);
   runtime.pending=runtime.pending.then(async()=>{
    const ack=await this.library.json('/capture/browser_segment',{method:'PUT',headers:{'X-Mono-Session':runtime.sessionId,'X-Mono-Index':String(data.index)},body:new Blob([bytes],{type:'audio/wav'}),signal:AbortSignal.timeout(SEGMENT_TIMEOUT_MS)});
    if(ack.index!==data.index||ack.frames!==runtime.ackedFrames+data.frames)throw new LibraryError('INVALID_CAPTURE_PROTOCOL','Сохранение фрагмента не подтверждено.');
    runtime.ackedFrames=ack.frames;runtime.queued--;return ack;
   });runtime.pending.catch(error=>void this.fail(runtime,error));
  }catch(error){void this.fail(runtime,error)}
 }
 command(runtime,type){
  const id=++this.serial;return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{runtime.requests.delete(id);reject(new LibraryError('BROWSER_AUDIO_ERROR','Микрофон не подтвердил действие.'))},2000);timer.unref?.();runtime.requests.set(id,{resolve,reject,timer});runtime.node.port.postMessage({type,id})});
 }
 async transition(type){
  const runtime=this.runtime;if(!runtime)return this.native[type]();
  try{const frames=await this.command(runtime,type);const result=runtime.pending.then(()=>this.call(type,{sessionId:runtime.sessionId,frames}));runtime.pending=result;result.catch(error=>void this.fail(runtime,error));return await result}
  catch(error){await this.fail(runtime,error);throw microphoneError(error)}
 }
 pause(){return this.transition('pause')}
 resume(){return this.transition('resume')}
 stop(){
  const runtime=this.runtime;if(!runtime)return this.native.stop();if(runtime.stopPromise)return runtime.stopPromise;
  runtime.stopPromise=(async()=>{
   try{const frames=await this.command(runtime,'stop');await this.release(runtime);await runtime.pending;return await this.call('finish',{sessionId:runtime.sessionId,frames})}
   catch(error){await this.fail(runtime,error);throw microphoneError(error)}
  })();return runtime.stopPromise;
 }
 async release(runtime){
  if(runtime.releasePromise)return runtime.releasePromise;
  runtime.cleaned=true;clearInterval(runtime.heartbeat);runtime.releaseLock?.();clearTimeout(runtime.testTimer);
  runtime.releasePromise=(async()=>{for(const request of runtime.requests.values()){clearTimeout(request.timer);request.reject(new LibraryError('BROWSER_AUDIO_ERROR','Микрофон остановлен.'))}runtime.requests.clear();runtime.stream.getTracks().forEach(track=>track.stop());runtime.source.disconnect();runtime.node.disconnect();runtime.gain.disconnect();await runtime.context.close()})();
  if(this.runtime===runtime)this.runtime=null;return runtime.releasePromise;
 }
 async fail(runtime,error){
  if(runtime.failed)return;runtime.failed=true;
  try{await this.release(runtime)}finally{if(runtime.sessionId)await this.call('abort',{sessionId:runtime.sessionId}).catch(()=>{/* Supervisor heartbeat expiry independently closes an unreachable session. */})}
 }
 discardTest(id){return this.native.discardTest(id)}
 async close(){this.opening?.abort();this.page?.removeEventListener('pagehide',this.onHide);if(this.runtime)await this.fail(this.runtime,new Error('Window closed'))}
}
