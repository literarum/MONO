import {mountSelect} from './select.js';
import {mountScrollArea} from './scroll-area.js';
import {mountDrawer} from './drawer.js';
const controls=new Map(),scrolls=new Map();let drawer;
export function syncControls(){for(const c of controls.values())c.sync()}
export function enhanceUI(){
 const scan=()=>{
  for(const [node,c] of controls)if(!node.isConnected){c.destroy();controls.delete(node)}
  for(const [node,c] of scrolls)if(!node.isConnected){c.destroy();scrolls.delete(node)}
  document.querySelectorAll('select').forEach(el=>{if(!controls.has(el))controls.set(el,mountSelect(el))});
  document.querySelectorAll('textarea,.modal-panel,.setup-panel').forEach(el=>{if(!scrolls.has(el))scrolls.set(el,mountScrollArea(el))});
 };
 const main=document.querySelector('main');scrolls.set(main,mountScrollArea(main));
 const sidebar=document.querySelector('#sidebar'),inner=document.createElement('div');inner.className='sidebar-inner';while(sidebar.firstChild)inner.append(sidebar.firstChild);sidebar.append(inner);scrolls.set(inner,mountScrollArea(inner));
 drawer=mountDrawer({sidebar,trigger:document.querySelector('#mobile-menu'),content:document.querySelector('.main-column')});
 scan();const observer=new MutationObserver(scan);observer.observe(document.body,{childList:true,subtree:true});
 return {drawer,destroy(){observer.disconnect();drawer.destroy();for(const c of controls.values())c.destroy();for(const c of scrolls.values())c.destroy();controls.clear();scrolls.clear()}};
}
export function closeDrawer(reason='route'){drawer?.close(reason)}
