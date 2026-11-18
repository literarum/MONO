import test from 'node:test';import assert from 'node:assert/strict';
import {addBookmark,SaveClock,BatteryWatch,LevelPreview} from '../public/studio-extras.js';
import {speakerFor,labelSegments} from '../public/speakers.js';
import {binsFromSamples} from '../backend/audio/speakers.mjs';
test('bookmarks are sorted, rounded and deduplicated within a second',()=>{
 let marks=addBookmark([],12.34);marks=addBookmark(marks,3);marks=addBookmark(marks,12.9);
 assert.deepEqual(marks,[{at:3,label:'Важно'},{at:12.3,label:'Важно'}]);
});
test('save clock reports time since the archive last confirmed new audio',()=>{
 let t=0;const clock=new SaveClock(()=>t);clock.observe('s',1);t=1200;assert.equal(clock.text(),'только что');
 t=6000;assert.equal(clock.text(),'6 с назад');clock.observe('s',2);assert.equal(clock.text(),'только что');t=17000;assert.ok(clock.stale());
});
test('battery watch warns once at 20 % and once at 10 % while recording on battery',async()=>{
 const messages=[],device={level:.19,charging:false,dischargingTime:1800,addEventListener(){}};
 const watch=new BatteryWatch({battery:async()=>device,onWarn:m=>messages.push(m)});watch.active=true;
 await watch.check();await watch.check();device.level=.09;await watch.check();await watch.check();
 assert.equal(messages.length,2);assert.match(messages[0],/19 %.*30 мин/);
 device.charging=true;device.level=.05;watch.reset();await watch.check();assert.equal(messages.length,2);
});
test('level preview never prompts: it opens the microphone only when permission is already granted',async()=>{
 let opened=0;const devices={getUserMedia:async()=>{opened++;return {getTracks:()=>[]}}};
 const denied=new LevelPreview({devices,permissions:{query:async()=>({state:'prompt'})}});assert.equal(await denied.start(),false);assert.equal(opened,0);
 const analyser={fftSize:0,getFloatTimeDomainData(b){b.fill(.5)}};
 const granted=new LevelPreview({devices,permissions:{query:async()=>({state:'granted'})},contextFactory:()=>({createAnalyser:()=>analyser,createMediaStreamSource:()=>({connect(){}}),close:async()=>{}})});
 assert.equal(await granted.start(),true);assert.equal(opened,1);assert.ok(Math.abs(granted.rms()-.5)<1e-6);granted.stop();assert.equal(granted.active,false);
});
test('meeting labels: the louder track by 6 dB names the speaker, otherwise no label',()=>{
 const profile={bin:.5,tracks:{mic:[-20,-20,-70,-70,-30,-30],system:[-70,-70,-22,-22,-31,-31]}};
 assert.equal(speakerFor({start:0,end:1},profile),'me');assert.equal(speakerFor({start:1,end:2},profile),'others');
 assert.equal(speakerFor({start:2,end:3},profile),null);assert.equal(speakerFor({start:0,end:1},null),null);
 assert.deepEqual(labelSegments([{start:0,end:1,text:'a'}],profile).map(s=>s.speaker),['me']);
});
test('speaker profile bins RMS per window in dBFS',()=>{
 const state={sum:0,count:0,out:[]};binsFromSamples(new Float32Array(8).fill(.1),state,4);assert.deepEqual(state.out,[-20,-20]);
});
