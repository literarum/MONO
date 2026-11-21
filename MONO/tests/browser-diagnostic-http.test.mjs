import test from 'node:test';import assert from 'node:assert/strict';import {localServer} from './helpers/local-server.mjs';
test('browser diagnostics are local authenticated enums and cannot disclose exception/device data',async t=>{
 const server=await localServer(t),headers=await server.session(),path=server.url+'/api/local/capture/browser_diagnostic';
 const valid={operation:'start',stage:'worklet',code:'BROWSER_AUDIO_ERROR',errorName:'NotSupportedError'};
 const post=(body,h=headers)=>fetch(path,{method:'POST',headers:{...h,'Content-Type':'application/json'},body:JSON.stringify(body)});
 const denied=await post(valid,{Origin:server.url});assert.equal(denied.status,401);
 const foreign=await post(valid,{...headers,Origin:'https://example.invalid'});assert.equal(foreign.status,403);
 const noCsrf=await post(valid,{...headers,'X-Mono-CSRF':''});assert.equal(noCsrf.status,403);
 const response=await post(valid);assert.equal(response.status,200);assert.deepEqual(await response.json(),{received:true});
 for(const value of [{...valid,message:'PRIVATE_RAW_EXCEPTION'},{...valid,errorName:'PRIVATE_DEVICE_NAME'},{...valid,stage:'bad\nlog'},{...valid,operation:'unknown'}]){const invalid=await post(value);assert.equal(invalid.status,400)}
 const logs=server.logs();assert.ok(logs.includes('browser_capture_failure'));assert.ok(logs.includes('NotSupportedError'));assert.ok(!logs.includes('PRIVATE_RAW_EXCEPTION')&&!logs.includes('PRIVATE_DEVICE_NAME'));
});
