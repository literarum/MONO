import test from 'node:test';import assert from 'node:assert/strict';
import {PcmCapture,pcmWave} from '../public/microphone-pcm.js';
test('PCM keeps exact sample count, mono mix, clipping and transferable chunk boundaries',()=>{
 const chunks=[],ended=[];const capture=new PcmCapture(8000,p=>chunks.push(p),p=>ended.push(p));
 const a=new Float32Array(16003).fill(1),b=new Float32Array(16003).fill(-.5);capture.append([a,b]);capture.stop();
 assert.deepEqual(chunks.map(p=>[p.index,p.frames]),[[0,16000],[1,3]]);assert.deepEqual(ended,[16003]);assert.equal(new Int16Array(chunks[0].pcm)[0],8192);
 const bytes=pcmWave(chunks[1].pcm,8000);assert.equal(bytes.byteLength,50);const v=new DataView(bytes.buffer);assert.equal(v.getUint32(40,true),6);assert.equal(v.getUint16(22,true),1);assert.equal(v.getUint32(24,true),8000);
});
test('pause writes actual zero PCM and preserves every sample on the timeline',()=>{
 const chunks=[],capture=new PcmCapture(8000,p=>chunks.push(p),()=>{});
 capture.append([new Float32Array(3).fill(.5)]);assert.equal(capture.setPaused(true),3);capture.append([new Float32Array(4).fill(.8)]);assert.equal(capture.setPaused(false),7);capture.append([new Float32Array(2).fill(-.5)]);capture.stop();
 assert.deepEqual([...new Int16Array(chunks[0].pcm)],[16384,16384,16384,0,0,0,0,-16384,-16384]);assert.equal(chunks[0].frames,9);capture.append([new Float32Array(2)]);assert.equal(chunks.length,1);
});
test('invalid rates and nonfinite microphone samples fail instead of making believable silent audio',()=>{
 assert.throws(()=>new PcmCapture(1,()=>{},()=>{}));const c=new PcmCapture(8000,()=>{},()=>{});assert.throws(()=>c.append([Float32Array.of(NaN)]));
});
test('meter reports real current signal before the first durable two-second chunk',()=>{
 const c=new PcmCapture(8000,()=>{},()=>{});const level=c.append([Float32Array.of(.5,-.25)]);
 assert.ok(level);assert.equal(level.peak,.5);assert.equal(level.rms,Math.sqrt((.5*.5+.25*.25)/2));assert.equal(level.clippedFrames,0);
 c.setPaused(true);assert.equal(c.append([Float32Array.of(.8,.9)]).rms,0);
});
