// Editor intelligence in a real browser: doubtful places, paragraphs, learned terms and the
// meeting summary through a local fake of Groq's chat API.
import {showPane} from '../helpers/settings-pane.mjs';
import test from 'node:test';import assert from 'node:assert/strict';import http from 'node:http';import {once} from 'node:events';
import {localServer} from '../helpers/local-server.mjs';import {createRequire} from 'node:module';
let playwright=null;
try{playwright=await import('playwright')}catch{try{playwright=createRequire(import.meta.url)('playwright')}catch{}}
const skip=!playwright&&'playwright is not installed';

test('editor: doubtful places, paragraphs, learned terms and a summary with time links',{skip},async t=>{
 const chats=[];const groq=http.createServer(async(req,res)=>{let body='';for await(const p of req)body+=p;res.setHeader('Content-Type','application/json');
  if(req.url.endsWith('/models')){res.end(JSON.stringify({data:[{id:'openai/gpt-oss-120b'}]}));return}
  chats.push(JSON.parse(body));res.end(JSON.stringify({model:'openai/gpt-oss-120b',choices:[{message:{content:JSON.stringify({overview:'Обсудили запуск.',decisions:[{text:'Запуск в пятницу',at:'00:08'}],actions:[{text:'Подготовить релиз',owner:'Ирина'}]})}}]}))});
 groq.listen(0,'127.0.0.1');await once(groq,'listening');t.after(()=>groq.close());
 const server=await localServer(t,{GROQ_API_KEY:'gsk_e2e',MONO_GROQ_CHAT_BASE:`http://127.0.0.1:${groq.address().port}/openai/v1`});
 const browser=await playwright.chromium.launch();t.after(()=>browser.close());
 const page=await (await browser.newContext()).newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.goto(server.url+'/');
 const id=await page.evaluate(async()=>{const {csrf}=await (await fetch('/api/local/session')).json();const headers={'Content-Type':'application/json','X-Mono-CSRF':csrf};
  await fetch('/api/local/library/configure',{method:'POST',headers,body:JSON.stringify({useDefault:true})});
  await fetch('/api/local/preferences',{method:'PATCH',headers,body:JSON.stringify({onboarding:{completed:true,keySkipped:true,soundTested:true}})});
  const record=await (await fetch('/api/local/records',{method:'POST',headers,body:JSON.stringify({title:'Планёрка'})})).json();
  const transcript={model:'fixture',segments:[{id:0,start:0,end:3,text:'Мы перешли на грок.',confidence:.9},{id:1,start:3.2,end:6,text:'Это быстро.',confidence:.88},{id:2,start:8,end:10,text:'Запуск в пятницу.',confidence:.2}]};
  await fetch(`/api/local/records/${record.id}/transcript`,{method:'PUT',headers:{...headers,'X-Mono-Version':String(record.version)},body:JSON.stringify(transcript)});return record.id});
 await page.reload();await page.waitForFunction(()=>document.querySelector('#nav-count'));
 await page.evaluate(id=>{location.hash='#editor/'+id},id);
 await page.waitForFunction(()=>!document.querySelector('#next-doubt').hidden,null,{timeout:15000});
 assert.match(await page.textContent('#next-doubt'),/1 место/);
 assert.equal(await page.locator('.segment-edit.is-doubtful').count(),1);
 assert.equal(await page.locator('.transcript-paragraph.paragraph-start').count(),1,'the 2 s pause starts a new paragraph');
 // N jumps to the doubtful fragment.
 await page.locator('body').click({position:{x:5,y:5}});await page.keyboard.press('n');
 assert.equal(await page.evaluate(()=>document.activeElement?.dataset.segment),'2');
 // A corrected name is learned on leaving the fragment and shown in settings.
 const first=page.locator('[data-segment="0"]');await first.fill('Мы перешли на Groq.');await page.locator('[data-segment="1"]').focus();
 await page.waitForSelector('.toast:has-text("MONO запомнил: Groq")');
 // Summary: explicit consent, then the panel with a time link.
 await page.click('#summary-open');await page.click('#modal-actions .btn-primary');
 await page.waitForSelector('#summary-panel:not([hidden]) :text("Запуск в пятницу")',{timeout:15000});
 assert.equal(await page.textContent('#summary-panel .summary-at'),'00:08');
 assert.match(chats[0].messages[1].content,/\[00:08\] Запуск в пятницу/);

 // The archive version moves on behind the window's back (as when a summary is saved): the next edit still lands.
 await page.evaluate(async id=>{const {csrf}=await (await fetch('/api/local/session')).json();const r=await (await fetch('/api/local/records/'+id)).json();
  await fetch('/api/local/records/'+id,{method:'PATCH',headers:{'Content-Type':'application/json','X-Mono-CSRF':csrf},body:JSON.stringify({expectedVersion:r.version,patch:{bookmarks:[{at:1,label:'Важно'}]}})})},id);
 await page.locator('[data-segment="1"]').fill('Это очень быстро.');
 await page.waitForFunction(()=>document.querySelector('#editor-status').textContent==='Сохранено',null,{timeout:10000});
 const saved=await page.evaluate(async id=>(await (await fetch(`/api/local/records/${id}/transcript?offset=1&limit=1`)).json()).segments[0].text,id);
 assert.equal(saved,'Это очень быстро.');
 await page.evaluate(()=>{location.hash='#settings'});await showPane(page,'#learned-terms');await page.waitForSelector('#learned-terms:not([hidden]) .term-chip:has-text("Groq")');
 assert.equal(await page.locator('.toast.error').count(),0,'an edit during the summary must not conflict');
 assert.equal(await page.textContent('#editor-status'),'Сохранено');
 assert.deepEqual(errors,[]);
});
