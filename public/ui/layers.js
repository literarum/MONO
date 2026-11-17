const stack=[];
const focusables=el=>[...el.querySelectorAll('button:not(:disabled),a[href],input:not(:disabled),textarea:not(:disabled),[tabindex="0"]')].filter(x=>!x.hidden&&x.getClientRects().length);
export function openLayer({element,anchor=null,modal=false,background=null,onClose=()=>{}}){
 const previous=document.activeElement,abort=new AbortController(),{signal}=abort;
 let closed=false,frame=0;
 const oldInert=background?.inert;
 if(modal&&background)background.inert=true;
 const close=(reason='dismiss',restore=true)=>{
  if(closed)return;closed=true;abort.abort();cancelAnimationFrame(frame);
  stack.splice(stack.indexOf(api),1);
  if(modal&&background)background.inert=oldInert;
  onClose(reason);if(restore&&previous?.isConnected&&!previous.closest('[inert]'))previous.focus({preventScroll:true});
 };
 const position=()=>{
  if(!anchor||closed)return;
  if(!anchor.isConnected||!anchor.getClientRects().length){close('anchor-removed');return}
  const r=anchor.getBoundingClientRect(),gap=8,margin=8;
  element.style.width=`${Math.min(Math.max(r.width,180),innerWidth-margin*2)}px`;
  element.style.maxHeight=`${Math.max(60,Math.min(320,Math.max(r.top,innerHeight-r.bottom)-gap-margin))}px`;
  const h=element.getBoundingClientRect().height;
  element.style.left=`${Math.max(margin,Math.min(r.left,innerWidth-element.offsetWidth-margin))}px`;
  element.style.top=`${r.bottom+gap+h<=innerHeight-margin?r.bottom+gap:Math.max(margin,r.top-h-gap)}px`;
 };
 const reposition=()=>{cancelAnimationFrame(frame);frame=requestAnimationFrame(position)};
 const api={close,position};stack.push(api);
 document.addEventListener('pointerdown',e=>{if(stack.at(-1)===api&&!element.contains(e.target)&&!anchor?.contains(e.target)){if(modal)e.preventDefault();close('outside')}},{capture:true,signal});
 document.addEventListener('keydown',e=>{
  if(stack.at(-1)!==api)return;
  if(e.key==='Escape'){e.preventDefault();e.stopImmediatePropagation();close('escape');return}
  if(e.key==='Tab'&&modal){const all=focusables(element),first=all[0],last=all.at(-1);if(!first){e.preventDefault();element.focus();return}if(e.shiftKey&&document.activeElement===first){e.preventDefault();last.focus()}else if(!e.shiftKey&&document.activeElement===last){e.preventDefault();first.focus()}}
 },{capture:true,signal});
 window.addEventListener('resize',reposition,{signal});window.addEventListener('scroll',reposition,{capture:true,passive:true,signal});
 position();return api;
}
