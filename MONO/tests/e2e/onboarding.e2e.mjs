// First launch: choosing a folder must move on to the next step with no error line,
// whatever the capture module is doing in the background.
import test from 'node:test';import assert from 'node:assert/strict';import {writeFileSync} from 'node:fs';import path from 'node:path';import {fileURLToPath} from 'node:url';
import {localServer} from '../helpers/local-server.mjs';import {createRequire} from 'node:module';
let playwright=null;
try{playwright=await import('playwright')}catch{try{playwright=createRequire(import.meta.url)('playwright')}catch{}}
const FOLDER_WORKER=fileURLToPath(new URL('../fixtures/folder-worker.py',import.meta.url));

for(const [name,env] of [['without the system capture module',{}],['with the system capture module',{MONO_AUDIO_HELPER:process.platform==='win32'?'':'__fixture__'}],['real picker timing: the dialog stays open 6 s',{MONO_FIXTURE_PICKER_DELAY:'6'}],['real picker timing, 20 s',{MONO_FIXTURE_PICKER_DELAY:'20'}],['the capture module takes 12 s to start (first launch on Windows)',{MONO_AUDIO_HELPER:'__fixture__',behavior:'slow-boot'}]]){
 test(`first launch: a chosen folder becomes the archive and setup moves on (${name})`,{skip:(!playwright&&'playwright is not installed')||(env.MONO_AUDIO_HELPER==='__fixture__'&&process.platform==='win32'&&'POSIX only')},async t=>{
  const extra={MONO_CORE_SCRIPT:FOLDER_WORKER,...(env.MONO_FIXTURE_PICKER_DELAY?{MONO_FIXTURE_PICKER_DELAY:env.MONO_FIXTURE_PICKER_DELAY}:{})};
  if(env.MONO_AUDIO_HELPER==='__fixture__'){const {mkdtempSync,chmodSync}=await import('node:fs');const {tmpdir}=await import('node:os');const dir=mkdtempSync(path.join(tmpdir(),'mono-helper-')),file=path.join(dir,'helper.sh');writeFileSync(file,`#!/bin/sh\nexec python3 '${fileURLToPath(new URL('../fixtures/audio-helper.py',import.meta.url))}' "$@" --behavior ${env.behavior||'impulse'}\n`);chmodSync(file,0o755);extra.MONO_AUDIO_HELPER=file}
  const server=await localServer(t,extra);
  writeFileSync(path.join(server.root,'test-picker.json'),JSON.stringify({create:path.join(server.root,'Мои записи'),open:path.join(server.root,'Мои записи')}));
  const browser=await playwright.chromium.launch();t.after(()=>browser.close());
  const page=await (await browser.newContext()).newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto(server.url+'/');
  await page.waitForSelector('.setup-panel :text("Выбрать папку")',{timeout:20000});
  await page.click('.setup-panel button:has-text("Выбрать папку")');
  await page.waitForFunction(()=>{const m=document.querySelector('.setup-message')?.textContent||'';return /2 из 3/.test(document.querySelector('.setup-step')?.textContent||'')||(m&&!/Выберите папку в системном окне/.test(m))},null,{timeout:45000});
  const state=await page.evaluate(()=>({step:document.querySelector('.setup-step')?.textContent,message:document.querySelector('.setup-message')?.textContent,toasts:[...document.querySelectorAll('.toast.error')].map(t=>t.textContent)}));
  assert.equal(state.message,'',`no error line under the button (got: ${state.message})`);
  assert.match(state.step,/2 из 3/);assert.deepEqual(state.toasts,[]);
  const status=await page.evaluate(async()=>(await fetch('/api/local/status')).json());
  assert.equal(status.libraryAvailable,true);assert.match(status.libraryPath,/Мои записи$/);
  assert.deepEqual(errors,[]);
 });
}

test('reconnecting a missing archive closes setup instead of leaving an empty panel',{skip:!playwright&&'playwright is not installed'},async t=>{
 const {rmSync}=await import('node:fs');
 const server=await localServer(t,{MONO_CORE_SCRIPT:FOLDER_WORKER});
 const target=path.join(server.root,'Новое место');
 writeFileSync(path.join(server.root,'test-picker.json'),JSON.stringify({create:target,open:target}));
 const browser=await playwright.chromium.launch();t.after(()=>browser.close());
 const page=await (await browser.newContext()).newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.goto(server.url+'/');
 const libraryPath=await page.evaluate(async()=>{const {csrf}=await (await fetch('/api/local/session')).json();const headers={'Content-Type':'application/json','X-Mono-CSRF':csrf};
  await fetch('/api/local/library/configure',{method:'POST',headers,body:JSON.stringify({useDefault:true})});
  await fetch('/api/local/preferences',{method:'PATCH',headers,body:JSON.stringify({onboarding:{completed:true,keySkipped:true,soundTested:true}})});
  return (await (await fetch('/api/local/status')).json()).libraryPath});
 // The archive folder disappeared while MONO was closed (deleted, disk unplugged). Windows keeps a
 // running core's lock file undeletable, so the core is stopped first.
 await server.stop();rmSync(libraryPath,{recursive:true,force:true});await server.start();
 await page.goto(server.url+'/');
 await page.waitForSelector('.setup-panel :text("Подключите ваш архив")',{timeout:20000});
 await page.click('.setup-panel button:has-text("Выбрать папку")');
 await page.waitForFunction(()=>!document.querySelector('.setup-panel'),null,{timeout:20000});
 const status=await page.evaluate(async()=>(await fetch('/api/local/status')).json());
 assert.equal(status.libraryAvailable,true);assert.match(status.libraryPath,/Новое место$/);
 assert.deepEqual(errors,[]);
});

test('no folder at first launch: «Начать запись» offers to choose one, the chosen folder works, and recording starts; choosing another folder later switches to it',{skip:!playwright&&'playwright is not installed',timeout:120000},async t=>{
 const server=await localServer(t,{MONO_CORE_SCRIPT:FOLDER_WORKER});
 const first=path.join(server.root,'Первая папка'),second=path.join(server.root,'Вторая папка');
 writeFileSync(path.join(server.root,'test-picker.json'),JSON.stringify({create:first,open:first}));
 const browser=await playwright.chromium.launch({args:['--use-fake-ui-for-media-stream','--use-fake-device-for-media-stream']});t.after(()=>browser.close());
 const context=await browser.newContext();await context.grantPermissions(['microphone'],{origin:server.url});
 const page=await context.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.goto(server.url+'/');await page.waitForSelector('.setup-panel');
 await page.click('.setup-close');await page.waitForSelector('.setup-panel',{state:'detached'});
 await page.click('.nav-link[data-view=record]');await page.click('#start-record');
 // an offer, not a notice: the person picks the place right here
 await page.waitForSelector('#modal:not([hidden])');assert.match(await page.textContent('#modal-title'),/сохранять записи/);
 await page.click('#modal-actions button:has-text("Выбрать папку")');
 await page.waitForFunction(()=>!document.querySelector('#stop-record').hidden,null,{timeout:45000});
 let status=await page.evaluate(async()=>(await fetch('/api/local/status')).json());assert.equal(status.libraryAvailable,true);assert.match(status.libraryPath,/Первая папка$/);
 assert.deepEqual(await page.evaluate(()=>[...document.querySelectorAll('.toast.error')].map(t=>t.textContent)),[]);
 await page.click('#stop-record');await page.waitForFunction(()=>!document.querySelector('#start-record').hidden,null,{timeout:20000});
 // later, Settings → another folder: it is used, no «недоступна»
 writeFileSync(path.join(server.root,'test-picker.json'),JSON.stringify({create:second,open:second}));
 await page.click('.nav-link[data-view=settings]');await page.evaluate(()=>{const card=document.querySelector('#request-persistence').closest('.settings-card');document.querySelector(`#settings-index a[data-target="${card.id}"]`).click()});await page.click('#request-persistence');await page.waitForSelector('#modal:not([hidden])');
 await page.click('#modal-actions button:has-text("Выбрать папку")');
 await page.waitForFunction(()=>/Вторая папка/.test(document.querySelector('#storage-persistence')?.textContent||''),null,{timeout:30000});
 status=await page.evaluate(async()=>(await fetch('/api/local/status')).json());assert.equal(status.libraryAvailable,true);assert.match(status.libraryPath,/Вторая папка$/);
 await page.click('.nav-link[data-view=record]');await page.click('#start-record');await page.waitForFunction(()=>!document.querySelector('#stop-record').hidden,null,{timeout:30000});
 await page.click('#stop-record');
 const toasts=await page.evaluate(()=>[...document.querySelectorAll('.toast.error')].map(t=>t.textContent));assert.deepEqual(toasts,[]);assert.deepEqual(errors,[]);
});
