import {scrollMetrics} from './scroll-model.js';
const mounted=new WeakMap();let serial=0;
export function mountScrollArea(viewport,{axes='y'}={}){
 if(mounted.has(viewport))return mounted.get(viewport);
 const abort=new AbortController(),{signal}=abort,shell=document.createElement('div');
 shell.className='scroll-shell'+(viewport.id==='main'?' main-scroll-shell':'');
 viewport.before(shell);shell.append(viewport);viewport.classList.add('scroll-viewport');viewport.id||=`scroll-${++serial}`;
 let raf=0,hold=0,repeat=0;const rails=[];
 const stopHold=()=>{clearTimeout(hold);clearInterval(repeat)};
 for(const axis of axes==='both'?['y','x']:['y']){
  const y=axis==='y',rail=document.createElement('div'),before=document.createElement('button'),after=document.createElement('button'),track=document.createElement('div'),thumb=document.createElement('div');
  const pos=y?'scrollTop':'scrollLeft',size=y?'clientHeight':'clientWidth',content=y?'scrollHeight':'scrollWidth',coord=y?'clientY':'clientX';
  rail.className=`scroll-rail scroll-${axis}`;track.className='scroll-track';thumb.className='scroll-thumb';
  thumb.tabIndex=0;thumb.role='scrollbar';thumb.setAttribute('aria-label',y?'Вертикальная прокрутка':'Горизонтальная прокрутка');thumb.setAttribute('aria-controls',viewport.id);thumb.setAttribute('aria-orientation',y?'vertical':'horizontal');thumb.setAttribute('aria-valuemin','0');
  for(const [btn,dir] of [[before,-1],[after,1]]){
   btn.type='button';btn.className='scroll-arrow';btn.textContent=y?(dir<0?'▴':'▾'):(dir<0?'‹':'›');btn.setAttribute('aria-label','Прокрутить '+(y?(dir<0?'вверх':'вниз'):(dir<0?'влево':'вправо')));
   const step=()=>viewport[pos]+=dir*40;
   btn.addEventListener('click',step,{signal});btn.addEventListener('pointerdown',()=>{stopHold();hold=setTimeout(()=>repeat=setInterval(step,50),280)},{signal});
  }
  track.append(thumb);rail.append(before,track,after);shell.append(rail);
  const metrics=()=>scrollMetrics({content:viewport[content],viewport:viewport[size],position:viewport[pos],track:track[size],minThumb:24});
  thumb.addEventListener('pointerdown',e=>{
   e.preventDefault();thumb.focus({preventScroll:true});thumb.setPointerCapture(e.pointerId);const start=e[coord],initial=viewport[pos],m=metrics();
   const move=ev=>{const travel=track[size]-m.thumb;if(travel>0)viewport[pos]=initial+(ev[coord]-start)*m.max/travel};
   const end=()=>{thumb.removeEventListener('pointermove',move);thumb.removeEventListener('pointerup',end);thumb.removeEventListener('pointercancel',end)};
   thumb.addEventListener('pointermove',move,{signal});thumb.addEventListener('pointerup',end,{signal});thumb.addEventListener('pointercancel',end,{signal});
  },{signal});
  track.addEventListener('pointerdown',e=>{if(e.target!==track)return;const r=track.getBoundingClientRect(),m=metrics();viewport[pos]+=(e[coord]-(y?r.top:r.left)<m.offset?-1:1)*viewport[size]},{signal});
  thumb.addEventListener('keydown',e=>{const delta={ArrowDown:40,ArrowRight:40,ArrowUp:-40,ArrowLeft:-40,PageDown:viewport[size],PageUp:-viewport[size]};if(e.key in delta){e.preventDefault();viewport[pos]+=delta[e.key]}else if(e.key==='Home'||e.key==='End'){e.preventDefault();viewport[pos]=e.key==='Home'?0:metrics().max}},{signal});
  rails.push({rail,update(){const m=metrics(),overflow=m.max>0;rail.hidden=!overflow;shell.classList.toggle(`has-scroll-${axis}`,overflow);thumb.style[y?'height':'width']=m.thumb+'px';thumb.style.transform=`translate${y?'Y':'X'}(${m.offset}px)`;thumb.setAttribute('aria-valuemax',String(m.max));thumb.setAttribute('aria-valuenow',String(Math.max(0,Math.min(m.max,Math.round(viewport[pos])))));before.disabled=m.atStart;after.disabled=m.atEnd}});
 }
 const refresh=()=>{cancelAnimationFrame(raf);raf=requestAnimationFrame(()=>rails.forEach(r=>r.update()))};
 viewport.addEventListener('scroll',refresh,{passive:true,signal});viewport.addEventListener('input',refresh,{signal});window.addEventListener('resize',refresh,{signal});window.addEventListener('pointerup',stopHold,{signal});window.addEventListener('pointercancel',stopHold,{signal});window.addEventListener('blur',stopHold,{signal});
 const resize=new ResizeObserver(refresh);resize.observe(viewport);if(viewport.firstElementChild)resize.observe(viewport.firstElementChild);
 const mutation=new MutationObserver(refresh);mutation.observe(viewport,{childList:true,subtree:true,characterData:true});
 const api={refresh,destroy(){abort.abort();stopHold();resize.disconnect();mutation.disconnect();cancelAnimationFrame(raf);viewport.classList.remove('scroll-viewport');shell.before(viewport);shell.remove();mounted.delete(viewport)}};
 mounted.set(viewport,api);refresh();return api;
}
