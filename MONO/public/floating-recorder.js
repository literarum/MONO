// The recording travels with the person: outside the studio a small glass panel keeps the take in
// view — a pulsing light, the time, pause/continue and stop — and a click on it returns to the
// studio. It can be dragged anywhere (the place is remembered) and, where the browser offers
// Document Picture-in-Picture (Chrome/Edge 116+), lifted «поверх всех окон», so it stays visible
// when MONO is minimised.
const PLACE='mono-floating-recorder';
const clock=seconds=>{const s=Math.max(0,Math.floor(seconds||0));return [Math.floor(s/3600),Math.floor(s/60)%60,s%60].map(n=>String(n).padStart(2,'0')).join(':')};

export class FloatingRecorder{
 constructor({onOpen,onPause,onStop,enabled=()=>true,inStudio=()=>false,icon=name=>`<svg><use href="#i-${name}"/></svg>`}){
  Object.assign(this,{onOpen,onPause,onStop,enabled,inStudio,icon});this.active=false;this.value=null;this.pip=null;this.el=null;
 }
 mount(){
  if(this.el)return this.el;
  const el=document.createElement('div');el.className='floating-recorder glass';el.hidden=true;el.setAttribute('role','region');el.setAttribute('aria-label','Идёт запись');
  el.innerHTML=`<button type="button" class="fr-grip" aria-label="Переместить панель записи" title="Перетащите, чтобы переместить"><span></span><span></span></button><button type="button" class="fr-open" title="Открыть студию записи"><span class="fr-light" aria-hidden="true"></span><span class="fr-text"><strong class="fr-time">00:00:00</strong><span class="fr-state">Запись</span></span></button><div class="fr-actions"><button type="button" class="fr-btn fr-pause" aria-label="Пауза">${this.icon('pause')}</button><button type="button" class="fr-btn fr-stop" aria-label="Завершить запись">${this.icon('stop')}</button><button type="button" class="fr-btn fr-pip" aria-label="Поверх всех окон" title="Поверх всех окон" hidden>${this.icon('grid')}</button></div>`;
  document.body.append(el);this.el=el;
  el.querySelector('.fr-open').onclick=()=>this.onOpen?.();el.querySelector('.fr-pause').onclick=()=>this.onPause?.();el.querySelector('.fr-stop').onclick=()=>this.onStop?.();
  const pip=el.querySelector('.fr-pip');pip.hidden=!('documentPictureInPicture' in globalThis);pip.onclick=()=>void this.lift();
  this.restore();this.drag(el.querySelector('.fr-grip'));addEventListener('resize',()=>this.clamp());
  return el;
 }
 restore(){try{const place=JSON.parse(localStorage.getItem(PLACE)||'null');if(place&&Number.isFinite(place.x)&&Number.isFinite(place.y)){this.el.style.left=place.x+'px';this.el.style.top=place.y+'px';this.el.classList.add('is-placed')}}catch{}}
 clamp(){if(!this.el?.classList.contains('is-placed'))return;const box=this.el.getBoundingClientRect(),x=Math.min(Math.max(8,box.left),innerWidth-box.width-8),y=Math.min(Math.max(8,box.top),innerHeight-box.height-8);this.el.style.left=x+'px';this.el.style.top=y+'px';return {x,y}}
 drag(handle){
  let start=null;
  handle.addEventListener('pointerdown',event=>{const box=this.el.getBoundingClientRect();start={dx:event.clientX-box.left,dy:event.clientY-box.top};handle.setPointerCapture(event.pointerId);this.el.classList.add('is-dragging','is-placed');this.el.style.left=box.left+'px';this.el.style.top=box.top+'px'});
  handle.addEventListener('pointermove',event=>{if(!start)return;this.el.style.left=(event.clientX-start.dx)+'px';this.el.style.top=(event.clientY-start.dy)+'px';this.clamp()});
  const end=()=>{if(!start)return;start=null;this.el.classList.remove('is-dragging');const place=this.clamp();try{if(place)localStorage.setItem(PLACE,JSON.stringify(place))}catch{}};
  handle.addEventListener('pointerup',end);handle.addEventListener('pointercancel',end);
  handle.addEventListener('keydown',event=>{const step={ArrowLeft:[-20,0],ArrowRight:[20,0],ArrowUp:[0,-20],ArrowDown:[0,20]}[event.key];if(!step)return;event.preventDefault();const box=this.el.getBoundingClientRect();this.el.classList.add('is-placed');this.el.style.left=box.left+step[0]+'px';this.el.style.top=box.top+step[1]+'px';const place=this.clamp();try{localStorage.setItem(PLACE,JSON.stringify(place))}catch{}});
 }
 update(active,value){
  this.active=active;this.value=value;const el=this.mount();const show=active&&this.enabled()&&!this.inStudio();
  if(show&&el.hidden){el.hidden=false;el.classList.remove('is-leaving');void el.offsetWidth;el.classList.add('is-in')}
  else if(!show&&!el.hidden){el.classList.remove('is-in');el.hidden=true}
  const paused=value?.state==='paused';el.dataset.state=paused?'paused':'recording';
  for(const root of [el,this.pip?.document?.body].filter(Boolean)){
   const time=root.querySelector('.fr-time'),state=root.querySelector('.fr-state'),pause=root.querySelector('.fr-pause');
   if(time)time.textContent=clock(value?.duration);if(state)state.textContent=paused?'На паузе':'Идёт запись';
   if(pause){pause.innerHTML=this.icon(paused?'play':'pause');pause.setAttribute('aria-label',paused?'Продолжить запись':'Пауза')}
   root.querySelector('.floating-recorder')?.setAttribute('data-state',paused?'paused':'recording');
  }
  if(!active&&this.pip){this.pip.close();this.pip=null}
 }
 /** Always-on-top copy of the panel (Document Picture-in-Picture). Needs the click that asks for it. */
 async lift(){
  if(!('documentPictureInPicture' in globalThis))return;
  try{
   const pip=await documentPictureInPicture.requestWindow({width:300,height:92});this.pip=pip;
   for(const sheet of document.querySelectorAll('link[rel=stylesheet]')){const link=pip.document.createElement('link');link.rel='stylesheet';link.href=sheet.href;pip.document.head.append(link)}
   const sprite=document.querySelector("svg.sprite");if(sprite)pip.document.body.append(sprite.cloneNode(true));
   pip.document.body.dataset.theme=document.body.dataset.theme;pip.document.body.classList.add('pip-body');
   const copy=this.el.cloneNode(true);copy.hidden=false;copy.classList.add('is-pip');copy.querySelector('.fr-grip')?.remove();copy.querySelector('.fr-pip')?.remove();pip.document.body.append(copy);
   copy.querySelector('.fr-open').onclick=()=>{globalThis.focus();this.onOpen?.()};copy.querySelector('.fr-pause').onclick=()=>this.onPause?.();copy.querySelector('.fr-stop').onclick=()=>this.onStop?.();
   pip.addEventListener('pagehide',()=>{this.pip=null});this.update(this.active,this.value);
  }catch{/* the browser refused: the in-window panel stays */}
 }
}
