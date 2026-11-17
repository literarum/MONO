import test from 'node:test';import assert from 'node:assert/strict';import vm from 'node:vm';import {readFile} from 'node:fs/promises';
const source=await readFile(new URL('../public/sw.js',import.meta.url),'utf8'),origin='http://127.0.0.1:4173';
async function request(path,{cachedStyle=false,networkHTML=false,navigate=false}={}){
 const listeners=new Map(),cachedHTML=()=>new Response('<html>shell</html>',{headers:{'Content-Type':'text/html'}});
 const context={URL,Request,Response,console,self:{location:{origin},addEventListener:(name,fn)=>listeners.set(name,fn)},caches:{match:async query=>{const key=typeof query==='string'?query:new URL(query.url).pathname;if(key==='/index.html')return cachedHTML();if(cachedStyle&&key===path)return new Response('body{color:white}',{headers:{'Content-Type':'text/css'}})},open:async()=>({put:async()=>{}})},fetch:async()=>{if(networkHTML)return cachedHTML();throw new TypeError('offline')}};
 vm.runInNewContext(source,context);let reply;
 listeners.get('fetch')({request:{method:'GET',url:origin+path,mode:navigate?'navigate':'cors',destination:navigate?'document':path.endsWith('.css')?'style':'script'},respondWith:value=>reply=value,waitUntil:()=>{}});
 return await reply;
}
for(const path of ['/styles.css','/browser-microphone.js'])test('offline uncached asset never receives HTML shell: '+path,async()=>{const r=await request(path);assert.equal(r.type,'error');assert.notEqual(r.headers.get('Content-Type'),'text/html')});
test('offline cached stylesheet stays a stylesheet and navigation still restores shell',async()=>{const css=await request('/styles.css',{cachedStyle:true});assert.equal(css.headers.get('Content-Type'),'text/css');assert.match(await css.text(),/color:white/);const page=await request('/',{navigate:true});assert.equal(page.headers.get('Content-Type'),'text/html')});
test('HTML response cannot poison stylesheet cache and valid cached CSS is used',async()=>{const r=await request('/styles.css',{cachedStyle:true,networkHTML:true});assert.equal(r.headers.get('Content-Type'),'text/css');assert.match(await r.text(),/color:white/)});
