import test from 'node:test';import assert from 'node:assert/strict';
const m=await import('../public/ui/scroll-model.js').catch(()=>({}));
test('scrollbar reflects the visible fraction, clamps overscroll and preserves min thumb',()=>{
 assert.equal(typeof m.scrollMetrics,'function');
 assert.deepEqual(m.scrollMetrics({content:1000,viewport:200,position:400,track:100,minThumb:24}),{thumb:24,offset:38,max:800,atStart:false,atEnd:false});
 const end=m.scrollMetrics({content:1000,viewport:200,position:900,track:100,minThumb:24});assert.equal(end.offset,76);assert.equal(end.atEnd,true);
 const no=m.scrollMetrics({content:100,viewport:200,position:0,track:100,minThumb:24});assert.equal(no.max,0);assert.equal(no.thumb,100);assert.equal(no.atStart,true);assert.equal(no.atEnd,true);
});
test('one-pixel overflow and zero track never yield NaN or escape the rail',()=>{
 assert.equal(typeof m.scrollMetrics,'function');
 assert.equal(m.scrollMetrics({content:201,viewport:200,position:1,track:100,minThumb:24}).atEnd,true);
 const zero=m.scrollMetrics({content:1000,viewport:0,position:0,track:0,minThumb:24});assert.equal(zero.thumb,0);assert.equal(zero.offset,0);
});
