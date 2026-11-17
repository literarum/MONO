import test from 'node:test';import assert from 'node:assert/strict';import {readFile} from 'node:fs/promises';import vm from 'node:vm';

async function fixture(){
 const source=await readFile(new URL('../public/app.js',import.meta.url),'utf8');
 const start=source.indexOf('function notify('),end=source.indexOf('\nlet modalReturnFocus',start);
 assert.ok(start>=0&&end>start);let id=0;const timers=new Map(),children=[];
 const area={children,append(el){children.push(el);el.isConnected=true}};
 const document={createElement(){return {dataset:{},attributes:{},isConnected:false,setAttribute(k,v){this.attributes[k]=v},remove(){const i=children.indexOf(this);if(i>=0)children.splice(i,1);this.isConnected=false}}}};
 const context=vm.createContext({document,$:selector=>{assert.equal(selector,'#toast-area');return area},setTimeout(fn,ms){assert.equal(ms,6500);timers.set(++id,fn);return id},clearTimeout(key){timers.delete(key)}});
 vm.runInContext(source.slice(start,end)+';globalThis.send=notify;',context);
 return {send:context.send,children,timers,expire(){const pending=[...timers];timers.clear();for(const [,fn] of pending)fn()}};
}
test('repeated active capture/archive warning stays one toast and renews its deadline',async()=>{
 const f=await fixture();const message='Подключите папку архива перед записью.';
 f.send(message,'error');const first=f.children[0],initial=[...f.timers.keys()][0];
 f.send(message,'error');f.send(message,'error');
 assert.equal(f.children.length,1);assert.equal(f.children[0],first);assert.equal(f.timers.size,1);assert.ok(!f.timers.has(initial));
 f.expire();assert.equal(f.children.length,0);f.send(message,'error');assert.equal(f.children.length,1);assert.notEqual(f.children[0],first);
});
test('distinct notification text/types remain independent and text never becomes HTML',async()=>{
 const f=await fixture();f.send('<img src=x onerror=alert(1)>','error');f.send('Other','error');f.send('Other','info');
 assert.equal(f.children.length,3);assert.equal(f.children[0].textContent,'<img src=x onerror=alert(1)>');assert.equal(f.children[0].innerHTML,undefined);
 f.expire();assert.equal(f.children.length,0);
});
test('externally removed toast can be recreated and old timers do not remove it',async()=>{
 const f=await fixture();f.send('One','error');const stale=[...f.timers.values()][0];f.children[0].remove();f.send('One','error');stale();
 assert.equal(f.children.length,1);f.send('One','error');assert.equal(f.children.length,1);f.expire();assert.equal(f.children.length,0);
});
