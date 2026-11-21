// «Глубокая диагностика» in a real browser: live microphone test, server checks, report
// without paths or keys, and the journal that survives a core restart.
import test from 'node:test';import assert from 'node:assert/strict';import net from 'node:net';import {once} from 'node:events';
import {localServer} from '../helpers/local-server.mjs';import {createRequire} from 'node:module';
let playwright=null;
try{playwright=await import('playwright')}catch{try{playwright=createRequire(import.meta.url)('playwright')}catch{}}

test('deep diagnostics: live microphone, server checks, private report, journal across restarts',{skip:!playwright&&'playwright is not installed'},async t=>{
 const closed=net.createServer().listen(0,'127.0.0.1');await once(closed,'listening');const port=closed.address().port;await new Promise(r=>closed.close(r));
 const server=await localServer(t,{GROQ_API_KEY:'gsk_secret_e2e_key',MONO_GROQ_CHAT_BASE:`http://127.0.0.1:${port}/openai/v1`});
 const browser=await playwright.chromium.launch({args:['--use-fake-ui-for-media-stream','--use-fake-device-for-media-stream']});t.after(()=>browser.close());
 const context=await browser.newContext();await context.addInitScript(()=>{try{localStorage.setItem('mono-source-browser-1','1')}catch{}});await context.grantPermissions(['microphone','clipboard-read','clipboard-write'],{origin:server.url});
 const page=await context.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.goto(server.url+'/');
 await page.evaluate(async()=>{const {csrf}=await (await fetch('/api/local/session')).json();const headers={'Content-Type':'application/json','X-Mono-CSRF':csrf};
  await fetch('/api/local/library/configure',{method:'POST',headers,body:JSON.stringify({useDefault:true})});
  await fetch('/api/local/preferences',{method:'PATCH',headers,body:JSON.stringify({onboarding:{completed:true,keySkipped:true,soundTested:true},capture:{mode:'mic'}})})});
 await server.restart(); // a second start must show up in the journal
 await page.goto(server.url+'/');await page.waitForFunction(()=>document.querySelector('#nav-count'));await page.evaluate(()=>{location.hash='#settings'});
 await page.waitForSelector('.preflight-deep',{timeout:30000});
 await page.click('.preflight-deep');
 await page.waitForSelector('#deep-copy',{timeout:40000});
 // Groq points at a closed port: the conclusion must name the network problem.
 assert.match(await page.textContent('#modal-text'),/Нет связи с Groq/);
 await page.click('#deep-copy');
 const text=await page.evaluate(()=>navigator.clipboard.readText());
 assert.match(text,/^MONO — глубокая диагностика/);
 const data=JSON.parse(text.slice(text.indexOf('{')));
 assert.equal(data.microphone.raw.ok,true,'the fake microphone was opened and measured');assert.ok(data.microphone.raw.peakDb>-90,'fake device produces a tone');assert.equal(data.microphone.processed.ok,true,'the processed browser path is measured too');
 assert.equal(data.server.groq.error,'ECONNREFUSED');assert.equal(data.server.core.responds,true);
 assert.ok(data.server.journal.filter(r=>r.level==='start').length>=2,'starts are kept across restarts');
 assert.ok(!text.includes(server.root),'no archive or data paths');assert.ok(!text.includes('gsk_secret'),'no key');
 assert.ok(data.window.frames===undefined||data.window.frames.fps>0);
 assert.deepEqual(errors,[]);
});
