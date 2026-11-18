import test from 'node:test';import assert from 'node:assert/strict';
import {RETRYABLE,recoverySteps,pickInput,needsRepair,REPAIR} from '../public/autopilot.js';
import {CONSTRAINT_LADDER,BrowserMicrophoneClient} from '../public/browser-microphone.js';
import {microphoneChecks} from '../backend/local/preflight.mjs';
const report=inputs=>({available:true,inputs});
const mic=(id,extra={})=>({id,name:id,default:false,state:'active',muted:false,volume:.8,...extra});

test('recovery ladder: chosen devices → defaults → browser channel; at most two different steps',()=>{
 assert.deepEqual(recoverySteps({mode:'mic',inputId:'usb',outputId:null},true),[{mode:'mic',inputId:null,outputId:null},{mode:'browser',inputId:null,outputId:null}]);
 assert.deepEqual(recoverySteps({mode:'mic',inputId:null,outputId:null},true),[{mode:'browser',inputId:null,outputId:null}]);
 assert.deepEqual(recoverySteps({mode:'both',inputId:null,outputId:null},true),[{mode:'both',inputId:null,outputId:null}],'system audio is never silently dropped');
 assert.deepEqual(recoverySteps({mode:'system',inputId:null,outputId:'hdmi'},true),[{mode:'system',inputId:null,outputId:null}]);
 assert.equal(RETRYABLE.has('ACCESS_DENIED'),false,'a privacy decision is never retried around');
 assert.equal(RETRYABLE.has('DISK_FULL'),false);assert.equal(RETRYABLE.has('START_TIMEOUT'),true);
});
test('input choice: chosen if active, otherwise default with a fallback flag; disabled-only is reported',()=>{
 const r=report([mic('a',{default:true}),mic('b'),{id:'c',name:'c',default:false,state:'disabled',muted:null,volume:null}]);
 assert.equal(pickInput(r,'b').target.id,'b');assert.equal(pickInput(r,'b').fallback,false);
 assert.equal(pickInput(r,'gone').target.id,'a');assert.equal(pickInput(r,'gone').fallback,true);
 assert.equal(pickInput(r,null).target.id,'a');
 assert.equal(pickInput(report([{id:'c',name:'c',default:false,state:'disabled'}]),null).disabledOnly,true);
});
test('repair is needed for a muted endpoint or a near-zero level, never for a healthy one',()=>{
 assert.equal(needsRepair(mic('a',{muted:true})),true);assert.equal(needsRepair(mic('a',{volume:.02})),true);
 assert.equal(needsRepair(mic('a')),false);assert.equal(needsRepair(null),false);assert.equal(needsRepair(mic('a',{volume:null})),false);
 assert.deepEqual(REPAIR(mic('a')),{inputId:'a',mute:false,minimumVolume:.5});
});
test('pre-flight turns the Windows microphone view into checks; fixable ones carry the repair',()=>{
 const muted=microphoneChecks(report([mic('Микрофон (Realtek)',{default:true,muted:true})]));
 assert.equal(muted[0].id,'mic-muted');assert.deepEqual(muted[0].fix,{inputId:'Микрофон (Realtek)',mute:false,minimumVolume:.5});
 assert.equal(microphoneChecks(report([mic('m',{default:true,volume:.01})]))[0].id,'mic-level');
 assert.equal(microphoneChecks(report([{id:'x',name:'USB',default:false,state:'disabled'}]))[0].id,'mic-disabled');
 assert.equal(microphoneChecks(report([mic('Headset (Hands-Free AG Audio)',{default:true})]))[0].id,'mic-handsfree');
 assert.deepEqual(microphoneChecks(report([mic('ok',{default:true})])),[]);assert.deepEqual(microphoneChecks({available:false}),[]);
});
test('getUserMedia ladder: exact device → default → plain; NotReadable retried twice per rung; a denial is final',async()=>{
 assert.equal(CONSTRAINT_LADDER('x').length,3);assert.equal(CONSTRAINT_LADDER(null).length,2);
 const attempt=async script=>{const calls=[];const client=Object.create(BrowserMicrophoneClient.prototype);
  client.devices={getUserMedia:async c=>{calls.push(c.audio);const next=script.shift();if(next instanceof Error)throw next;return {getTracks:()=>[]}}};
  try{await client.acquire('usb',null,5000);return {ok:true,calls}}catch(error){return {ok:false,error:error.name,calls}}};
 const err=name=>Object.assign(new Error(name),{name});
 const busy=await attempt([err('NotReadableError'),err('NotReadableError'),err('NotReadableError'),'ok']);
 assert.equal(busy.ok,true);assert.equal(busy.calls.length,4);assert.equal(busy.calls[2].deviceId.exact,'usb');assert.equal(busy.calls[3].deviceId,undefined,'fell back to the default device');
 const recovered=await attempt([err('NotReadableError'),'ok']);assert.equal(recovered.calls.length,2);assert.equal(recovered.calls[1].deviceId.exact,'usb','a short retry keeps the chosen device');
 const denied=await attempt([err('NotAllowedError')]);assert.equal(denied.ok,false);assert.equal(denied.error,'NotAllowedError');assert.equal(denied.calls.length,1);
 const gone=await attempt([err('OverconstrainedError'),'ok']);assert.equal(gone.ok,true);assert.equal(gone.calls.length,2);
});
