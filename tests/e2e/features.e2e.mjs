// Real-browser checks of the studio features on the native capture path, driven by the
// fixture helper (tests/fixtures/audio-helper.py) instead of a sound card:
// global hotkey, bookmarks, two-track meeting profile, undo of trash, recovery card,
// and recording that continues after the audio device disappears.
import test from 'node:test';import assert from 'node:assert/strict';
import {localServer} from '../helpers/local-server.mjs';import {until} from '../helpers/until.mjs';import {createRequire} from 'node:module';
import {writeFileSync,chmodSync,mkdtempSync,readFileSync} from 'node:fs';import {tmpdir} from 'node:os';import path from 'node:path';import {fileURLToPath} from 'node:url';
let playwright=null;
try{playwright=await import('playwright')}catch{try{playwright=createRequire(import.meta.url)('playwright')}catch{}}
const FIXTURE=fileURLToPath(new URL('../fixtures/audio-helper.py',import.meta.url));
// The helper is started as an executable; a shell wrapper is enough off Windows.
const skip=!playwright?'playwright is not installed':process.platform==='win32'?'fixture helper wrapper needs a POSIX shell':false;
function helper(behavior){const dir=mkdtempSync(path.join(tmpdir(),'mono-helper-')),file=path.join(dir,'helper.sh');writeFileSync(file,`#!/bin/sh\nexec python3 '${FIXTURE}' "$@" --behavior ${behavior}\n`);chmodSync(file,0o755);return file}
async function open(t,server,mode='both',{migrated=true}={}){
 const browser=await playwright.chromium.launch({args:['--use-fake-ui-for-media-stream','--use-fake-device-for-media-stream']});t.after(()=>browser.close());
 const context=await browser.newContext();await context.grantPermissions(['microphone'],{origin:server.url});
 if(migrated)await context.addInitScript(()=>{try{localStorage.setItem('mono-source-browser-1','1')}catch{}});
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

test('autopilot: the browser channel is still the fallback when the module never answered the first capability query (slow runner, first launch)',{skip},async t=>{
 const server=await localServer(t,{MONO_AUDIO_HELPER:helper('open-failure')});
 const browser=await playwright.chromium.launch({args:['--use-fake-ui-for-media-stream','--use-fake-device-for-media-stream']});t.after(()=>browser.close());
 const context=await browser.newContext();await context.addInitScript(()=>{try{localStorage.setItem('mono-source-browser-1','1')}catch{}});await context.grantPermissions(['microphone'],{origin:server.url});
 let slow=true;await context.route('**/api/local/capture/capabilities',async route=>{if(slow)await new Promise(r=>setTimeout(r,11000));await route.continue().catch(()=>{})});
 const page=await context.newPage();page.errors=[];page.on('pageerror',e=>page.errors.push(e.message));
 await page.goto(server.url+'/');
 await page.evaluate(async()=>{const {csrf}=await (await fetch('/api/local/session')).json();const headers={'Content-Type':'application/json','X-Mono-CSRF':csrf};
  await fetch('/api/local/library/configure',{method:'POST',headers,body:JSON.stringify({useDefault:true})});
  await fetch('/api/local/preferences',{method:'PATCH',headers,body:JSON.stringify({onboarding:{completed:true,keySkipped:true,soundTested:true},capture:{mode:'mic'}})})});
 await page.reload();await page.waitForFunction(()=>document.querySelector('#nav-count'));
 await page.click('.nav-link[data-view=record]');await page.waitForFunction(()=>!document.querySelector('#start-record').disabled,null,{timeout:30000});
 await page.waitForTimeout(12000); // the window's first capability query has timed out by now
 slow=false;await page.click('#start-record');
 await page.waitForSelector('.toast:has-text("запасной канал")',{timeout:30000});
 await page.waitForFunction(()=>/Подтверждено в архиве/.test(document.querySelector('#record-saved').textContent),null,{timeout:20000});
 await page.click('#stop-record');
 assert.deepEqual(page.errors,[]);
});

test('level check: a toggle with a countdown that never comes back by itself after a take',{skip},async t=>{
 const server=await localServer(t,{MONO_AUDIO_HELPER:helper('impulse')});const page=await open(t,server,'browser');
 await page.click('.nav-link[data-view=record]');await page.waitForFunction(()=>!document.querySelector('#start-record').disabled);
 await page.click('#level-check');
 await page.waitForFunction(()=>/Остановить проверку · 0:4\d/.test(document.querySelector('#level-check').textContent),null,{timeout:10000});
 await page.waitForTimeout(2300);assert.match(await page.textContent('#level-check'),/0:4[0-3]/,'the countdown moves');
 await page.click('#level-check');
 await page.waitForFunction(()=>document.querySelector('#level-check').textContent==='Проверить уровень',null,{timeout:5000});
 // On again, then a take: after the take the check stays off.
 await page.click('#level-check');await page.waitForFunction(()=>document.querySelector('#level-check').classList.contains('is-on'),null,{timeout:10000});
 await page.click('#start-record');await page.waitForFunction(()=>/Подтверждено/.test(document.querySelector('#record-saved').textContent),null,{timeout:20000});
 await page.click('#stop-record');await page.waitForFunction(()=>!document.querySelector('#level-check').hidden,null,{timeout:20000});
 await page.waitForTimeout(2500);
 assert.equal(await page.textContent('#level-check'),'Проверить уровень');assert.equal(await page.evaluate(()=>document.querySelector('#level-check').classList.contains('is-on')),false);
 assert.deepEqual(page.errors,[]);
});

test('a video file of any length is imported as its audio track and can be played',{skip},async t=>{
 const dir=mkdtempSync(path.join(tmpdir(),'mono-video-')),video=path.join(dir,'meeting.mp4');
 const {execFileSync}=await import('node:child_process');
 try{execFileSync('ffmpeg',['-v','error','-f','lavfi','-i','testsrc=size=160x120:rate=10','-f','lavfi','-i','sine=frequency=330:sample_rate=48000','-t','4','-c:v','libx264','-pix_fmt','yuv420p','-c:a','aac','-shortest',video])}catch{t.skip('ffmpeg cannot make a test video');return}
 const server=await localServer(t,{MONO_AUDIO_HELPER:helper('impulse')});const page=await open(t,server,'browser');
 await page.click('.nav-link[data-view=library]');const [chooser]=await Promise.all([page.waitForEvent('filechooser'),page.click('#library-import')]);await chooser.setFiles(video);
 await page.waitForSelector('.toast:has-text("Звук из видео сохранён")',{timeout:60000});
 const [take]=await records(page);
 assert.equal(take.title,'meeting');assert.equal(take.mime,'audio/mp4');assert.equal(take.source,'Видео');assert.ok(take.duration>3&&take.duration<5,String(take.duration));
 const audio=await page.evaluate(async id=>{const r=await fetch(`/api/local/records/${id}/audio`);return {status:r.status,type:r.headers.get('content-type'),bytes:(await r.arrayBuffer()).byteLength}},take.id);
 assert.equal(audio.status,200);assert.ok(audio.bytes>1000);
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

test('a browser channel that cannot open the microphone (NotReadableError) hands over to the system module for this take; the window stays the chosen source',{skip},async t=>{
 const server=await localServer(t,{MONO_AUDIO_HELPER:helper('impulse')});
 const browser=await playwright.chromium.launch({args:['--use-fake-ui-for-media-stream','--use-fake-device-for-media-stream']});t.after(()=>browser.close());
 const context=await browser.newContext();await context.addInitScript(()=>{try{localStorage.setItem('mono-source-browser-1','1')}catch{}});await context.grantPermissions(['microphone'],{origin:server.url});
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
 await page.waitForSelector('.toast:has-text("эта запись идёт через модуль Windows")',{timeout:30000});
 await page.waitForFunction(()=>/Подтверждено/.test(document.querySelector('#record-saved').textContent),null,{timeout:20000});
 await page.click('#stop-record');
 await until(page,async()=>{const {items}=await (await fetch('/api/local/records?limit=5&q=&trash=false')).json();return items.some(r=>r.status==='saved'&&r.tracks?.some(x=>x.id==='mic'))},null,{timeout:20000});
 await page.waitForTimeout(1500);
 assert.equal((await page.evaluate(async()=>(await fetch('/api/local/preferences')).json())).capture.mode,'browser','the window stays the source: the module only rescued this take');
 assert.deepEqual(page.errors,[]);
});

test('a browser start that fails while the system module is still launching (12 s) waits for the module instead of giving up',{skip},async t=>{
 const server=await localServer(t,{MONO_AUDIO_HELPER:helper('slow-boot')});
 const browser=await playwright.chromium.launch({args:['--use-fake-ui-for-media-stream','--use-fake-device-for-media-stream']});t.after(()=>browser.close());
 const context=await browser.newContext();await context.addInitScript(()=>{try{localStorage.setItem('mono-source-browser-1','1')}catch{}});await context.grantPermissions(['microphone'],{origin:server.url});
 await context.addInitScript(()=>{const original=navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);navigator.mediaDevices.getUserMedia=async c=>{if(c?.audio)throw new DOMException('Could not start audio source','NotReadableError');return original(c)};try{localStorage.setItem('mono-source-migrated-1','1')}catch{}});
 const page=await context.newPage();page.errors=[];page.on('pageerror',e=>page.errors.push(e.message));
 await page.goto(server.url+'/');
 await page.evaluate(async()=>{const {csrf}=await (await fetch('/api/local/session')).json();const headers={'Content-Type':'application/json','X-Mono-CSRF':csrf};
  await fetch('/api/local/library/configure',{method:'POST',headers,body:JSON.stringify({useDefault:true})});
  await fetch('/api/local/preferences',{method:'PATCH',headers,body:JSON.stringify({onboarding:{completed:true,keySkipped:true,soundTested:true},capture:{mode:'browser'}})})});
 await page.reload();await page.waitForFunction(()=>document.querySelector('#nav-count'));
 await page.click('.nav-link[data-view=record]');await page.waitForFunction(()=>!document.querySelector('#start-record').disabled);
 assert.notEqual(await page.evaluate(async()=>(await (await fetch('/api/local/capture/capabilities')).json()).ready),true,'the module is still launching when Start is pressed');
 await page.click('#start-record');
 await page.waitForSelector('.toast:has-text("эта запись идёт через модуль Windows")',{timeout:40000});
 await page.waitForFunction(()=>/Подтверждено/.test(document.querySelector('#record-saved').textContent),null,{timeout:20000});
 await page.click('#stop-record');
 await until(page,async()=>{const {items}=await (await fetch('/api/local/records?limit=5&q=&trash=false')).json();return items.some(r=>r.status==='saved'&&r.tracks?.some(x=>x.id==='mic'))},null,{timeout:20000});
 assert.deepEqual(page.errors,[]);
});
test('browser window: the launcher sees the open page (by token only); the Kaspersky verdict offers the address for the person\'s own browser',{skip},async t=>{
 const home=mkdtempSync(path.join(tmpdir(),'mono-launcher-home-'));writeFileSync(path.join(home,'ui-engine.json'),JSON.stringify({engine:'chromium'}));
 const server=await localServer(t,{MONO_AUDIO_HELPER:helper('impulse'),MONO_LAUNCHER_HOME:home,MONO_LAUNCHER_TOKEN:'test-token'});
 const browser=await playwright.chromium.launch({args:['--use-fake-ui-for-media-stream','--use-fake-device-for-media-stream']});t.after(()=>browser.close());
 const context=await browser.newContext();await context.addInitScript(()=>{try{localStorage.setItem('mono-source-browser-1','1')}catch{}});await context.grantPermissions(['microphone','clipboard-read','clipboard-write'],{origin:server.url});
 await context.addInitScript(()=>{const original=navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);navigator.mediaDevices.getUserMedia=async c=>{if(c?.audio)throw new DOMException('Could not start audio source','NotReadableError');return original(c)}});
 const page=await context.newPage();page.errors=[];page.on('pageerror',e=>page.errors.push(e.message));
 await page.route('**/api/local/diagnostics',async route=>{const response=await route.fetch(),report=await response.json();
  report.capture.probe={available:true,opened:false,step:'initialize',hresult:'80070057',attempts:{event:'80070057',autoconvert:'80070057'},othersRecording:['Discord'],security:{products:['Kaspersky Endpoint Security для Windows'],kaspersky:true}};
  await route.fulfill({response,json:report})});
 await page.goto(server.url+'/');
 await page.evaluate(async()=>{const {csrf}=await (await fetch('/api/local/session')).json();const headers={'Content-Type':'application/json','X-Mono-CSRF':csrf};
  await fetch('/api/local/library/configure',{method:'POST',headers,body:JSON.stringify({useDefault:true})});
  await fetch('/api/local/preferences',{method:'PATCH',headers,body:JSON.stringify({onboarding:{completed:true,keySkipped:true,soundTested:true}})})});
 await page.reload();await page.waitForFunction(()=>document.querySelector('#nav-count'));
 // The launcher's lifetime signal: one open page.
 let pages=0;for(const deadline=Date.now()+15000;Date.now()<deadline&&!pages;await new Promise(r=>setTimeout(r,300)))pages=(await (await fetch(server.url+'/api/launcher/clients',{headers:{'X-Mono-Launcher-Token':'test-token'}})).json()).pages;
 assert.ok(pages>=1,'the open page is counted');
 assert.equal((await fetch(server.url+'/api/launcher/clients')).status,403,'no token, no answer');
 await page.evaluate(()=>{location.hash='#settings'});
 await page.click('.preflight-deep');await page.waitForSelector('#deep-browser',{timeout:60000});
 assert.equal((await page.textContent('#deep-browser')).trim(),'Скопировать адрес MONO');
 await page.click('#deep-browser');
 await page.waitForFunction(()=>/Откройте Chrome или Edge сами/.test(document.querySelector('#deep-browser-hint')?.textContent||''),null,{timeout:10000});
 assert.deepEqual(page.errors,[]);
});
test('deep diagnostics: when Kaspersky refuses audio to MONO alone, it is named and the own-browser path gives the address',{skip},async t=>{
 const server=await localServer(t,{MONO_AUDIO_HELPER:helper('impulse')});
 const browser=await playwright.chromium.launch({args:['--use-fake-ui-for-media-stream','--use-fake-device-for-media-stream']});t.after(()=>browser.close());
 const context=await browser.newContext();await context.addInitScript(()=>{try{localStorage.setItem('mono-source-browser-1','1')}catch{}});await context.grantPermissions(['microphone','clipboard-read','clipboard-write'],{origin:server.url});
 await context.addInitScript(()=>{const original=navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);navigator.mediaDevices.getUserMedia=async c=>{if(c?.audio)throw new DOMException('Could not start audio source','NotReadableError');return original(c)}});
 const page=await context.newPage();page.errors=[];page.on('pageerror',e=>page.errors.push(e.message));
 // The Windows-only facts (Security Center, who records the microphone) are injected into the real server answer.
 await page.route('**/api/local/diagnostics',async route=>{const response=await route.fetch(),report=await response.json();
  const attempts=Object.fromEntries(['event','autoconvert','polling','client3','communications','pcm16'].map(k=>[k,'80070057']));
  report.capture.probe={available:true,opened:false,step:'initialize',hresult:'80070057',attempts,othersRecording:['Discord'],security:{products:['Kaspersky Endpoint Security'],kaspersky:true}};
  report.capture.heldBy=['Discord'];
  await route.fulfill({response,json:report})});
 await page.goto(server.url+'/');
 await page.evaluate(async()=>{const {csrf}=await (await fetch('/api/local/session')).json();const headers={'Content-Type':'application/json','X-Mono-CSRF':csrf};
  await fetch('/api/local/library/configure',{method:'POST',headers,body:JSON.stringify({useDefault:true})});
  await fetch('/api/local/preferences',{method:'PATCH',headers,body:JSON.stringify({onboarding:{completed:true,keySkipped:true,soundTested:true}})})});
 await page.reload();await page.waitForFunction(()=>document.querySelector('#nav-count'));await page.evaluate(()=>{location.hash='#settings'});
 await page.waitForSelector('.preflight-deep',{timeout:30000});await page.click('.preflight-deep');
 await page.waitForSelector('#deep-browser',{timeout:60000});
 const text=await page.textContent('#modal-text');
 assert.match(text,/Kaspersky не даёт MONO получать звук микрофона/);assert.match(text,/Discord/);
 assert.doesNotMatch(text,/занят|Драйвер микрофона/);
 await page.click('#deep-browser');
 assert.equal(await page.evaluate(()=>navigator.clipboard.readText()),server.url);
 assert.match(await page.textContent('#deep-browser-hint'),/Откройте Chrome или Edge сами/);
 assert.deepEqual(page.errors,[]);
});
test('deep diagnostics tells a browser-only fault from a broken microphone: the system module opens it while the window gets NotReadableError',{skip},async t=>{
 const server=await localServer(t,{MONO_AUDIO_HELPER:helper('impulse')});
 const browser=await playwright.chromium.launch({args:['--use-fake-ui-for-media-stream','--use-fake-device-for-media-stream']});t.after(()=>browser.close());
 const context=await browser.newContext();await context.addInitScript(()=>{try{localStorage.setItem('mono-source-browser-1','1')}catch{}});await context.grantPermissions(['microphone','clipboard-read','clipboard-write'],{origin:server.url});
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

test('a source left on the module microphone moves to the browser window once, quietly',{skip},async t=>{
 const server=await localServer(t,{MONO_AUDIO_HELPER:helper('impulse')});const page=await open(t,server,'mic',{migrated:false});
 // As after an update: the stored source is the module microphone and this version has not run yet.
 await page.evaluate(()=>localStorage.removeItem('mono-source-browser-1'));await page.reload();await page.waitForFunction(()=>document.querySelector('#nav-count'));
 await page.click('.nav-link[data-view=record]');
 assert.equal(await until(page,async()=>{const mode=(await (await fetch('/api/local/preferences')).json()).capture.mode;return mode==='browser'&&mode},null,{timeout:15000}),'browser');
 await page.evaluate(async()=>{const {csrf}=await (await fetch('/api/local/session')).json();await fetch('/api/local/preferences',{method:'PATCH',headers:{'Content-Type':'application/json','X-Mono-CSRF':csrf},body:JSON.stringify({capture:{mode:'mic'}})})});
 await page.reload();await page.waitForTimeout(4000);
 assert.equal((await page.evaluate(async()=>(await fetch('/api/local/preferences')).json())).capture.mode,'mic','only once: a later choice of the module is respected');
 assert.deepEqual(page.errors,[]);
});
