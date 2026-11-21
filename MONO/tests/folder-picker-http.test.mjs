import test from 'node:test';import assert from 'node:assert/strict';import {createServer} from 'node:http';import {once} from 'node:events';
import {libraryRoute} from '../backend/local/library-routes.mjs';

test('folder selection failure keeps its public code and identifies the failed action without leaking diagnostics',async t=>{
 let method;
 const worker={async call(name){method=name;const error=new Error('Synthetic private folder C:/secret and import traceback');error.code='PICKER_UNAVAILABLE';throw error}};
 const server=createServer((req,res)=>{void libraryRoute(req,res,new URL(req.url,'http://localhost'),worker)});
 server.listen(0,'127.0.0.1');await once(server,'listening');t.after(()=>new Promise(resolve=>server.close(resolve)));
 const response=await fetch(`http://127.0.0.1:${server.address().port}/api/local/library/choice`,{method:'POST',headers:{'Content-Type':'application/json'},body:'{"id":"own-picker-fixture"}'});
 assert.equal(method,'folder.poll');assert.equal(response.status,503);assert.equal(response.headers.get('cache-control'),'no-store');
 assert.deepEqual(await response.json(),{code:'PICKER_UNAVAILABLE',error:'Не удалось открыть системное окно выбора папки.'});
});

test('directory errors explain the next action and never expose worker exception text',async t=>{
 let code='NOT_LIBRARY';
 const worker={async call(){const error=new Error('PRIVATE C:/secret-folder token=private');error.code=code;throw error}};
 const server=createServer((req,res)=>{void libraryRoute(req,res,new URL(req.url,'http://localhost'),worker)});
 server.listen(0,'127.0.0.1');await once(server,'listening');t.after(()=>new Promise(resolve=>server.close(resolve)));
 for(const [next,status,message] of [
  ['NOT_LIBRARY',400,'В этой папке нет архива MONO. Для нового архива выберите пустую папку.'],
  ['INVALID_CHOICE',400,'Выбор папки больше не действует. Выберите папку ещё раз.'],
  ['PICKER_BUSY',503,'Окно выбора папки уже открыто. Завершите выбор или отмените его.'],
  ['NETWORK_LIBRARY',503,'Выберите папку на локальном диске компьютера.'],
  ['UNEXPECTED_PRIVATE_ERROR',503,'Операция с архивом не выполнена']
 ]){
  code=next;const response=await fetch(`http://127.0.0.1:${server.address().port}/api/local/library/configure`,{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});
  assert.equal(response.status,status);assert.equal(response.headers.get('cache-control'),'no-store');
  assert.deepEqual(await response.json(),{code,error:message});
 }
});
