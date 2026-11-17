import {LibraryError} from './library-client.js';

const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no});return {promise,resolve,reject}};
const blocked=()=>new LibraryError('PLAYBACK_DURING_CAPTURE','Завершите запись перед прослушиванием, чтобы звук плеера не попал в неё.');
const inactive=value=>['idle','ready','interrupted','error'].includes(value?.state);

/** Same-origin windows share playback locks. Capture never steals a busy lock. */
export class MediaInterlock{
 constructor({locks=globalThis.navigator?.locks,status,channel=null,root=globalThis.document,name='mono-audition-capture-v1',timeoutMs=3000}={}){
  this.locks=locks;this.status=status;this.channel=channel;this.root=root;this.name=name;this.timeoutMs=timeoutMs;this.media=new Map();this.closed=false;this.capture=null;this.waiting=null;
  this.onMessage=event=>{if(event.data?.type==='capture-intent')this.pauseAll()};channel?.addEventListener('message',this.onMessage);
  // All product play actions go through play(). Reject stray autoplay too.
  this.onPlay=event=>{if(!this.media.get(event.target)?.allowed)event.target.pause?.()};root?.addEventListener('play',this.onPlay,true);
 }
 available(){if(this.closed||!this.locks?.request)throw new LibraryError('MEDIA_COORDINATION_UNAVAILABLE','Не удалось согласовать звук между окнами. Перезапустите MONO в поддерживаемом браузере.')}
 pauseAll(){for(const [media,entry] of this.media){entry.abort.abort();media.pause();entry.stopped.resolve()}this.root?.querySelectorAll('audio,video').forEach(media=>media.pause())}
 observe(value){if(value.connected&&inactive(value)){const released=this.capture?.();this.capture=null;return released}}
 async beforeCapture({signal}={}){
  this.available();if(this.capture||this.waiting)throw new LibraryError('CAPTURE_BUSY','Дождитесь завершения текущей записи.');
  this.pauseAll();this.channel?.postMessage({type:'capture-intent'});
  const abort=new AbortController(),deadline=setTimeout(()=>abort.abort(),this.timeoutMs),ready=deferred(),released=deferred();this.waiting=abort;
  const forward=()=>abort.abort(signal.reason);if(signal?.aborted)forward();else signal?.addEventListener('abort',forward,{once:true});
  const holding=this.locks.request(this.name,{mode:'exclusive',signal:abort.signal},async()=>{abort.signal.throwIfAborted();this.capture=()=>{released.resolve();return holding};ready.resolve();await released.promise});
  holding.catch(error=>ready.reject(error));
  try{await ready.promise}
  catch(error){if(signal?.aborted||this.closed)throw error;throw new LibraryError('PLAYBACK_NOT_STOPPED','Другое окно ещё воспроизводит звук. Приостановите его или закройте и повторите запись.')}
  finally{clearTimeout(deadline);signal?.removeEventListener('abort',forward);if(this.waiting===abort)this.waiting=null}
 }
 async play(media){
  this.available();if(this.media.has(media))return this.media.get(media).started.promise;
  const entry={abort:new AbortController(),started:deferred(),stopped:deferred(),allowed:false};this.media.set(media,entry);
  const finish=()=>{entry.abort.abort();entry.stopped.resolve()};for(const event of ['pause','ended','error','emptied'])media.addEventListener(event,finish);
  const interrupt=()=>media.pause();entry.abort.signal.addEventListener('abort',interrupt,{once:true});
  const deadline=setTimeout(()=>entry.abort.abort(),this.timeoutMs);
  const held=this.locks.request(this.name,{mode:'shared',ifAvailable:true},async lock=>{
   try{
    if(!lock)throw blocked();
    const signal=entry.abort.signal,value=await this.status({signal});signal.throwIfAborted();
    if(!inactive(value))throw blocked();
    entry.allowed=true;await media.play();entry.abort.signal.throwIfAborted();clearTimeout(deadline);entry.started.resolve();await entry.stopped.promise;
   }finally{
    clearTimeout(deadline);entry.abort.signal.removeEventListener('abort',interrupt);media.pause();entry.allowed=false;for(const event of ['pause','ended','error','emptied'])media.removeEventListener(event,finish);if(this.media.get(media)===entry)this.media.delete(media);
   }
  });
  held.catch(error=>entry.started.reject(error));return entry.started.promise;
 }
 close(){if(this.closed)return;this.closed=true;this.waiting?.abort();this.pauseAll();this.capture?.();this.capture=null;this.channel?.removeEventListener('message',this.onMessage);this.channel?.close();this.root?.removeEventListener('play',this.onPlay,true)}
}
