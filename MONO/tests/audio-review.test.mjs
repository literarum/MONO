import test from 'node:test';import assert from 'node:assert/strict';
let ReviewPlayer;try{({ReviewPlayer}=await import('../public/ui/player.js'))}catch{}
class Audio extends EventTarget{
 constructor(){super();this.paused=true;this.duration=10;this.readyState=4;this._time=0;this.playbackRate=1;this.src='';this.playCalls=0}
 set currentTime(value){this._time=value;queueMicrotask(()=>this.dispatchEvent(new Event('seeked')))}get currentTime(){return this._time}
 load(){this.readyState=this.src?4:0;queueMicrotask(()=>this.dispatchEvent(new Event('loadedmetadata')))}removeAttribute(){this.src=''}
 async play(){this.paused=false;this.playCalls++;this.dispatchEvent(new Event('play'))}pause(){if(this.paused)return;this.paused=true;this.dispatchEvent(new Event('pause'))}
}
const context=()=>({currentTime:0,destination:{},resume:async()=>{},close:async()=>{},createMediaElementSource:()=>({connect(){}}),createGain:()=>({connect(){},gain:{value:0,cancelScheduledValues(){},setValueAtTime(value){this.value=value},linearRampToValueAtTime(value){this.value=value}}})});
function make(t,options={}){assert.ok(ReviewPlayer,'Unified review player is missing');const original=new Audio(),prepared=new Audio(),player=new ReviewPlayer({original,prepared,contextFactory:context,play:audio=>audio.play(),fadeMs:0,...options});t.after(()=>player.destroy());player.load({originalURL:'/original',preparedURL:'/prepared',analysis:{original:{loudness:{integrated:-25,valid:true}},prepared:{loudness:{integrated:-15,valid:true}}}});return {player,original,prepared}}
test('one audible branch preserves position/rate/volume and equal-loudness comparison attenuates only the louder variant',async t=>{
 const {player,original,prepared}=make(t);await player.play();await player.seek(4.25);player.setRate(1.5);player.setVolume(.8);await player.switchVariant('prepared');assert.equal(original.paused,true);assert.equal(prepared.paused,false);assert.equal(prepared.currentTime,4.25);assert.equal(prepared.playbackRate,1.5);assert.equal(player.snapshot.variant,'prepared');assert.ok(Math.abs(player.snapshot.gains.prepared-.8*10**(-10/20))<.00001);assert.equal(player.snapshot.gains.original,0);player.setMatching(false);assert.equal(player.snapshot.gains.prepared,.8);player.pause();assert.equal(prepared.paused,true);await player.switchVariant('original');assert.equal(original.currentTime,4.25);assert.equal(original.paused,true);
});
test('rapid switch/seek and replacing prepared audio never autoplay a superseded variant',async t=>{
 const {player,original,prepared}=make(t);await player.play();const old=player.switchVariant('prepared'),ignored=old.catch(error=>assert.equal(error.name,'AbortError'));const latest=player.switchVariant('original');await Promise.all([ignored,latest]);assert.equal(original.paused,false);assert.equal(prepared.paused,true);player.setPrepared(null);await assert.rejects(player.switchVariant('prepared'));assert.equal(prepared.paused,true);await player.seek(7);assert.equal(player.snapshot.time,7);player.load({originalURL:'/another'});assert.equal(original.paused,true);assert.equal(player.snapshot.time,0);assert.equal(player.snapshot.variant,'original');
});
test('capture rejection cannot leave a second playing branch, null LUFS does not invent matching gain',async t=>{
 const {player,original,prepared}=make(t,{play:async()=>{throw Object.assign(new Error('Stop capture'),{code:'PLAYBACK_DURING_CAPTURE'})}});player.setPrepared('/new',{original:{loudness:{valid:false,integrated:null}},prepared:{loudness:{valid:true,integrated:-15}}});await assert.rejects(player.play(),error=>error.code==='PLAYBACK_DURING_CAPTURE');assert.equal(original.paused,true);assert.equal(prepared.paused,true);assert.equal(player.snapshot.matchingAvailable,false);assert.equal(player.snapshot.playing,false);
});
test('seek immediately after a variant click applies to the newly requested branch',async t=>{
 const {player,original,prepared}=make(t);await player.play();const switching=player.switchVariant('prepared').catch(error=>assert.equal(error.name,'AbortError'));await player.seek(6);await switching;assert.equal(player.snapshot.variant,'prepared');assert.equal(prepared.currentTime,6);assert.equal(prepared.paused,false);assert.equal(original.paused,true);
});
test('Play after the end starts the record over instead of sitting on the last frame',async t=>{
 const {player,original}=make(t);await player.play();await player.seek(10);original.ended=true;original.pause();original.dispatchEvent(new Event('ended'));
 await player.play();assert.equal(original.currentTime,0);assert.equal(original.paused,false);
 original.ended=false;await player.seek(9.9);player.pause();await player.play();assert.equal(original.currentTime,0,'a pause in the last quarter-second counts as the end');
 await player.seek(5);player.pause();await player.play();assert.equal(original.currentTime,5,'a pause in the middle resumes where it was');
});
