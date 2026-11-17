import test from 'node:test';import assert from 'node:assert/strict';
import {localServer} from './helpers/local-server.mjs';
test('application modules and styles revalidate so an update cannot reuse an old dependency',async t=>{
 const server=await localServer(t);
 for(const asset of ['/app.js','/ui/index.js','/ui/controls.css']){
  const r=await fetch(server.url+asset);assert.equal(r.status,200);assert.match(r.headers.get('cache-control'),/no-cache/,`${asset} must revalidate`);await r.arrayBuffer();
 }
});
