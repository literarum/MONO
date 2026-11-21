import test from 'node:test';import assert from 'node:assert/strict';import {AudioPreparation} from '../backend/audio/preparation-service.mjs';
test('bounded request history retains cancellation before a delayed POST instead of resurrecting it under pressure',async()=>{
 let reads=0;const service=new AudioPreparation({}, {sources:async()=>{reads++;throw Error('Canceled request must never read source')}}),first=crypto.randomUUID();service.cancel(first);
 for(let i=1;i<64;i++)service.cancel(crypto.randomUUID());
 assert.throws(()=>service.cancel(crypto.randomUUID()),e=>e.code==='PREPARATION_BUSY');
 assert.equal((await service.create(crypto.randomUUID(),{requestId:first,profile:'original'})).state,'canceled');assert.equal(reads,0);assert.equal(service.jobs.size,64);await service.close();
});
test('invalid cancellation identities cannot allocate history and unsettled work cannot be pruned from shutdown',()=>{
 const service=new AudioPreparation({},{});assert.throws(()=>service.cancel('-'.repeat(36)),e=>e.code==='INVALID_PREPARATION');assert.equal(service.jobs.size,0);
 const id=crypto.randomUUID();service.jobs.set(id,{id,state:'canceled',settled:false});for(let i=1;i<64;i++)service.jobs.set(crypto.randomUUID(),{state:'ready',settled:true});service.prune();assert.ok(service.jobs.has(id),'cleanup must remain tracked until actual work settles');
});
