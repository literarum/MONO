import {LibraryError} from './library-client.js';

export const captureActive=value=>['requesting','recording','paused','stopping'].includes(value?.state);
/** A window observes the supervisor; closing a window never ends its recording. */
export class NativeCaptureController{
 constructor(client,{onState=()=>{},onError=()=>{},onIntent=()=>{},interval=200,idleInterval=2000}={}){
  this.client=client;this.onState=onState;this.onError=onError;this.onIntent=onIntent;this.interval=interval;this.idleInterval=idleInterval;
  this.snapshot={state:'idle',connected:false,levels:{},duration:0};this.closed=false;this.epoch=0;this.command=null;this.starting=null;this.reading=null;this.timer=null;this.readAbort=null;this.preparing=null;
  this.listeners=new Set();
 }
 subscribe(fn){this.listeners.add(fn);fn(this.snapshot);return()=>this.listeners.delete(fn)}
 publish(value){if(this.closed)return;this.snapshot={...this.snapshot,...value};this.onState(this.snapshot);for(const fn of this.listeners)fn(this.snapshot)}
 async connect(){if(this.closed)throw new LibraryError('CONTROLLER_CLOSED','Окно записи закрыто.');await this.client.init();await this.refresh();this.schedule();return this.snapshot}
 schedule(){clearTimeout(this.timer);if(this.closed)return;this.timer=setTimeout(()=>{void this.refresh().catch(()=>{}).finally(()=>this.schedule())},captureActive(this.snapshot)||!this.snapshot.connected?this.interval:this.idleInterval);this.timer.unref?.()}
 refresh(){
  if(this.closed)return Promise.resolve(this.snapshot);if(this.reading)return this.reading;
  const epoch=this.epoch,abort=new AbortController();this.readAbort=abort;const timeout=setTimeout(()=>abort.abort(),3000);timeout.unref?.();
  this.reading=this.client.status({signal:abort.signal}).then(value=>{if(epoch===this.epoch&&!this.command)this.publish({...value,connected:true});return this.snapshot}).catch(error=>{
   if(!this.closed&&epoch===this.epoch&&!this.command){const first=this.snapshot.connected;this.publish({connected:false});if(first)this.onError(new LibraryError('CAPTURE_CONNECTION_LOST','Связь с записью потеряна. Остановка не подтверждена. Восстанавливаем соединение…'))}throw error;
  }).finally(()=>{clearTimeout(timeout);this.reading=null;if(this.readAbort===abort)this.readAbort=null});return this.reading;
 }
 async mutate(action){
  if(this.closed)throw new LibraryError('CONTROLLER_CLOSED','Окно записи закрыто.');if(this.command)throw new LibraryError('CAPTURE_BUSY','Дождитесь подтверждения текущего действия.');
  this.epoch++;const work=Promise.resolve().then(action);this.command=work;
  try{const value=await work;this.epoch++;this.publish({...value,connected:true});return value}
  catch(error){this.epoch++;if(!error.status)this.publish({connected:false});throw error}
  finally{this.command=null;this.schedule()}
 }
 start(options,{test=false}={}){
  if(this.closed||this.starting||this.command||captureActive(this.snapshot)||!this.snapshot.connected)return Promise.reject(new LibraryError('CAPTURE_BUSY','Сначала дождитесь состояния записи.'));
  this.publish({state:'requesting',recordId:null,sessionId:null,duration:0,levels:{},errorCode:null,pendingAction:'start'});
  this.preparing=new AbortController();const preparing=this.preparing,signal=preparing.signal;const timeout=setTimeout(()=>preparing.abort(),10000);timeout.unref?.();
  this.starting=this.mutate(async()=>{await this.onIntent({signal});signal.throwIfAborted();return this.client.start(options,{test,signal})}).catch(async error=>{
   // An aborted readiness check never submits start. An uncertain POST is never
   // replayed: query the supervisor while retaining the visible active state.
   await this.refresh().catch(()=>{});
   throw error;
  }).finally(()=>{clearTimeout(timeout);this.preparing=null;this.starting=null;this.schedule()});return this.starting;
 }
 pause(){return this.mutate(()=>this.client.pause())}
 resume(){return this.mutate(()=>this.client.resume())}
 async stop(){
  if(this.starting){this.preparing?.abort();await this.starting.catch(()=>{})}
  // Do not abort a submitted start: the POST may already have acquired audio.
  const result=await this.mutate(()=>this.client.stop());await this.refresh();return result;
 }
 async close(){this.closed=true;clearTimeout(this.timer);this.preparing?.abort();this.readAbort?.abort();await this.reading?.catch(()=>{})}
}
