import test from 'node:test';import assert from 'node:assert/strict';
import {markLauncherWindow,guardSingleWindow} from '../public/window-guard.js';
class Bus{constructor(){this.members=new Set()}}
const bus=new Bus();
class Channel{constructor(){this.onmessage=null;bus.members.add(this)}postMessage(data){for(const member of bus.members)if(member!==this)queueMicrotask(()=>member.onmessage?.({data}))}close(){bus.members.delete(this)}}
function env(search,flag=null){const store=new Map(flag?[['mono-launcher-window','1']]:[]);const location={search,pathname:'/',hash:'#record'};const history={state:null,replaceState(_s,_t,url){this.url=url}};return {location,history,storage:{getItem:k=>store.get(k)??null,setItem:(k,v)=>store.set(k,v)}}}
test('the launcher marker is remembered for the window and removed from the address',()=>{
 const e=env('?window=mono');assert.equal(markLauncherWindow(e),true);assert.equal(e.history.url,'/#record');
 assert.equal(markLauncherWindow(env('')),false);assert.equal(markLauncherWindow(env('',true)),true);
});
test('of two MONO windows the newer one closes and the older comes forward; a refused close offers to take over',async()=>{
 const g=globalThis;const saved={location:g.location,history:g.history,sessionStorage:g.sessionStorage};
 const use=e=>{Object.defineProperty(g,'location',{value:e.location,configurable:true});Object.defineProperty(g,'history',{value:e.history,configurable:true});Object.defineProperty(g,'sessionStorage',{value:e.storage,configurable:true})};
 let focused=0,closedOld=0,closedNew=0,duplicate=null;
 use(env('?window=mono'));guardSingleWindow({Channel,started:1,onFocus:()=>focused++,close:()=>closedOld++});
 use(env('?window=mono'));guardSingleWindow({Channel,started:2,close:()=>closedNew++,wait:5,onDuplicate:take=>{duplicate=take}});
 await new Promise(r=>setTimeout(r,30));
 assert.equal(focused,1);assert.equal(closedNew,1);assert.equal(closedOld,0);assert.equal(typeof duplicate,'function','the window stayed open, so it offers to work here');
 duplicate();await new Promise(r=>setTimeout(r,30));assert.equal(closedOld,1,'taking over retires the other window');
 for(const [k,v] of Object.entries(saved))Object.defineProperty(g,k,{value:v,configurable:true});
});
