// Real-browser checks of the studio features on the native capture path, driven by the
// fixture helper (tests/fixtures/audio-helper.py) instead of a sound card:
// global hotkey, bookmarks, two-track meeting profile, undo of trash, recovery card,
// and recording that continues after the audio device disappears.
import {showPane} from '../helpers/settings-pane.mjs';
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
 const page=await context.newPage();page.errors=[];page.stacks=[];page.on('pageerror',error=>{page.errors.push(error.message);page.stacks.push(String(error.stack||error.message))});
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
 // «Вы уверены?» first, then the trash, then «Вернуть».
 await page.evaluate(()=>{location.hash='#library';document.querySelectorAll('.toast').forEach(toast=>toast.remove())});
 await page.click(`[data-delete="${take.id}"]`);await page.waitForSelector('#modal:not([hidden])');assert.equal(await page.textContent('#modal-title'),'Вы уверены?');await page.click('#modal-actions .btn-danger');await page.click('.toast:has-text("в корзине") .toast-action');
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
 try{execFileSync('ffmpeg',['-v','error','-f','lavfi','-i','testsrc=size=160x120:rate=10','-f','lavfi','-i','sine=frequency=330:sample_rate=48000','-t','4','-c:v','mpeg4','-c:a','aac','-shortest',video])}catch{t.skip('ffmpeg cannot make a test video');return}
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
 assert.equal(status,200);assert.deepEqual(page.errors,[],page.stacks.join('\n---\n'));
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
 await showPane(page,'.preflight-deep');await page.click('.preflight-deep');await page.waitForSelector('#deep-browser',{timeout:60000});
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
 await showPane(page,'.preflight-deep');await page.waitForSelector('.preflight-deep',{timeout:30000});await page.click('.preflight-deep');
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
 await showPane(page,'.preflight-deep');await page.waitForSelector('.preflight-deep',{timeout:30000});await page.click('.preflight-deep');
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

test('Play at the end starts over; settings fill the width with an index and a theme switch; the drop zone spans its card',{skip},async t=>{
 const server=await localServer(t,{MONO_AUDIO_HELPER:helper('impulse')});const page=await open(t,server);
 const {execFileSync}=await import('node:child_process');const dir=mkdtempSync(path.join(tmpdir(),'mono-end-')),wav=path.join(dir,'short.webm');
 // a live WebM, as the browser's recorder writes it: no duration in the header
 execFileSync('ffmpeg',['-v','error','-f','lavfi','-i','sine=frequency=300:duration=1.5','-c:a','libopus','-live','1','-f','webm',wav]);
 // drop zone: as wide as the hero card's content, not a fixed 760 px (measured after the view has arrived)
 await page.waitForTimeout(700);const widths=await page.evaluate(()=>{const zone=document.querySelector('#hero-import'),parent=zone.parentElement;const style=getComputedStyle(parent);return {zone:zone.getBoundingClientRect().width,box:parent.clientWidth-parseFloat(style.paddingLeft)-parseFloat(style.paddingRight)}});
 assert.ok(widths.zone>=widths.box-2,`drop zone ${widths.zone} of ${widths.box}`);
 // settings
 await page.click('.nav-link[data-view=settings]');await page.waitForFunction(()=>document.querySelectorAll('#settings-index a').length>=6);
 const layout=await page.evaluate(()=>{const grid=document.querySelector('#view-settings .settings-grid'),index=document.querySelector('#settings-index'),main=document.querySelector('#main');return {grid:grid.getBoundingClientRect().right,main:main.getBoundingClientRect().right,index:index.getBoundingClientRect().width,labels:[...index.querySelectorAll('a')].map(a=>a.textContent)}});
 assert.ok(layout.main-layout.grid<80,`settings stop ${layout.main-layout.grid}px short of the right edge`);assert.ok(layout.labels.includes('Groq')&&layout.labels.includes('Архив'));
 await showPane(page,'.segmented button[data-value=light]');await page.click('.segmented button[data-value=light]');assert.equal(await page.evaluate(()=>document.body.dataset.theme),'light');
 assert.equal(await page.getAttribute('.segmented button[data-value=light]','aria-checked'),'true');
 await page.click('.segmented button[data-value=dark]');assert.equal(await page.evaluate(()=>document.body.dataset.theme),'dark');
 // the pre-flight check no longer guesses that another app holds the microphone
 assert.ok(!(await page.textContent('#view-settings')).includes('может использовать другое приложение'));
 // replay from the end
 await page.click('.nav-link[data-view=library]');const [chooser]=await Promise.all([page.waitForEvent('filechooser'),page.click('#library-import')]);await chooser.setFiles(wav);
 let list=[];for(let i=0;i<60&&!list.length;i++){list=await records(page);if(!list.length)await new Promise(r=>setTimeout(r,500))}const [record]=list;assert.ok(record,'the WebM was not imported');
 await page.evaluate(id=>{location.hash='#editor/'+id},record.id);await page.waitForSelector('#player-toggle');
 await page.click('#player-toggle');
 await page.waitForFunction(()=>{const value=Number(document.querySelector('#player-seek').value);return value>=990},null,{timeout:15000});
 await page.waitForFunction(()=>document.querySelector('#player-toggle').innerHTML.includes('i-play'),null,{timeout:5000});
 await page.click('#player-toggle');
 await page.waitForFunction(()=>{const value=Number(document.querySelector('#player-seek').value);return value>0&&value<700},null,{timeout:5000});
 assert.deepEqual(page.errors,[]);
});

test('after closing MONO in the middle of a record, the next start opens that record at the same place; after finishing, it opens the overview',{skip},async t=>{
 const server=await localServer(t,{MONO_AUDIO_HELPER:helper('impulse')});const page=await open(t,server);
 const {execFileSync}=await import('node:child_process');const dir=mkdtempSync(path.join(tmpdir(),'mono-resume-')),wav=path.join(dir,'long.wav');
 execFileSync('ffmpeg',['-v','error','-f','lavfi','-i','sine=frequency=220:duration=30','-ar','16000',wav]);
 await page.click('.nav-link[data-view=library]');const [chooser]=await Promise.all([page.waitForEvent('filechooser'),page.click('#library-import')]);await chooser.setFiles(wav);
 let list=[];for(let i=0;i<60&&!list.length;i++){list=await records(page);if(!list.length)await new Promise(r=>setTimeout(r,500))}const [record]=list;assert.ok(record);
 await page.evaluate(id=>{location.hash='#editor/'+id},record.id);await page.waitForSelector('#player-toggle');
 await page.waitForFunction(()=>document.querySelector('#player-total')?.textContent?.includes('00:30'),null,{timeout:15000});
 await page.evaluate(()=>{const s=document.querySelector('#player-seek');s.value='400';s.dispatchEvent(new Event('input',{bubbles:true}));s.dispatchEvent(new Event('change',{bubbles:true}))});
 await page.waitForTimeout(2600);
 const context=page.context();await page.close();
 // the next start: the launcher opens the plain address, without a view in it
 const next=await context.newPage();next.errors=[];next.on('pageerror',error=>next.errors.push(error.message));await next.goto(server.url+'/');
 await next.waitForFunction(id=>location.hash==='#editor/'+encodeURIComponent(id),record.id,{timeout:15000});
 await next.waitForFunction(()=>{const v=Number(document.querySelector('#player-seek').value);return v>300&&v<500},null,{timeout:10000});
 // finishing: back to the library, close, start again → overview
 await next.click('#view-editor .back-link');await next.waitForFunction(()=>location.hash==='#library');await next.close();
 const third=await context.newPage();await third.goto(server.url+'/');await third.waitForFunction(()=>document.querySelector('#nav-count'));await third.waitForTimeout(1500);
 assert.ok(['','#dashboard','#library'].includes(await third.evaluate(()=>location.hash))&&!(await third.evaluate(()=>location.hash)).startsWith('#editor'));
 assert.deepEqual(next.errors,[]);
});

test('round 4: floating recorder and pause state, sidebar badge, library selection and list view, settings spotlight, tour, usage',{skip,timeout:120000},async t=>{
 const server=await localServer(t,{MONO_AUDIO_HELPER:helper('impulse')});const page=await open(t,server);
 await page.evaluate(()=>{try{localStorage.setItem('mono-prefs-1',JSON.stringify({groqReminder:false,tourDone:true}))}catch{}});
 // usage ledger answers even before any transcription
 const usage=await page.evaluate(async()=>(await fetch('/api/usage')).json());assert.equal(usage.total.transcriptions,0);assert.equal(usage.usdPerHour,0.04);
 await page.click('.nav-link[data-view=record]');await page.waitForFunction(()=>!document.querySelector('#start-record').disabled);
 await page.click('#start-record');await page.waitForFunction(()=>!document.querySelector('#stop-record').hidden,null,{timeout:20000});
 await page.waitForFunction(()=>!document.querySelector('#nav-rec-badge').hidden&&document.querySelector('#nav-rec-badge').dataset.state==='recording');
 // leaving the studio: the take goes on, the floating panel appears
 await page.click('.nav-link[data-view=library]');await page.waitForSelector('.floating-recorder:not([hidden])');
 await page.click('.floating-recorder .fr-pause');await page.waitForFunction(()=>document.querySelector('.floating-recorder').dataset.state==='paused',null,{timeout:10000});
 assert.equal(await page.getAttribute('#nav-rec-badge','data-state'),'paused');
 await page.click('.floating-recorder .fr-open');await page.waitForFunction(()=>location.hash==='#record');
 assert.ok(await page.isHidden('.floating-recorder'),'no panel inside the studio');
 await page.waitForFunction(()=>!document.querySelector('#new-record').hidden);assert.match(await page.textContent('#pause-record'),/Продолжить запись/);
 assert.ok(await page.evaluate(()=>document.querySelector('.studio-panel').classList.contains('is-paused')));
 await page.click('#stop-record');await page.waitForFunction(()=>document.querySelector('#nav-rec-badge').hidden,null,{timeout:20000});
 // library: list view and selection mode
 await page.click('.nav-link[data-view=library]');await page.waitForSelector('.record-card');
 assert.equal(await page.locator('.record-card .item-icon').count(),0,'no file icon on the card');
 await page.click('.view-toggle [data-value=list]');assert.equal(await page.getAttribute('#library-list','data-view'),'list');
 await page.click('#library-select-mode');await page.locator('.record-card').first().click();await page.waitForFunction(()=>/Выбрано: 1/.test(document.querySelector('#bulk-count').textContent));
 await page.click('#bulk-done');assert.ok(await page.isHidden('#bulk-bar'));
 // settings: the index spotlights a card
 await page.click('.nav-link[data-view=settings]');await page.waitForSelector('#settings-index a');await page.click('#settings-index a[data-target="groq-settings-card"]');
 await page.waitForFunction(()=>!document.querySelector('#groq-settings-card').classList.contains('pane-hidden')&&[...document.querySelectorAll('#view-settings .settings-grid>.settings-card')].filter(c=>!c.classList.contains('pane-hidden')).length===1);
 await page.click('#settings-index a[title="О MONO"]');await page.waitForFunction(()=>document.querySelector('#settings-index a.active')?.title==='О MONO'&&!document.querySelector('#about-card').classList.contains('pane-hidden'));
 await page.fill('#settings-search','курс');await page.waitForSelector('.settings-result');await page.keyboard.press('Enter');await page.waitForFunction(()=>document.querySelector('#settings-index a.active')?.title==='Расходы');
 // the tour runs to the end and is remembered
 await showPane(page,'#start-tour');await page.click('#start-tour');await page.waitForSelector('.tour');
 // each step changes behind a short haze; «Далее» is pressed when the card is on screen
 for(let i=0;i<40&&await page.locator('.tour').count();i++){await page.locator('.tour-next').click({timeout:5000}).catch(()=>{});await page.waitForTimeout(450)}
 await page.waitForFunction(()=>!document.querySelector('.tour'));assert.equal(await page.evaluate(()=>JSON.parse(localStorage.getItem('mono-prefs-1')).tourDone),true);
 assert.deepEqual(page.errors,[]);
});

test('the USD→RUB rate is taken automatically and shown with its source; a typed rate turns it off',{skip,timeout:90000},async t=>{
 const http=await import('node:http');const rateServer=http.createServer((req,res)=>{res.writeHead(200,{'Content-Type':'application/json'}).end(JSON.stringify({rate:79.5,date:'21.11.2026'}))});
 await new Promise(r=>rateServer.listen(0,'127.0.0.1',r));t.after(()=>rateServer.close());
 const server=await localServer(t,{MONO_RATE_SOURCES:'on',MONO_RATE_URL:`http://127.0.0.1:${rateServer.address().port}/rate`});const page=await open(t,server);
 await page.click('.nav-link[data-view=settings]');await page.click('#settings-index a[title="Расходы"]');
 await page.waitForFunction(()=>document.querySelector('#setting-rate').value==='79.5',null,{timeout:20000});
 assert.match(await page.textContent('#rate-source'),/79,50 ₽ на 21\.11\.2026/);
 await page.fill('#setting-rate','90');await page.press('#setting-rate','Tab');
 await page.waitForFunction(()=>!document.querySelector('[data-pref=rateAuto]').checked);assert.deepEqual(page.errors,[]);
});

/** Picks an option of MONO's own select the way a person does: open it, click the row. */
async function choose(page,select,text){await page.locator(select+' ~ .select-control').click();await page.locator('.select-popup [role=option]',{hasText:text}).first().click()}

test('«Что записывать»: all four ways are listed; «Выбранное приложение» records one program and names it',{skip,timeout:90000},async t=>{
 const server=await localServer(t,{MONO_AUDIO_HELPER:helper('normal')});const page=await open(t,server,'browser');
 await page.evaluate(()=>{location.hash='#record'});
 const picker=page.locator('.side-card [data-source="mode"]');await picker.waitFor({state:'attached'});
 await page.waitForFunction(()=>document.querySelectorAll('.side-card [data-source="mode"] option').length>=4);
 const names=await picker.locator('option').allTextContents();
 for(const name of ['Микрофон','Звук компьютера','Звук компьютера + микрофон','Выбранное приложение'])assert.ok(names.some(item=>item.startsWith(name)),name+' is listed: '+names.join(' | '));
 await choose(page,'.side-card [data-source="mode"]','Выбранное приложение');
 const app=page.locator('.side-card [data-source="appName"]');await page.waitForFunction(()=>[...document.querySelectorAll('.side-card [data-source="appName"] option')].some(option=>option.value==='zoom'));
 await choose(page,'.side-card [data-source="appName"]','Zoom Workplace');
 await until(page,async()=>(await (await fetch('/api/local/preferences')).json()).capture.appName==='zoom',null,{timeout:5000,polling:200});
 assert.equal(await page.locator('.side-card [data-input]').isHidden(),true,'no microphone row: only the program is recorded');
 await page.waitForFunction(()=>/Звук приложения: Zoom Workplace/.test(document.querySelector('#record-source')?.textContent||''));
 await page.screenshot({path:path.join(tmpdir(),'mono-app-source.png')});
 await page.click('#start-record');await page.waitForFunction(()=>!document.querySelector('#stop-record').hidden,null,{timeout:15000});
 await page.waitForFunction(()=>/Подтверждено/.test(document.querySelector('#record-saved').textContent),null,{timeout:15000});
 await page.click('#stop-record');
 await until(page,async()=>{const {items}=await (await fetch('/api/local/records?limit=1&q=&trash=false')).json();return items[0]?.status==='saved'},null,{timeout:15000,polling:300});
 const [take]=await records(page);assert.equal(take.source,'Звук приложения «Zoom Workplace»');assert.deepEqual(take.tracks.map(track=>track.id),['system']);
 assert.deepEqual(page.errors,[]);
});

test('«Выбранное приложение» on Windows 10 explains why and switches to «Звук компьютера» in one click',{skip,timeout:60000},async t=>{
 const server=await localServer(t,{MONO_AUDIO_HELPER:helper('windows-10')});const page=await open(t,server,'browser');
 await page.evaluate(()=>{location.hash='#record'});
 const picker=page.locator('.side-card [data-source="mode"]');await page.waitForFunction(()=>document.querySelectorAll('.side-card [data-source="mode"] option').length>=4);
 await choose(page,'.side-card [data-source="mode"]','Выбранное приложение');
 const panel=page.locator('.side-card .source-unavailable');await panel.waitFor({state:'visible'});await page.waitForTimeout(500);
 assert.match(await panel.textContent(),/Windows 11.*19045/s);
 await page.screenshot({path:path.join(tmpdir(),'mono-app-unavailable.png')});
 await panel.locator('.source-fix').click();
 await until(page,async()=>(await (await fetch('/api/local/preferences')).json()).capture.mode==='system',null,{timeout:5000,polling:200});
 await panel.waitFor({state:'hidden'});
 assert.deepEqual(page.errors,[]);
});
