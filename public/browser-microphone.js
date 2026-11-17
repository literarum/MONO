import {LibraryError} from './library-client.js';
import {pcmWave} from './microphone-pcm.js';
import {captureDiagnostic} from './capture-diagnostic.js';
const active=value=>['requesting','recording','paused','stopping'].includes(value?.state);
function waitFor(promise,signal,onLate=()=>{}){
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
 const code={NotAllowedError:'ACCESS_DENIED',SecurityError:'ACCESS_DENIED',NotFoundError:'DEVICE_LOST',OverconstrainedError:'DEVICE_LOST',NotReadableError:'DEVICE_BUSY'}[error.name]||'BROWSER_AUDIO_ERROR';
 const message={ACCESS_DENIED:'Разрешите микрофон в запросе браузера.',DEVICE_LOST:'Выбранный микрофон недоступен этому окну. Обновите список и выберите его снова.',DEVICE_BUSY:'Windows не смогла открыть микрофон. Он может быть занят другим приложением; выберите другой вход или освободите его.'}[code];
 return new LibraryError(code,message||(stage==='worklet'?'Не удалось подготовить запись в этом окне. Обновите окно MONO и повторите.':'Не удалось подготовить запись. Перезапустите MONO и повторите.'));
}
/** Explicit browser mode, under the same durable server owner as native capture. */
export class BrowserMicrophoneClient{
 constructor(native,{devices=globalThis.navigator?.mediaDevices,contextFactory=null,nodeFactory=null,page=globalThis.window}={}){
  this.native=native;this.library=native.library;this.devices=devices;this.runtime=null;this.opening=null;this.serial=0;
  this.supported=Boolean(devices?.getUserMedia&&devices?.enumerateDevices&&(contextFactory||globalThis.AudioContext)&&(nodeFactory||globalThis.AudioWorkletNode));
  this.contextFactory=contextFactory||(()=>new AudioContext());this.nodeFactory=nodeFactory||(context=>new AudioWorkletNode(context,'mono-microphone'));
  this.page=page;this.onHide=()=>{void this.close()};page?.addEventListener('pagehide',this.onHide);
 }
 init(){return this.native.init()}
 async inputs(){return (await this.devices.enumerateDevices()).filter(d=>d.kind==='audioinput').map((d,index)=>({id:d.deviceId,name:d.label||'Микрофон '+(index+1),default:d.deviceId==='default'})).filter(d=>d.id)}
 async capabilities(options){
  const value=await this.native.capabilities(options),inputs=this.supported?await this.inputs():[];
  return {...value,nativeReady:value.ready,supported:value.supported||this.supported,ready:value.ready||this.supported,modes:[...(this.supported?['browser']:[]),...value.modes],browserInputDevices:inputs};
 }
 devicesList(){return this.capabilities()}
 checkAccess(){return this.native.checkAccess()}
 async requestDevices(inputId=null){
  if(this.runtime||active(await this.native.status()))throw new LibraryError('CAPTURE_BUSY','Сначала остановите запись.');
  let stream,stage='access';try{stream=await waitFor(this.devices.getUserMedia({audio:inputId?{deviceId:{exact:inputId}}:true,video:false}),undefined,late=>late.getTracks().forEach(track=>track.stop()));stage='devices';return await this.inputs()}catch(error){stream?.getTracks().forEach(track=>track.stop());stream=null;const normalized=microphoneError(error,stage);await this.diagnose('refresh',stage,error,normalized);throw normalized}finally{stream?.getTracks().forEach(track=>track.stop())}
 }
 async diagnose(operation,stage,error,normalized){
  if(error?.name==='AbortError')return;
  // Optional local metadata cannot mask the original error or delay it unboundedly.
  await this.library.json('/capture/browser_diagnostic',{method:'POST',body:captureDiagnostic(operation,stage,error,normalized.code),signal:AbortSignal.timeout(750)}).catch(()=>{});
 }
 call(operation,body){return this.library.json('/capture/browser_'+operation,{method:'POST',body,signal:AbortSignal.timeout(4000)})}
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
  if(options.mode!=='browser')return this.native.start(options,{test,signal});
  if(!this.supported)throw new LibraryError('BROWSER_AUDIO_UNAVAILABLE','Этот браузер не поддерживает запись микрофона.');
  if(this.runtime||this.opening)throw new LibraryError('CAPTURE_BUSY','Сначала остановите текущую запись.');
  const opening=new AbortController();this.opening=opening;const intent=signal?AbortSignal.any([signal,opening.signal]):opening.signal;
  let stream,context,runtime,stage='status';
  try{
   if(active(await this.native.status()))throw new LibraryError('CAPTURE_BUSY','Сначала остановите текущую запись.');
   stage='access';intent.throwIfAborted();stream=await waitFor(this.devices.getUserMedia({audio:{channelCount:{ideal:1},echoCancellation:false,noiseSuppression:false,autoGainControl:false,...(options.inputId?{deviceId:{exact:options.inputId}}:{})},video:false}),intent,late=>late.getTracks().forEach(track=>track.stop()));
   stage='context';intent.throwIfAborted();context=this.contextFactory();await waitFor(context.suspend(),intent);stage='worklet';await waitFor(context.audioWorklet.addModule('/microphone-worklet.js'),intent);intent.throwIfAborted();
   stage='graph';const node=this.nodeFactory(context),source=context.createMediaStreamSource(stream),gain=context.createGain();gain.gain.value=0;
   runtime={stream,context,node,source,gain,sessionId:null,pending:Promise.resolve(),queued:0,nextIndex:0,ackedFrames:0,requests:new Map(),failed:false,cleaned:false};
   node.port.onmessage=event=>this.message(runtime,event.data);node.onprocessorerror=()=>void this.fail(runtime,new LibraryError('BROWSER_AUDIO_ERROR','Обработка микрофона остановилась.'));
   stage='acquire';const value=await this.call('start',{sampleRate:context.sampleRate,inputId:options.inputId||null,test});runtime.sessionId=value.sessionId;this.runtime=runtime;
   for(const track of stream.getTracks())track.addEventListener('ended',()=>{if(!runtime.stopPromise&&!runtime.cleaned)void this.fail(runtime,new LibraryError('DEVICE_LOST','Микрофон отключён.'))},{once:true});
   stage='graph';source.connect(node);node.connect(gain);gain.connect(context.destination);stage='resume';await waitFor(context.resume(),intent);intent.throwIfAborted();
   runtime.heartbeat=setInterval(()=>{
    if(runtime.pinging||runtime.cleaned)return;
    runtime.pinging=true;void this.call('heartbeat',{sessionId:runtime.sessionId}).then(state=>{if(!active(state))return this.release(runtime);if(state.state==='stopping'&&!runtime.stopPromise)void this.stop().catch(()=>{})}).catch(error=>this.fail(runtime,error)).finally(()=>runtime.pinging=false);
   },1000);runtime.heartbeat.unref?.();
   if(test){runtime.testTimer=setTimeout(()=>{void this.stop().catch(()=>{})},5000);runtime.testTimer.unref?.()}
   return value;
  }catch(error){
   if(runtime){if(runtime.sessionId)await this.fail(runtime,error);else await this.release(runtime)}
   else{stream?.getTracks().forEach(track=>track.stop());if(context)await context.close()}
   const normalized=microphoneError(error,stage);await this.diagnose('start',stage,error,normalized);throw normalized;
  }finally{if(this.opening===opening)this.opening=null}
 }
 message(runtime,data){
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
   if(++runtime.queued>4)throw new LibraryError('CAPTURE_QUEUE_OVERFLOW','Архив не успевает сохранять запись.');
   const bytes=pcmWave(data.pcm,runtime.context.sampleRate);
   runtime.pending=runtime.pending.then(async()=>{
    const ack=await this.library.json('/capture/browser_segment',{method:'PUT',headers:{'X-Mono-Session':runtime.sessionId,'X-Mono-Index':String(data.index)},body:new Blob([bytes],{type:'audio/wav'}),signal:AbortSignal.timeout(4000)});
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
  runtime.cleaned=true;clearInterval(runtime.heartbeat);clearTimeout(runtime.testTimer);
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
