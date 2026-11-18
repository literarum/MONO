// Real-browser regression for the default recording path (fake microphone).
// Run: npm run test:e2e   (needs Playwright with Chromium, Python 3 and FFmpeg)
// Unit tests passed while every default recording failed; only this catches it.
import test from 'node:test';import assert from 'node:assert/strict';
import {localServer} from '../helpers/local-server.mjs';import {createRequire} from 'node:module';
import {spawnSync} from 'node:child_process';import {writeFileSync,mkdtempSync} from 'node:fs';import {tmpdir} from 'node:os';import path from 'node:path';
// MONO_E2E_REAL_AUDIO=1: use the machine's real devices (CI: VB-CABLE playing a tone)
// and require audible audio. MONO_E2E_MODE=browser forces the browser engine.
const REAL=process.env.MONO_E2E_REAL_AUDIO==='1',MODE=process.env.MONO_E2E_MODE||null;

let playwright=null;
// Optional dev dependency: local install, or a global one via NODE_PATH.
try{playwright=await import('playwright')}catch{try{playwright=createRequire(import.meta.url)('playwright')}catch{}}

test('default studio settings record, pause, resume, stop and play back from the archive',{skip:!playwright&&'playwright is not installed'},async t=>{
 const server=await localServer(t);
 const browser=await playwright.chromium.launch({args:['--use-fake-ui-for-media-stream',...(REAL?[]:['--use-fake-device-for-media-stream'])]});t.after(()=>browser.close());
 const context=await browser.newContext();await context.grantPermissions(['microphone'],{origin:server.url});
 const page=await context.newPage();const errors=[];page.on('pageerror',error=>errors.push(error.message));
 await page.goto(server.url+'/');
 // Same API the onboarding uses; keep the saved capture mode at its default.
 await page.evaluate(async mode=>{
  const {csrf}=await (await fetch('/api/local/session')).json();const headers={'Content-Type':'application/json','X-Mono-CSRF':csrf};
  await fetch('/api/local/library/configure',{method:'POST',headers,body:JSON.stringify({useDefault:true})});
  await fetch('/api/local/preferences',{method:'PATCH',headers,body:JSON.stringify({onboarding:{completed:true,keySkipped:true,soundTested:true},...(mode?{capture:{mode}}:{})})});
 },MODE);
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
 if(REAL){
  // The recorded file must carry the tone, not silence.
  const bytes=await page.evaluate(async()=>{const {items}=await (await fetch('/api/local/records?limit=10&q=&trash=false')).json();return Array.from(new Uint8Array(await (await fetch('/api/local/records/'+items[0].id+'/audio')).arrayBuffer()))});
  const dir=mkdtempSync(path.join(tmpdir(),'mono-e2e-')),file=path.join(dir,'take.audio');writeFileSync(file,Buffer.from(bytes));
  const probe=spawnSync('ffmpeg',['-hide_banner','-i',file,'-af','volumedetect','-f','null','-'],{encoding:'utf8'});
  const peak=Number(/max_volume:\s*(-?[\d.]+) dB/.exec(probe.stderr)?.[1]);console.log('recorded peak dBFS',peak,'engine',MODE||'default');
  assert.ok(peak>-40,'recording must contain the test tone, got '+peak+' dBFS');
 }
 assert.deepEqual(errors,[]);
});
