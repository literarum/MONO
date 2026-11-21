import test from 'node:test';
import assert from 'node:assert/strict';
import {TestLockManager} from './helpers/lock-manager.mjs';
import {NativeCaptureController} from '../public/native-capture.js';
let MediaInterlock;try{({MediaInterlock}=await import('../public/media-interlock.js'))}catch{}
const locks=new TestLockManager();
const tick=()=>new Promise(resolve=>setImmediate(resolve));
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve}};
class Media extends EventTarget{
 paused=true;calls=0;
 async play(){this.calls++;this.paused=false;this.dispatchEvent(new Event('play'))}
 pause(){this.paused=true;this.dispatchEvent(new Event('pause'))}
}
const idle=async()=>({state:'ready'});
const make=(t,options={})=>{assert.ok(MediaInterlock,'Playback/capture interlock is missing');const value=new MediaInterlock({locks,status:idle,timeoutMs:200,...options});t.after(()=>value.close());return value};

test('native start waits for asynchronous playback quiescence and rejects without starting when it fails',async()=>{
 const barrier=deferred();let starts=0;const controller=new NativeCaptureController({init:async()=>{},status:idle,start:async()=>{starts++;return {state:'recording'}},stop:async()=>({state:'ready'})},{onIntent:()=>barrier.promise});await controller.connect();
 try{const starting=controller.start({mode:'system'});await tick();assert.equal(starts,0,'Audio acquisition raced ahead of the playback barrier');barrier.resolve();await starting;assert.equal(starts,1);await controller.stop()}finally{barrier.resolve();await controller.close()}
 const rejecting=new NativeCaptureController({init:async()=>{},status:idle,start:async()=>{starts++;return {state:'recording'}}},{onIntent:async()=>{throw new Error('Player did not stop')}});await rejecting.connect();try{await assert.rejects(rejecting.start({mode:'system'}),/Player did not stop/);assert.equal(starts,1);assert.equal(rejecting.snapshot.state,'ready')}finally{await rejecting.close()}
});

test('shared playback leases quiesce another window before exclusive capture and deny playback until confirmed stop',async t=>{
 const name='mono-test-'+crypto.randomUUID(),first=make(t,{name}),second=make(t,{name});const media=new Media();await first.play(media);assert.equal(media.paused,false);
 const capture=second.beforeCapture();await tick();assert.equal(media.paused,false,'A lock request cannot pretend another window is already paused');first.pauseAll();await capture;assert.equal(media.paused,true);
 await assert.rejects(first.play(media),error=>error.code==='PLAYBACK_DURING_CAPTURE');assert.equal(media.calls,1);second.observe({state:'recording',connected:false});await assert.rejects(first.play(media));await second.observe({state:'ready',connected:true});await first.play(media);assert.equal(media.calls,2);
});

test('an unresponsive player fails closed without stealing its lock',async t=>{
 const name='mono-test-'+crypto.randomUUID(),first=make(t,{name}),second=make(t,{name,timeoutMs:35}),media=new Media();await first.play(media);await assert.rejects(second.beforeCapture(),error=>error.code==='PLAYBACK_NOT_STOPPED');assert.equal(media.paused,false);first.pauseAll();await second.beforeCapture();await second.observe({state:'idle',connected:true});await first.play(media);
});

test('a reloaded observer checks supervisor inside its playback lock; unavailable status and active capture never play',async t=>{
 const name='mono-test-'+crypto.randomUUID();let state='recording';const value=make(t,{name,status:async()=>{if(state==='offline')throw new Error('offline');return {state}}}),media=new Media();await assert.rejects(value.play(media),error=>error.code==='PLAYBACK_DURING_CAPTURE');state='paused';await assert.rejects(value.play(media));state='offline';await assert.rejects(value.play(media));assert.equal(media.calls,0);state='ready';await value.play(media);assert.equal(media.calls,1);
});

test('pending playback cannot start after capture intent, even when a delayed idle status arrives',async t=>{
 const name='mono-test-'+crypto.randomUUID(),response=deferred(),first=make(t,{name,status:()=>response.promise}),second=make(t,{name}),media=new Media();const playing=first.play(media);const denied=assert.rejects(playing,error=>error.name==='AbortError');await tick();first.pauseAll();const capture=second.beforeCapture();response.resolve({state:'ready'});await denied;await capture;assert.equal(media.calls,0);
});

test('play rejection, media end, and shutdown release shared locks; canceled capture cannot acquire later',async t=>{
 const name='mono-test-'+crypto.randomUUID(),first=make(t,{name}),second=make(t,{name}),media=new Media();media.play=async()=>{throw new Error('Decoder failed')};await assert.rejects(first.play(media),/Decoder failed/);await second.beforeCapture();await second.observe({state:'ready',connected:true});
 media.play=Media.prototype.play;await first.play(media);media.paused=true;media.dispatchEvent(new Event('ended'));await second.beforeCapture();await second.observe({state:'ready',connected:true});await first.play(media);const abort=new AbortController(),pending=second.beforeCapture({signal:abort.signal});const denied=assert.rejects(pending,error=>error.name==='AbortError');abort.abort();await denied;first.close();await second.beforeCapture();
});

test('unknown supervisor state and missing coordination support fail closed',async t=>{
 const value=make(t,{name:'mono-test-'+crypto.randomUUID(),status:async()=>({state:'new-unknown-state'})}),media=new Media();await assert.rejects(value.play(media));assert.equal(media.calls,0);const unsupported=make(t,{locks:null});await assert.rejects(unsupported.play(media),error=>error.code==='MEDIA_COORDINATION_UNAVAILABLE');await assert.rejects(unsupported.beforeCapture(),error=>error.code==='MEDIA_COORDINATION_UNAVAILABLE');
});

test('test lock model honors browser sharing, fairness, cancellation and release',async()=>{
 const exercise=async manager=>{
  const name='mono-conformance-'+crypto.randomUUID(),one=deferred(),two=deferred(),entered1=deferred(),entered2=deferred(),enteredExclusive=deferred(),exclusiveStop=deferred();
  const a=manager.request(name,{mode:'shared'},async()=>{entered1.resolve();await one.promise}),b=manager.request(name,{mode:'shared'},async()=>{entered2.resolve();await two.promise});await Promise.all([entered1.promise,entered2.promise]);
  const abort=new AbortController(),waiting=manager.request(name,{signal:abort.signal},()=>{}),cancel=waiting.then(()=>false,error=>error.name==='AbortError');
  const fair=await manager.request(name,{mode:'shared',ifAvailable:true},lock=>lock===null);abort.abort();const canceled=await cancel;const shared=await manager.request(name,{mode:'shared',ifAvailable:true},lock=>Boolean(lock));
  const exclusive=manager.request(name,{},async()=>{enteredExclusive.resolve();await exclusiveStop.promise;throw new Error('release on error')}),rejected=exclusive.then(()=>false,error=>error.message==='release on error');
  one.resolve();await a;const stillBlocked=await manager.request(name,{mode:'shared',ifAvailable:true},lock=>lock===null);two.resolve();await b;await enteredExclusive.promise;exclusiveStop.resolve();const releasedAfterError=await rejected,final=await manager.request(name,{ifAvailable:true},lock=>Boolean(lock));return {fair,canceled,shared,stillBlocked,releasedAfterError,final};
 };
 const expected={fair:true,canceled:true,shared:true,stillBlocked:true,releasedAfterError:true,final:true};assert.deepEqual(await exercise(new TestLockManager()),expected);
});
