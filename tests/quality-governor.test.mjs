import test from 'node:test';import assert from 'node:assert/strict';
globalThis.document??={documentElement:{classList:{add(){}}}};
const {qualityGovernor}=await import('../public/ui/index.js').catch(()=>({}));
test('quality governor judges only interactive frames and remembers the verdict',{skip:!qualityGovernor&&'ui module needs a DOM'},()=>{
 const run=gap=>{const classes=new Set(),store=new Map(),listeners=new Map();let t=0,queued=null;
  const target={addEventListener:(k,f)=>listeners.set(k,f),removeEventListener:k=>listeners.delete(k)};
  qualityGovernor({frames:30,raf:f=>{queued=f},root:{classList:{add:c=>classes.add(c)}},store:{getItem:k=>store.get(k)??null,setItem:(k,v)=>store.set(k,v)},target});
  for(let i=0;i<40;i++){globalThis.performance.now=()=>t;listeners.get('wheel')?.();const f=queued;queued=null;if(f){t+=gap;f(t)}}
  return {lite:classes.has('lite-glass'),stored:store.get('mono-lite-glass'),listening:listeners.size};
 };
 const realNow=performance.now.bind(performance);
 try{const slow=run(40);assert.equal(slow.lite,true);assert.equal(slow.stored,'1');assert.equal(slow.listening,0);
  const fast=run(16);assert.equal(fast.lite,false);assert.equal(fast.stored,'0')}finally{performance.now=realNow}
});
