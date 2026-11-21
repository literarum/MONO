// The feature tour: a calm walk through MONO, one idea per step. Each step can point at a real part
// of the window — a soft spotlight cuts it out of a dimmed glass veil and a card explains it in
// plain words. Arrows, Enter and Esc work; «Назад», «Далее», «Пропустить» are always there.
export const TOUR_STEPS=Object.freeze([
 {title:'Добро пожаловать в MONO',text:'MONO записывает разговоры и превращает их в текст с таймкодами. Покажем всё главное — это займёт минуту.',art:'wave'},
 {view:'dashboard',target:'#hero-import',title:'Готовая запись → текст',text:'Перетащите сюда аудио или видео любой длины — или нажмите, чтобы выбрать файл. Звук из видео MONO извлечёт сам.'},
 {view:'record',target:'#start-record',title:'Запись встречи',text:'Нажмите «Начать запись». Можно ставить паузу — тогда появятся «Продолжить запись» и «Создать новую запись».'},
 {view:'record',target:'.studio-side',title:'Что записывать',text:'Микрофон, звук компьютера или всё сразу. MONO сам проверяет микрофон и подсказывает, если что-то мешает.'},
 {view:'record',target:'.nav-link[data-view=record]',title:'Запись не прерывается',text:'Переходите в другие разделы — запись продолжится, а рядом появится плавающая панель с паузой и остановкой. Её можно перетащить.'},
 {view:'library',target:'.library-toolbar',title:'Библиотека',text:'Все записи здесь: поиск по названию и тексту, плитки или список. «Выбрать» — чтобы расшифровать, переименовать по смыслу или выгрузить сразу несколько.'},
 {view:'settings',target:'#groq-settings-card',title:'Расшифровка через Groq',text:'Подключите бесплатный ключ — пошаговая инструкция прямо здесь. Перед каждой отправкой звука MONO спросит разрешение.'},
 {view:'settings',target:'#settings-index',title:'Настройки под вас',text:'Тема и цвет, поведение записи, работа в фоне, библиотека. Нажмите раздел слева — MONO подсветит его.'},
 {title:'Всё готово',text:'Тур можно пройти снова: Настройки → О MONO → «Показать тур». С любовью, для Иры.',art:'heart'}
]);

export function runTour({steps=TOUR_STEPS,go=()=>{},onDone=()=>{},reduceMotion=()=>false}={}){
 let index=0,closed=false;const previousFocus=document.activeElement;
 const root=document.createElement('div');root.className='tour';root.setAttribute('role','dialog');root.setAttribute('aria-modal','true');root.setAttribute('aria-labelledby','tour-title');
 root.innerHTML=`<div class="tour-veil"></div><div class="tour-ring" aria-hidden="true"></div><section class="tour-card glass"><div class="tour-art" aria-hidden="true"></div><div class="tour-progress" aria-hidden="true"></div><h2 id="tour-title"></h2><p class="tour-text"></p><div class="tour-actions"><button type="button" class="btn-plain tour-skip">Пропустить</button><span class="tour-spacer"></span><button type="button" class="btn btn-outline btn-small tour-back">Назад</button><button type="button" class="btn btn-primary btn-small tour-next">Далее</button></div></section>`;
 document.body.append(root);
 const card=root.querySelector('.tour-card'),ring=root.querySelector('.tour-ring'),veil=root.querySelector('.tour-veil'),title=root.querySelector('#tour-title'),text=root.querySelector('.tour-text'),art=root.querySelector('.tour-art'),progress=root.querySelector('.tour-progress'),back=root.querySelector('.tour-back'),next=root.querySelector('.tour-next');
 progress.innerHTML=steps.map(()=>'<i></i>').join('');
 const place=()=>{
  const step=steps[index],target=step.target&&document.querySelector(step.target);
  if(!target||!target.getClientRects().length){root.classList.remove('has-target');ring.style.cssText='';card.style.cssText='';veil.style.removeProperty('--hole');return}
  const box=target.getBoundingClientRect(),pad=10,r={x:box.left-pad,y:box.top-pad,w:box.width+pad*2,h:box.height+pad*2};
  root.classList.add('has-target');ring.style.cssText=`left:${r.x}px;top:${r.y}px;width:${r.w}px;height:${r.h}px`;
  veil.style.setProperty('--hole',`${r.x}px ${r.y}px ${r.w}px ${r.h}px`);veil.style.clipPath=`polygon(evenodd,0 0,100% 0,100% 100%,0 100%,0 0,${r.x}px ${r.y}px,${r.x}px ${r.y+r.h}px,${r.x+r.w}px ${r.y+r.h}px,${r.x+r.w}px ${r.y}px,${r.x}px ${r.y}px)`;
  const cw=Math.min(380,innerWidth-32),below=r.y+r.h+16,above=r.y-16;let top=below+220<innerHeight?below:Math.max(16,above-230),left=Math.min(Math.max(16,r.x),innerWidth-cw-16);
  if(r.h>innerHeight*.55){top=Math.max(16,Math.min(innerHeight-260,r.y+24));left=r.x+r.w+16+cw<innerWidth?r.x+r.w+16:Math.max(16,r.x-cw-16)}
  card.style.cssText=`left:${left}px;top:${top}px;width:${cw}px`;
 };
 const render=()=>{
  const step=steps[index];if(step.view)go(step.view);
  card.classList.remove('is-in');void card.offsetWidth;card.classList.add('is-in');
  title.textContent=step.title;text.textContent=step.text;art.dataset.art=step.art||'';art.hidden=!step.art;
  [...progress.children].forEach((dot,i)=>dot.classList.toggle('on',i<=index));
  back.hidden=index===0;next.textContent=index===steps.length-1?'Начать работу':'Далее';
  const settle=()=>{const target=step.target&&document.querySelector(step.target);if(target)target.scrollIntoView({block:'center',behavior:reduceMotion()?'auto':'smooth'});setTimeout(place,reduceMotion()?0:380)};
  requestAnimationFrame(()=>requestAnimationFrame(settle));next.focus({preventScroll:true});
 };
 const close=()=>{if(closed)return;closed=true;removeEventListener('resize',place);removeEventListener('keydown',keys,true);root.classList.add('is-leaving');setTimeout(()=>root.remove(),reduceMotion()?0:260);previousFocus?.focus?.({preventScroll:true});onDone()};
 const keys=event=>{if(event.key==='Escape'){event.preventDefault();close()}else if(event.key==='ArrowRight'||event.key==='Enter'&&event.target===document.body){event.preventDefault();forward()}else if(event.key==='ArrowLeft'){event.preventDefault();if(index>0){index--;render()}}};
 const forward=()=>{if(index>=steps.length-1){close();return}index++;render()};
 next.onclick=forward;back.onclick=()=>{if(index>0){index--;render()}};root.querySelector('.tour-skip').onclick=close;
 addEventListener('resize',place);addEventListener('keydown',keys,true);render();
 return {close,get index(){return index}};
}
