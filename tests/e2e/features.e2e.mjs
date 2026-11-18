// Real-browser checks of the studio features on the native capture path, driven by the
// fixture helper (tests/fixtures/audio-helper.py) instead of a sound card:
// global hotkey, bookmarks, two-track meeting profile, undo of trash, recovery card,
// and recording that continues after the audio device disappears.
import test from 'node:test';import assert from 'node:assert/strict';
import {localServer} from '../helpers/local-server.mjs';import {createRequire} from 'node:module';
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
 await page.waitForFunction(async()=>{const {items}=await (await fetch('/api/local/records?limit=1&q=&trash=false')).json();return items[0]?.status==='saved'&&items[0]?.bookmarks?.length===1},null,{timeout:15000,polling:300});
 const [take]=await records(page);assert.deepEqual(take.tracks.map(track=>track.id).sort(),['mic','system']);
 const {profile}=await page.evaluate(async id=>(await fetch('/api/local/records/'+id+'/speakers')).json(),take.id);
 assert.ok(profile.tracks.mic.length>0&&profile.tracks.system.length>0,'two-track loudness profile');
 // Trash without a dialog, then «Вернуть».
 await page.evaluate(()=>{location.hash='#library';document.querySelectorAll('.toast').forEach(toast=>toast.remove())});
 await page.click(`[data-delete="${take.id}"]`);await page.click('.toast:has-text("в корзине") .toast-action');
 await page.waitForFunction(async()=>(await (await fetch('/api/local/records?limit=5&q=&trash=false')).json()).items.length===1,null,{timeout:10000,polling:300});
 assert.deepEqual(page.errors,[]);
});

test('recording continues as a linked take when the audio device disappears',{skip},async t=>{
 const server=await localServer(t,{MONO_AUDIO_HELPER:helper('device-lost-once')});const page=await open(t,server);
 await page.click('.nav-link[data-view=record]');await page.waitForFunction(()=>!document.querySelector('#start-record').disabled);
 await page.click('#start-record');
 await page.waitForSelector('.toast:has-text("Запись продолжается")',{timeout:20000});
 assert.equal(await page.isHidden('#stop-record'),false,'still recording on the new take');
 await page.click('#stop-record');
 await page.waitForFunction(async()=>{const {items}=await (await fetch('/api/local/records?limit=5&q=&trash=false')).json();return items.some(r=>/продолжение$/.test(r.title)&&r.status==='saved')},null,{timeout:15000,polling:300});
 const items=await records(page);assert.equal(items.length,2);assert.ok(items.some(r=>r.status==='interrupted'&&r.duration>0),'first part kept');
 assert.deepEqual(page.errors,[]);
});

test('autopilot: a microphone muted in Windows is detected, shown in pre-flight and fixed on Record',{skip},async t=>{
 const server=await localServer(t,{MONO_AUDIO_HELPER:helper('muted')});const page=await open(t,server);
 await page.click('.nav-link[data-view=record]');
 await page.waitForSelector('.preflight-item[data-level=caution]:has-text("Микрофон выключен в Windows")',{timeout:20000});
 await page.waitForFunction(()=>!document.querySelector('#start-record').disabled);await page.click('#start-record');
 await page.waitForSelector('.toast:has-text("MONO включил его")',{timeout:20000});
 const diagnosis=await page.evaluate(async()=>(await fetch('/api/local/capture/diagnose')).json());
 assert.equal(diagnosis.inputs[0].muted,false);
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
 await page.waitForFunction(async()=>{const {items}=await (await fetch('/api/local/records?limit=5&q=&trash=false')).json();return items.some(r=>r.status==='saved'&&r.duration>0)},null,{timeout:20000,polling:300});
 assert.deepEqual(page.errors,[]);
});
