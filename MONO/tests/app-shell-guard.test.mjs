import test from 'node:test';import assert from 'node:assert/strict';
import {guardAppShell,editable} from '../public/app-shell-guard.js';
class Doc extends EventTarget{constructor(){super();this.documentElement={classList:{add(){}}}}}
const target=(selectable)=>({closest:selector=>selectable&&selector.includes('input')?{}:null});
const fire=(doc,type,props)=>{const event=new Event(type,{cancelable:true});const {target:_t,...rest}=props;Object.assign(event,rest);Object.defineProperty(event,'target',{value:props.target||target(false)});doc.dispatchEvent(event);return event.defaultPrevented};
test('the browser context menu, dragging, selection, save/print/source shortcuts and its find bar are blocked outside fields',()=>{
 const doc=new Doc();let finds=0;guardAppShell({doc,onFind:()=>{finds++}});
 assert.equal(fire(doc,'contextmenu',{}),true);assert.equal(fire(doc,'contextmenu',{target:target(true)}),false,'a field keeps its menu (copy, paste)');
 assert.equal(fire(doc,'dragstart',{}),true);assert.equal(fire(doc,'selectstart',{}),true);assert.equal(fire(doc,'selectstart',{target:target(true)}),false);
 for(const key of ['s','u','p'])assert.equal(fire(doc,'keydown',{key,ctrlKey:true}),true,'Ctrl+'+key);
 assert.equal(fire(doc,'keydown',{key:'f',ctrlKey:true}),true);assert.equal(finds,1,'Ctrl+F opens MONO search');
 assert.equal(fire(doc,'keydown',{key:'c',ctrlKey:true}),false,'copy still works');assert.equal(fire(doc,'wheel',{ctrlKey:true}),true);
 assert.equal(editable({closest:()=>null}),false);
});
