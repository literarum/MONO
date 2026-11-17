// Real-browser regression for the default recording path (fake microphone).
// Run: npm run test:e2e   (needs Playwright with Chromium, Python 3 and FFmpeg)
// Unit tests passed while every default recording failed; only this catches it.
import test from 'node:test';import assert from 'node:assert/strict';
import {localServer} from '../helpers/local-server.mjs';import {createRequire} from 'node:module';

let playwright=null;
// Optional dev dependency: local install, or a global one via NODE_PATH.
try{playwright=await import('playwright')}catch{try{playwright=createRequire(import.meta.url)('playwright')}catch{}}

test('default studio settings record, pause, resume, stop and play back from the archive',{skip:!playwright&&'playwright is not installed'},async t=>{
 const server=await localServer(t);
 const browser=await playwright.chromium.launch({args:['--use-fake-ui-for-media-stream','--use-fake-device-for-media-stream']});t.after(()=>browser.close());
 const context=await browser.newContext();await context.grantPermissions(['microphone'],{origin:server.url});
 const page=await context.newPage();const errors=[];page.on('pageerror',error=>errors.push(error.message));
 await page.goto(server.url+'/');
 // Same API the onboarding uses; keep the saved capture mode at its default.
 await page.evaluate(async()=>{
  const {csrf}=await (await fetch('/api/local/session')).json();const headers={'Content-Type':'application/json','X-Mono-CSRF':csrf};
  await fetch('/api/local/library/configure',{method:'POST',headers,body:JSON.stringify({useDefault:true})});
  await fetch('/api/local/preferences',{method:'PATCH',headers,body:JSON.stringify({onboarding:{completed:true,keySkipped:true,soundTested:true}})});
 });
 await page.reload();await page.click('.nav-link[data-view=record]');
 const start=page.locator('#start-record');await start.waitFor({state:'visible'});await page.waitForFunction(()=>!document.querySelector('#start-record').disabled);
 await start.click();
 await page.waitForFunction(()=>/Подтверждено в архиве/.test(document.querySelector('#record-saved').textContent),null,{timeout:20000});
 await page.waitForTimeout(3000);await page.click('#pause-record');await page.waitForTimeout(2500);
 assert.match(await page.textContent('#record-state'),/Пауза/);
 await page.click('#pause-record');await page.waitForTimeout(3000);await page.click('#stop-record');
 await page.waitForFunction(()=>[...document.querySelectorAll('.toast')].some(toast=>/Запись сохранена/.test(toast.textContent)),null,{timeout:20000});
 const result=await page.evaluate(async()=>{
  const {items}=await (await fetch('/api/local/records?limit=10&q=&trash=false')).json();const record=items[0];
  const audio=await fetch('/api/local/records/'+record.id+'/audio');
  return {status:record.status,duration:record.duration,gaps:record.gapMarkers||[],audio:audio.status,type:audio.headers.get('content-type'),bytes:(await audio.arrayBuffer()).byteLength};
 });
 assert.equal(result.status,'saved');assert.ok(result.duration>7,'recorded time includes the pause');
 assert.equal(result.gaps.length,1);assert.equal(result.gaps[0].reason,'paused');
 assert.equal(result.audio,200);assert.match(result.type,/^audio\//);assert.ok(result.bytes>1000);
 assert.deepEqual(errors,[]);
});
