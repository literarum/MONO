import test from 'node:test';import assert from 'node:assert/strict';import {execFileSync} from 'node:child_process';import {mkdtemp,rm} from 'node:fs/promises';import {tmpdir} from 'node:os';import path from 'node:path';
import {DefectMeter} from '../backend/audio/defects.mjs';import {analyzeAudio} from '../backend/audio/analyze.mjs';import {smartPreset,recommendProfile} from '../backend/audio/profiles.mjs';import {prepareAudio} from '../backend/audio/prepare.mjs';
const have=tool=>{try{execFileSync(tool,['-version'],{stdio:'ignore'});return true}catch{return false}};
const skip=!(have('ffmpeg')&&have('ffprobe'))&&'ffmpeg is not installed';
// speech-like: a voiced tone that comes and goes (3.6 s of «speech», 1.4 s pauses)
const voice="sine=frequency=210:duration=30[v];[v]volume=eval=frame:volume='0.5*lt(mod(t,5),3.6)'";
function make(dir,name,{hum=0,noise=0,gain=1,dc=0}={}){
 const file=path.join(dir,name),inputs=['-f','lavfi','-i',`sine=frequency=210:duration=30`,'-f','lavfi','-i','sine=frequency=50:duration=30','-f','lavfi','-i','sine=frequency=100:duration=30','-f','lavfi','-i','anoisesrc=color=white:amplitude=1:duration=30'];
 const graph=`[0]volume=eval=frame:volume='${gain}*0.5*lt(mod(t\\,5)\\,3.6)'[v];[1]volume=${hum}[h1];[2]volume=${hum/2}[h2];[3]volume=${noise}[n];[v][h1][h2][n]amix=inputs=4:normalize=0,dcshift=${dc}`;
 execFileSync('ffmpeg',['-v','error',...inputs,'-filter_complex',graph,'-ar','48000','-ac','1','-y',file]);return file;
}
test('the meter finds a 50 Hz hum with its harmonic, a DC shift and the noise floor; a clean tone has none',()=>{
 const rate=8000,meter=new DefectMeter(rate),clean=new DefectMeter(rate);
 for(let n=0;n<rate*12;n++){const t=n/rate,speaking=(t%5)<3.6;const voice=speaking?.4*Math.sin(2*Math.PI*210*t):0;const hum=.02*Math.sin(2*Math.PI*50*t)+.01*Math.sin(2*Math.PI*100*t);
  meter.push(voice+hum+.01);clean.push(voice+(Math.random()-.5)*.002)}
 const found=meter.result(),none=clean.result();
 assert.equal(found.hum?.hz,50);assert.ok(found.hum.strengthDb>=10);assert.match(found.hum.harmonics,/50/);assert.ok(Math.abs(found.dcOffset-.01)<.002);
 assert.equal(none.hum,null);assert.ok(none.noise.snrDb>30,`clean SNR ${none.noise.snrDb}`);assert.ok(none.speechFraction>.5&&none.speechFraction<.9);
});
test('the smart chain repairs only what was found and explains each step; clean audio gets no denoiser',()=>{
 const base={loudness:{valid:true,integrated:-20,range:5},clipping:{fraction:0}};
 const humChain=smartPreset({...base,defects:{dcOffset:0,hum:{hz:50,strengthDb:22,harmonics:'50,100'},noise:{snrDb:30},speechFraction:.7}});
 assert.match(humChain.preFilter,/equalizer=f=50:t=q:w=12:g=-28,equalizer=f=100:t=q:w=12:g=-28/);assert.doesNotMatch(humChain.preFilter,/afftdn/);assert.match(humChain.reason,/гул электросети 50 Гц/);assert.match(humChain.reason,/шумоподавление не включаем/);
 const noisy=smartPreset({...base,defects:{dcOffset:0,hum:null,noise:{snrDb:8},speechFraction:.6}});assert.match(noisy.preFilter,/afftdn/);
 const clipped=smartPreset({...base,clipping:{fraction:.01},defects:{dcOffset:0,hum:null,noise:{snrDb:30},speechFraction:.6}});assert.match(clipped.preFilter,/adeclip/);
 const clean=recommendProfile({...base,defects:{dcOffset:0,hum:null,noise:{snrDb:30},speechFraction:.6}});assert.notEqual(clean.profile,'smart');assert.match(clean.reason,/шумоподавление не включаем/);
});
test('real audio: a humming recording is found, repaired by «Авто» and keeps its exact length',{skip,timeout:120000},async t=>{
 const dir=await mkdtemp(path.join(tmpdir(),'mono-smart-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const humming=make(dir,'hum.wav',{hum:.06,noise:.0005}),clean=make(dir,'clean.wav',{noise:.0005});
 const a=await analyzeAudio(humming),b=await analyzeAudio(clean);
 assert.equal(a.defects.hum?.hz,50,JSON.stringify(a.defects));assert.equal(b.defects.hum,null,JSON.stringify(b.defects));
 const out=path.join(dir,'prepared.flac'),result=await prepareAudio(humming,{output:out,profile:'auto'});
 assert.equal(result.chosenProfile,'smart');assert.equal(result.frames,a.frames);
 const after=await analyzeAudio(out);assert.ok(!after.defects.hum||after.defects.hum.strengthDb<a.defects.hum.strengthDb-25,`hum ${a.defects.hum.strengthDb} dB → ${after.defects.hum?.strengthDb} dB`);
});
