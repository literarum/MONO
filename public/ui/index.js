import {mountSelect} from './select.js';
import {mountScrollArea} from './scroll-area.js';
import {mountDrawer} from './drawer.js';
const controls=new Map(),scrolls=new Map();let drawer;
export function syncControls(){for(const c of controls.values())c.sync()}
/** Measure the first ~2 s of frames once per launch; if this machine renders slowly
 * (>20 % of frames over 24 ms), switch glass to solid materials and remember it. */
export function qualityGovernor({frames=120,raf=globalThis.requestAnimationFrame,root=document.documentElement,store=globalThis.localStorage}={}){
 try{if(store?.getItem('mono-lite-glass')==='1'){root.classList.add('lite-glass');return}}catch{}
 if(typeof raf!=='function')return;let last=0,slow=0,count=0;
 const tick=t=>{if(last){count++;if(t-last>24)slow++}last=t;if(count<frames){raf(tick);return}
  if(slow/count>.2){root.classList.add('lite-glass');try{store?.setItem('mono-lite-glass','1')}catch{}}};
 raf(tick);
}
export function enhanceUI(){
 qualityGovernor();
 const scan=()=>{
  for(const [node,c] of controls)if(!node.isConnected){c.destroy();controls.delete(node)}
  for(const [node,c] of scrolls)if(!node.isConnected){c.destroy();scrolls.delete(node)}
  document.querySelectorAll('select').forEach(el=>{if(!controls.has(el))controls.set(el,mountSelect(el))});
  document.querySelectorAll('textarea,.modal-panel,.setup-panel').forEach(el=>{if(!scrolls.has(el))scrolls.set(el,mountScrollArea(el))});
  // Icon-only controls and the short tab-bar labels get the full name as a tooltip.
  document.querySelectorAll('.icon-btn[aria-label]:not([title]),.nav-link[aria-label]:not([title]),.play-btn[aria-label]:not([title])').forEach(el=>{el.title=el.getAttribute('aria-label')});
 };
 const main=document.querySelector('main');scrolls.set(main,mountScrollArea(main));
 // Scroll edge effect: content fades under the floating toolbar once it scrolls beneath it.
 let edge=false;main.addEventListener('scroll',()=>{const next=main.scrollTop>4;if(next!==edge){edge=next;document.body.classList.toggle('content-scrolled',next)}},{passive:true});
 const sidebar=document.querySelector('#sidebar'),inner=document.createElement('div');inner.className='sidebar-inner';while(sidebar.firstChild)inner.append(sidebar.firstChild);sidebar.append(inner);scrolls.set(inner,mountScrollArea(inner));
 drawer=mountDrawer({sidebar,trigger:document.querySelector('#mobile-menu'),content:document.querySelector('.main-column')});
 // One scan per frame, and only when elements (not text) were added or removed: text updates
 // several times a second (timer, level, status) used to rescan the whole document each time.
 let pending=0;const schedule=records=>{if(pending)return;if(records&&!records.some(r=>[...r.addedNodes,...r.removedNodes].some(n=>n.nodeType===1)))return;pending=requestAnimationFrame(()=>{pending=0;scan()})};
 scan();const observer=new MutationObserver(schedule);observer.observe(document.body,{childList:true,subtree:true});
 return {drawer,destroy(){observer.disconnect();drawer.destroy();for(const c of controls.values())c.destroy();for(const c of scrolls.values())c.destroy();controls.clear();scrolls.clear()}};
}
export function closeDrawer(reason='route'){drawer?.close(reason)}
