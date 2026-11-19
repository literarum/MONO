// Real-browser checks of the studio features on the native capture path, driven by the
// fixture helper (tests/fixtures/audio-helper.py) instead of a sound card:
// global hotkey, bookmarks, two-track meeting profile, undo of trash, recovery card,
// and recording that continues after the audio device disappears.
import test from 'node:test';import assert from 'node:assert/strict';
import {localServer} from '../helpers/local-server.mjs';import {until} from '../helpers/until.mjs';import {createRequire} from 'node:module';
import {writeFileSync,chmodSync,mkdtempSync} from 'node:fs';import {tmpdir} from 'node:os';import path from 'node:path';import {fileURLToPath} from 'node:url';
let playwright=null;
try{playwright=await import('playwright')}catch{try{playwright=createRequire(import.meta.url)('playwright')}catch{}}
const FIXTURE=fileURLToPath(new URL('../fixtures/audio-helper.py',import.meta.url));
// The helper is started as an executable; a shell wrapper is enough off Windows.
const skip=!playwright?'playwright is not installed':process.platform==='win32'?'fixture helper wrapper needs a POSIX shell':false;
function helper(behavior){const dir=mkdtempSync(path.join(tmpdir(),'mono-helper-')),file=path.join(dir,'helper.sh');writeFileSync(file,`#!/bin/sh\nexec python3 '${FIXTURE}' "$@" --behavior ${behavior}\n`);chmodSync(file,0o755);return file}
async function open(t,server,mode='both'){
 const browser=await playwright.chromium.launch({args:['--use-fake-ui-for-media-stream','--use-fake-device-for-media-stream']});t.after(()=>browser.close());
 const context=await browser.newContext();await context.grantPermissions(['microphone'],{origin:server.url});
 const page=await context.newPage();page.errors=[];page.on('pageerror',error=>page.errors.push(error.message));
 await page.goto(server.url+'/');
 await page.evaluate(async mode=>{const {csrf}=await (await fetch('/api/local/session')).json();const headers={'Content-Type':'application/json','X-Mono-CSRF':csrf};
  await fetch('/api/local/library/configure',{method:'POST',headers,body:JSON.stringify({useDefault:true})});
  await fetch('/api/local/preferences',{method:'PATCH',headers,body:JSON.stringify({onboarding:{completed:true,keySkipped:true,soundTested:true},capture:{mode}})});},mode);
 await page.reload();await page.waitForFunction(()=>document.querySelector('#nav-count'));return page;
}
const records=page=>page.evaluate(async()=>(await (await fetch('/api/local/records?limit=10&q=&trash=false')).json()).items);

test('hotkey, bookmark, meeting profile, undo of trash and recovery card',{skip},async t=>{
 const token='k'.repeat(43);const server=await localServer(t,{MONO_AUDIO_HELPER:helper('impulse'),MONO_LAUNCHER_TOKEN:token});const page=await open(t,server);
 const press=()=>fetch(server.url+'/api/launcher/hotkey',{method:'POST',headers:{'X-Mono-Launcher-Token':token}});
 await page.waitForFunction(()=>!document.querySelector('#start-record').disabled);
 // A press before the window subscribed to /api/local/events is dropped on purpose
 // (a later window must never start recording by itself), so retry until it lands.
 let started=false;
 for(let i=0;i<10&&!started;i++){assert.equal((await press()).status,204);started=await page.waitForFunction(()=>!document.querySelector('#stop-record').hidden,null,{timeout:1500}).then(()=>true,()=>false)}
 assert.ok(started,'hotkey starts recording');
 await page.waitForFunction(()=>/Подтверждено/.test(document.querySelector('#record-saved').textContent),null,{timeout:15000});
 await page.keyboard.press('b');await page.waitForSelector('.toast:has-text("Отмечено")');
 await press();await page.waitForFunction(()=>!document.querySelector('#start-record').hidden,null,{timeout:15000});
 await until(page,async()=>{const {items}=await (await fetch('/api/local/records?limit=1&q=&trash=false')).json();return items[0]?.status==='saved'&&items[0]?.bookmarks?.length===1},null,{timeout:15000,polling:300});
 const [take]=await records(page);assert.deepEqual(take.tracks.map(track=>track.id).sort(),['mic','system']);
 const {profile}=await page.evaluate(async id=>(await fetch('/api/local/records/'+id+'/speakers')).json(),take.id);
 assert.ok(profile.tracks.mic.length>0&&profile.tracks.system.length>0,'two-track loudness profile');
 // Trash without a dialog, then «Вернуть».
 await page.evaluate(()=>{location.hash='#library';document.querySelectorAll('.toast').forEach(toast=>toast.remove())});
 await page.click(`[data-delete="${take.id}"]`);await page.click('.toast:has-text("в корзине") .toast-action');
 await until(page,async()=>(await (await fetch('/api/local/records?limit=5&q=&trash=false')).json()).items.length===1,null,{timeout:10000,polling:300});
 assert.deepEqual(page.errors,[]);
});

test('recording continues as a linked take when the audio device disappears',{skip},async t=>{
 const server=await localServer(t,{MONO_AUDIO_HELPER:helper('device-lost-once')});const page=await open(t,server);
 await page.click('.nav-link[data-view=record]');await page.waitForFunction(()=>!document.querySelector('#start-record').disabled);
 await page.click('#start-record');
 await page.waitForSelector('.toast:has-text("Запись продолжается")',{timeout:20000});
 assert.equal(await page.isHidden('#stop-record'),false,'still recording on the new take');
 await page.click('#stop-record');
 await until(page,async()=>{const {items}=await (await fetch('/api/local/records?limit=5&q=&trash=false')).json();return items.some(r=>/продолжение$/.test(r.title)&&r.status==='saved')},null,{timeout:15000,polling:300});
 const items=await records(page);assert.equal(items.length,2);assert.ok(items.some(r=>r.status==='interrupted'&&r.duration>0),'first part kept');
 assert.deepEqual(page.errors,[]);
});

test('background care: a microphone muted in Windows is switched back on without anyone pressing anything',{skip},async t=>{
 const server=await localServer(t,{MONO_AUDIO_HELPER:helper('muted')});const page=await open(t,server);
 await page.waitForSelector('.toast:has-text("MONO включил его")',{timeout:30000});
 const diagnosis=await page.evaluate(async()=>(await fetch('/api/local/capture/diagnose')).json());
 assert.equal(diagnosis.inputs[0].muted,false);
 await page.click('.nav-link[data-view=record]');await page.waitForFunction(()=>!document.querySelector('#start-record').disabled);await page.click('#start-record');
 await page.waitForFunction(()=>!document.querySelector('#stop-record').hidden,null,{timeout:15000});await page.click('#stop-record');
 assert.deepEqual(page.errors,[]);
});

test('autopilot: when the system module cannot open the microphone, the take continues on the browser channel',{skip},async t=>{
 const server=await localServer(t,{MONO_AUDIO_HELPER:helper('open-failure')});const page=await open(t,server,'mic');
 await page.click('.nav-link[data-view=record]');await page.waitForFunction(()=>!document.querySelector('#start-record').disabled);
 await page.click('#start-record');
 await page.waitForSelector('.toast:has-text("запасной канал")',{timeout:20000});
 await page.waitForFunction(()=>/Подтверждено в архиве/.test(document.querySelector('#record-saved').textContent),null,{timeout:20000});
 await page.waitForTimeout(1500);await page.click('#stop-record');
 await until(page,async()=>{const {items}=await (await fetch('/api/local/records?limit=5&q=&trash=false')).json();return items.some(r=>r.status==='saved'&&r.duration>0)},null,{timeout:20000,polling:300});
 assert.deepEqual(page.errors,[]);
});

test('the window survives a core restart: banner, then automatic reconnect with a working session',{skip:!playwright&&'playwright is not installed'},async t=>{
 const server=await localServer(t);const page=await open(t,server,'mic');
 await server.restart();
 await page.waitForSelector('.connection-banner',{timeout:15000}).catch(()=>{}); // may be brief
 await page.waitForFunction(()=>!document.querySelector('.connection-banner'),null,{timeout:30000});
 await page.waitForFunction(()=>document.readyState==='complete'&&document.querySelector('#nav-count'));
 const status=await page.evaluate(async()=>{const {csrf}=await (await fetch('/api/local/session')).json();return (await fetch('/api/local/ping',{method:'POST',headers:{'Content-Type':'application/json','X-Mono-CSRF':csrf},body:'{}'})).status});
 assert.equal(status,200);assert.deepEqual(page.errors,[]);
});

test('safety track: when the system module fails mid-take, the window’s independent copy restores the meeting',{skip},async t=>{
 const server=await localServer(t,{MONO_AUDIO_HELPER:helper('fail-mid-take')});const page=await open(t,server,'mic');
 await page.click('.nav-link[data-view=record]');await page.waitForFunction(()=>!document.querySelector('#start-record').disabled);
 await page.click('#start-record');
 await page.waitForSelector('.toast:has-text("Страховочная дорожка сохранила")',{timeout:30000});
 await page.click('.toast:has-text("Страховочная дорожка сохранила") .toast-action');
 await until(page,async()=>{const {items}=await (await fetch('/api/local/records?limit=5&q=&trash=false')).json();return items.some(r=>/страховочная дорожка$/.test(r.title)&&r.size>0)},null,{timeout:20000,polling:300});
 const items=await records(page);const copy=items.find(r=>/страховочная дорожка$/.test(r.title));
 assert.equal(copy.source,'Страховочная дорожка');assert.ok(copy.size>2000,'several seconds of Opus audio');
 const left=await page.evaluate(async()=>{const root=await (await navigator.storage.getDirectory()).getDirectoryHandle('mono-safety',{create:true});let n=0;for await(const _ of root.keys())n++;return n});
 assert.equal(left,0,'a restored backup is removed from the window storage');
 const report=await page.evaluate(async()=>(await fetch('/api/local/diagnostics')).json());
 assert.ok(report.trends.counts.SAFETY_USED>=1,'the rescue is recorded for trend analysis');
 assert.deepEqual(page.errors,[]);
});

test('safety track: a clean take keeps its backup marked clean (removed after a day)',{skip},async t=>{
 const server=await localServer(t,{MONO_AUDIO_HELPER:helper('impulse')});const page=await open(t,server,'mic');
 await page.click('.nav-link[data-view=record]');await page.waitForFunction(()=>!document.querySelector('#start-record').disabled);
 await page.click('#start-record');await page.waitForFunction(()=>/Подтверждено/.test(document.querySelector('#record-saved').textContent),null,{timeout:15000});
 await page.waitForTimeout(5000);await page.click('#stop-record');
 const meta=await until(page,async()=>{try{const root=await (await navigator.storage.getDirectory()).getDirectoryHandle('mono-safety');for await(const dir of root.values()){const m=JSON.parse(await (await (await dir.getFileHandle('meta.json')).getFile()).text());if(m.outcome==='clean')return m}}catch{}return null},null,{timeout:15000,polling:300});
 assert.ok(meta.chunks>=1);assert.match(meta.mime,/audio\/(webm|ogg)/);
 assert.equal(await page.locator('.toast:has-text("Страховочная")').count(),0,'no rescue offer after a clean take');
 assert.deepEqual(page.errors,[]);
});

test('a browser channel that cannot open the microphone (NotReadableError) hands over to the system module and stays there',{skip},async t=>{
 const server=await localServer(t,{MONO_AUDIO_HELPER:helper('impulse')});
 const browser=await playwright.chromium.launch({args:['--use-fake-ui-for-media-stream','--use-fake-device-for-media-stream']});t.after(()=>browser.close());
 const context=await browser.newContext();await context.grantPermissions(['microphone'],{origin:server.url});
 // As on the reported laptop: Windows refuses the microphone to the browser (held by another app).
 await context.addInitScript(()=>{const original=navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);navigator.mediaDevices.getUserMedia=async c=>{if(c?.audio)throw new DOMException('Could not start audio source','NotReadableError');return original(c)};try{localStorage.setItem('mono-source-migrated-1',window.__migrate?'0':'1')}catch{}});
 const page=await context.newPage();page.errors=[];page.on('pageerror',e=>page.errors.push(e.message));
 await page.goto(server.url+'/');
 await page.evaluate(async()=>{const {csrf}=await (await fetch('/api/local/session')).json();const headers={'Content-Type':'application/json','X-Mono-CSRF':csrf};
  await fetch('/api/local/library/configure',{method:'POST',headers,body:JSON.stringify({useDefault:true})});
  await fetch('/api/local/preferences',{method:'PATCH',headers,body:JSON.stringify({onboarding:{completed:true,keySkipped:true,soundTested:true},capture:{mode:'browser'}})})});
 await page.reload();await page.waitForFunction(()=>document.querySelector('#nav-count'));
 await page.click('.nav-link[data-view=record]');await page.waitForFunction(()=>!document.querySelector('#start-record').disabled);
 await page.click('#start-record');
 await page.waitForSelector('.toast:has-text("записывает через системный модуль")',{timeout:30000});
 await page.waitForFunction(()=>/Подтверждено/.test(document.querySelector('#record-saved').textContent),null,{timeout:20000});
 await page.click('#stop-record');
 await until(page,async()=>{const {items}=await (await fetch('/api/local/records?limit=5&q=&trash=false')).json();return items.some(r=>r.status==='saved'&&r.tracks?.some(x=>x.id==='mic'))},null,{timeout:20000});
 const mode=await until(page,async()=>(await (await fetch('/api/local/preferences')).json()).capture.mode==='mic'&&'mic',null,{timeout:10000});
 assert.equal(mode,'mic','the working path is remembered');
 const report=await page.evaluate(async()=>(await fetch('/api/local/diagnostics')).json());
 assert.equal(report.capture.source,'mic');
 assert.deepEqual(page.errors,[]);
});

test('deep diagnostics tells a browser-only fault from a broken microphone: the system module opens it while the window gets NotReadableError',{skip},async t=>{
 const server=await localServer(t,{MONO_AUDIO_HELPER:helper('impulse')});
 const browser=await playwright.chromium.launch({args:['--use-fake-ui-for-media-stream','--use-fake-device-for-media-stream']});t.after(()=>browser.close());
 const context=await browser.newContext();await context.grantPermissions(['microphone','clipboard-read','clipboard-write'],{origin:server.url});
 await context.addInitScript(()=>{const original=navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);navigator.mediaDevices.getUserMedia=async c=>{if(c?.audio)throw new DOMException('Could not start audio source','NotReadableError');return original(c)}});
 const page=await context.newPage();page.errors=[];page.on('pageerror',e=>page.errors.push(e.message));
 await page.goto(server.url+'/');
 await page.evaluate(async()=>{const {csrf}=await (await fetch('/api/local/session')).json();const headers={'Content-Type':'application/json','X-Mono-CSRF':csrf};
  await fetch('/api/local/library/configure',{method:'POST',headers,body:JSON.stringify({useDefault:true})});
  await fetch('/api/local/preferences',{method:'PATCH',headers,body:JSON.stringify({onboarding:{completed:true,keySkipped:true,soundTested:true}})})});
 await page.reload();await page.waitForFunction(()=>document.querySelector('#nav-count'));await page.evaluate(()=>{location.hash='#settings'});
 await page.waitForSelector('.preflight-deep',{timeout:30000});await page.click('.preflight-deep');
 await page.waitForSelector('#deep-copy',{timeout:60000});
 const text=await page.textContent('#modal-text');
 assert.match(text,/Браузер не может открыть микрофон, системный модуль — может/);
 assert.doesNotMatch(text,/занят/,'a NotReadableError is not reported as a busy microphone');
 await page.click('#deep-copy');const report=JSON.parse((await page.evaluate(()=>navigator.clipboard.readText())).replace(/^[\s\S]*?\n\{/,'{'));
 assert.equal(report.server.capture.probe.opened,true);assert.equal(report.server.capture.probe.rawSupported,true);assert.equal(report.microphone.raw.error,'NotReadableError');
 assert.deepEqual(page.errors,[]);
});

test('a source pinned to the browser channel moves to the system module once, with a notice',{skip},async t=>{
 const server=await localServer(t,{MONO_AUDIO_HELPER:helper('impulse')});const page=await open(t,server,'browser');
 await page.waitForSelector('.toast:has-text("Источник записи — системный модуль")',{timeout:30000});
 assert.equal(await until(page,async()=>(await (await fetch('/api/local/preferences')).json()).capture.mode,null,{timeout:10000}),'mic');
 await page.reload();await page.waitForTimeout(4000);
 assert.equal(await page.locator('.toast:has-text("Источник записи — системный модуль")').count(),0,'only once');
 assert.deepEqual(page.errors,[]);
});
