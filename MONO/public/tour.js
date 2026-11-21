// Tours of MONO. A step can point at a real part of the window: a soft spotlight cuts it out of a
// dimmed glass veil and a card explains it in plain words. Moving to another section never jumps:
// the card fades out, the veil closes into a haze, the section changes and scrolls underneath, then
// the haze opens on the new spotlight. Arrows, Enter and Esc work; «Назад», «Далее», «Пропустить»
// are always there.
//
// TOUR_STEPS is the short tour (a minute); FULL_TOUR_STEPS walks through every section, button and
// mechanism. Steps with `pane` open that settings pane first; `editor` steps open a record.
const END_HINT='Пройти тур ещё раз можно в Настройках → «О MONO». Там же — подробный тур по каждой функции и кнопке.';
export const TOUR_STEPS=Object.freeze([
 {title:'Добро пожаловать в MONO',text:'MONO записывает разговоры и превращает их в текст с таймкодами. Покажем главное — это займёт минуту.',art:'wave'},
 {view:'dashboard',target:'#hero-import',title:'Готовая запись → текст',text:'Перетащите сюда аудио или видео любой длины — или нажмите, чтобы выбрать файл. Звук из видео MONO извлечёт сам.'},
 {view:'record',target:'#start-record',title:'Запись встречи',text:'Нажмите «Начать запись». На паузе появятся «Продолжить запись» и «Создать новую запись».'},
 {view:'record',target:'.studio-side',title:'Что записывать',text:'Микрофон, звук компьютера, всё вместе или одно приложение. MONO сам проверяет звук и подсказывает, если что-то мешает.'},
 {view:'record',target:'.nav-link[data-view=record]',title:'Запись не прерывается',text:'Переходите в другие разделы — запись продолжится, а рядом появится плавающая панель с паузой и остановкой.'},
 {view:'library',target:'.library-toolbar',title:'Библиотека',text:'Поиск по названию и тексту, плитки или список. «Выбрать» — чтобы расшифровать, переименовать по смыслу или выгрузить сразу несколько.'},
 {view:'settings',pane:'groq-settings-card',target:'#groq-settings-card',title:'Расшифровка через Groq',text:'Подключите бесплатный ключ — пошаговая инструкция прямо здесь. Перед каждой отправкой звука MONO спросит разрешение.'},
 {view:'settings',target:'#settings-index',title:'Настройки под вас',text:'Разделы слева, поиск сверху. Найдите любую настройку словом — например, «тема» или «микрофон».'},
 {title:'Всё готово',text:END_HINT,art:'done',final:true}
]);
const S=(view,target,title,text,extra={})=>({view,target,title,text,...extra});
export const FULL_TOUR_STEPS=Object.freeze([
 {title:'Подробный тур по MONO',text:'Пройдём по каждому разделу, кнопке и механизму. Можно в любой момент остановиться — Esc или «Пропустить».',art:'wave'},
 // Overview
 S('dashboard','#sidebar','Боковое меню','Пять разделов: Обзор, Библиотека, Расшифровка, Запись и Настройки. Во время записи у «Записи» пульсирует красная точка, на паузе — оранжевая пауза.'),
 S('dashboard','#hero-import','Загрузка файла','Перетащите аудио или видео (MP3, WAV, M4A, MP4, MOV, MKV и другие) или нажмите. Видео любой длины: MONO сам извлечёт звук.'),
 S('dashboard','#view-dashboard .hero-actions','Быстрая запись','«Записать» сразу открывает студию записи.'),
 S('dashboard','#recent-list','Последние записи','Пять последних записей. Нажмите, чтобы открыть; «Вся библиотека» — все записи.'),
 S('dashboard','#view-dashboard .metrics-grid','Сводка','Сколько записей, их общая длина, сколько расшифровано за месяц и примерная стоимость в рублях.'),
 // Record
 S('record','#studio-guide','Подсказка перед началом','Пять секунд проверки звука. После нажатия «Проверить звук» подсказка закрывается; проверять перед каждой записью можно включить в Настройках.'),
 S('record','#record-timer','Таймер','Сколько уже записано. На паузе таймер мягко пульсирует.'),
 S('record','#level-check','Проверить уровень','Покажет громкость микрофона без записи. Нажмите ещё раз, чтобы остановить; сама проверка длится ограниченное время.'),
 S('record','#start-record','Начать запись','Начинает запись. Если папка для записей ещё не выбрана, MONO предложит её выбрать и сразу продолжит.'),
 S('record','.studio-buttons','Во время записи','«Пауза», «★ Важно» (отметить момент, клавиша B) и «Завершить». На паузе — «Продолжить запись» и «Создать новую запись»: текущая сохранится в библиотеке.'),
 S('record','.studio-side','Источник звука','Микрофон, звук компьютера, микрофон вместе со звуком компьютера или звук одного приложения (например, Zoom). Ниже — какие устройства сейчас используются.'),
 S('record','.studio-side .preflight','Проверка систем','MONO постоянно проверяет микрофон, диск, Groq и модуль записи. Нажмите на ограничение — откроется место, где его исправить, с подсказкой.'),
 S('record','#record-import','Загрузить готовый файл','Тоже импорт — прямо из студии.'),
 S('record','.nav-link[data-view=record]','Запись в фоне','Уходите в другие разделы или сворачивайте окно — запись продолжается. Плавающую панель можно перетаскивать и поднять «поверх всех окон».'),
 // Library
 S('library','#library-search','Поиск','Ищет по названиям и по тексту расшифровок. Ctrl+F — сразу сюда.'),
 S('library','#library-filter','Фильтр','Все записи, только с текстом, без текста или корзина.'),
 S('library','#library-sort','Порядок','Новые, старые, длинные или по названию. Порядок по умолчанию задаётся в Настройках.'),
 S('library','.view-toggle','Плитки или список','Переключите вид карточек.'),
 S('library','#library-select-mode','Выбор нескольких','Отметьте записи — появятся «Расшифровать», «Умно переименовать» (по содержанию), «Экспорт» (аудио и текст в папку) и «Удалить».'),
 S('library','#library-list','Карточка записи','Карандаш — переименовать, корзина — удалить (MONO переспросит, запись можно вернуть из корзины), «Открыть» — текст и плеер.'),
 S('library','#library-import','Добавить файл','Импорт аудио или видео в библиотеку.'),
 // Editor
 S('editor','.back-link','Назад','Возврат в библиотеку. MONO запомнит место: после перезапуска откроется та же запись.',{needsRecord:true}),
 S('editor','.editor-sidebar','Сведения о записи','Дата, длительность, число фрагментов и состояние. Здесь же «Расшифровать» и «Скачать аудио».',{needsRecord:true}),
 S('editor','#editor-search','Поиск по тексту','Находит слова в расшифровке и прыгает к ним.',{needsRecord:true}),
 S('editor','#audio-tools','Умная обработка звука','«Авто» измеряет запись: гул сети, перегрузку, шум, тихий голос — и исправляет только найденное. Сравните «Оригинал» и «После обработки» на одинаковой громкости.',{needsRecord:true}),
 S('editor','#audio-player','Плеер','Волна показывает громкость и характер звука. Пробел — пауза, Alt+← / → — на 5 секунд, «1×» — скорость. Play в конце начинает заново.',{needsRecord:true}),
 S('editor','#editor-content','Текст','Щёлкните время у абзаца — запись начнёт играть с этого места. Сомнительные слова подсвечены; текст можно править.',{needsRecord:true}),
 // Jobs
 S('jobs','#jobs-list','Расшифровка','Очередь: что сейчас расшифровывается, сколько осталось и сколько стоит. Можно отменить или повторить.'),
 // Settings
 S('settings','#settings-index','Разделы настроек','Каждый раздел открывается целиком. Поиск сверху понимает слова попроще: «тема», «ключ», «курс».'),
 {view:'settings',pane:'groq-settings-card',target:'#groq-settings-card',title:'Groq',text:'Состояние ключа, «Заменить ключ», «Отключить», расходы в рублях (сейчас и за всё время), пошаговая инструкция и условия Groq.'},
 {view:'settings',pane:'set-расходы',target:'#set-расходы',title:'Расходы',text:'Курс доллара обновляется сам раз в 6 часов по данным Банка России. Если ввести свой — автообновление выключится.'},
 {view:'settings',pane:'set-распознавание',target:'#set-распознавание',title:'Распознавание',text:'Подскажите модели редкие слова и имена — так они будут записаны правильно.'},
 {view:'settings',pane:'set-обработка-аудио',target:'#set-обработка-аудио',title:'Обработка аудио',text:'Профиль, который применяется перед расшифровкой. Оригинал не меняется никогда.'},
 {view:'settings',pane:'set-источники-записи',target:'#set-источники-записи',title:'Источники записи',text:'Что записывать и с каких устройств; «Проверить звук» — пятисекундная проба.'},
 {view:'settings',pane:'set-запись',target:'#set-запись',title:'Запись',text:'Проверка звука перед каждой записью, обратный отсчёт (в том числе свой), предупреждения о тишине и перегрузке, плавающая панель, название новых записей, горячая клавиша Ctrl+Alt+R.'},
 {view:'settings',pane:'set-оформление',target:'#set-оформление',title:'Оформление',text:'Окно во весь экран, тема (по умолчанию — как в Windows), цвет акцента, стекло, анимации и размер текста.'},
 {view:'settings',pane:'set-библиотека',target:'#set-библиотека',title:'Библиотека',text:'Вид карточек, порядок, подсветка сомнительных слов и длительность уведомлений.'},
 {view:'settings',pane:'set-работа-в-фоне',target:'#set-работа-в-фоне',title:'Работа в фоне',text:'Что делать после закрытия окна: завершать сразу или чуть позже, доделывать расшифровку, не давать компьютеру уснуть, сигнал и уведомление Windows о готовом тексте.'},
 {view:'settings',pane:'set-архив-и-резервные-копии',target:'#set-архив-и-резервные-копии',title:'Архив',text:'Папка с записями, экспорт и импорт, подключение другой папки и перенос архива.'},
 {view:'settings',pane:'update-card',target:'#update-card',title:'Обновление',text:'Новая версия ставится из файла .monoupdate — интернет не нужен; подпись проверяется.'},
 {view:'settings',pane:'set-предполётная-проверка',target:'#set-предполётная-проверка',title:'Проверка',text:'Все системы MONO; «Глубокая диагностика» проверяет микрофон и звук по шагам и называет причину.'},
 {view:'settings',pane:'about-card',target:'#about-card',title:'О MONO',text:'Версия, туры, напоминания о Groq и сброс настроек.'},
 {title:'Вот и всё',text:'Теперь вы знаете MONO целиком. '+END_HINT.replace('. Там же — подробный тур по каждой функции и кнопке.',''),art:'done',final:true}
]);

export function runTour({steps=TOUR_STEPS,go=()=>{},pane=()=>{},hasRecord=()=>true,onDone=()=>{},reduceMotion=()=>false,offerFull=null}={}){
 const list=steps.filter(step=>!step.needsRecord||hasRecord());
 let index=0,closed=false,busy=false,currentView=null;const previousFocus=document.activeElement;
 const root=document.createElement('div');root.className='tour';root.setAttribute('role','dialog');root.setAttribute('aria-modal','true');root.setAttribute('aria-labelledby','tour-title');
 root.innerHTML=`<div class="tour-veil"></div><div class="tour-ring" aria-hidden="true"></div><section class="tour-card glass"><div class="tour-art" aria-hidden="true"></div><div class="tour-progress" aria-hidden="true"></div><p class="tour-count"></p><h2 id="tour-title"></h2><p class="tour-text"></p><div class="tour-actions"><button type="button" class="btn-plain tour-skip">Пропустить</button><span class="tour-spacer"></span><button type="button" class="btn btn-outline btn-small tour-back">Назад</button><button type="button" class="btn btn-primary btn-small tour-next">Далее</button></div></section>`;
 document.body.append(root);
 const card=root.querySelector('.tour-card'),ring=root.querySelector('.tour-ring'),veil=root.querySelector('.tour-veil'),title=root.querySelector('#tour-title'),text=root.querySelector('.tour-text'),art=root.querySelector('.tour-art'),progress=root.querySelector('.tour-progress'),count=root.querySelector('.tour-count'),back=root.querySelector('.tour-back'),next=root.querySelector('.tour-next'),actions=root.querySelector('.tour-actions');
 const many=list.length>12;progress.innerHTML=many?'<i class="tour-bar"><b></b></i>':list.map(()=>'<i></i>').join('');
 const wait=ms=>new Promise(r=>setTimeout(r,reduceMotion()?0:ms));
 const holeFor=target=>{if(!target||!target.getClientRects().length)return null;const box=target.getBoundingClientRect(),pad=10;return {x:box.left-pad,y:box.top-pad,w:box.width+pad*2,h:box.height+pad*2}};
 const place=r=>{
  if(!r){root.classList.remove('has-target');veil.style.clipPath='';ring.style.opacity='0';card.style.cssText='';return}
  root.classList.add('has-target');ring.style.cssText=`left:${r.x}px;top:${r.y}px;width:${r.w}px;height:${r.h}px`;
  veil.style.clipPath=`polygon(evenodd,0 0,100% 0,100% 100%,0 100%,0 0,${r.x}px ${r.y}px,${r.x}px ${r.y+r.h}px,${r.x+r.w}px ${r.y+r.h}px,${r.x+r.w}px ${r.y}px,${r.x}px ${r.y}px)`;
  const cw=Math.min(380,innerWidth-32),ch=card.offsetHeight||240;let top=r.y+r.h+16,left=Math.min(Math.max(16,r.x),innerWidth-cw-16);
  if(top+ch>innerHeight-16)top=r.y-16-ch;if(top<16){top=Math.max(16,Math.min(innerHeight-ch-16,r.y+24));left=r.x+r.w+16+cw<innerWidth?r.x+r.w+16:Math.max(16,r.x-cw-16)}
  card.style.cssText=`left:${left}px;top:${top}px;width:${cw}px`;
 };
 const text_=step=>{title.textContent=step.title;text.textContent=step.text;art.dataset.art=step.art||'';art.hidden=!step.art;count.textContent=`${index+1} из ${list.length}`;
  if(many)progress.querySelector('b').style.width=`${(index+1)/list.length*100}%`;else[...progress.children].forEach((dot,i)=>dot.classList.toggle('on',i<=index));
  back.hidden=index===0;next.textContent=step.final?'Готово':'Далее';actions.querySelector('.tour-full')?.remove();
  if(step.final&&offerFull){const full=document.createElement('button');full.type='button';full.className='btn btn-outline btn-small tour-full';full.textContent='Подробный тур';full.onclick=()=>{close();offerFull()};next.before(full)}};
 const render=async()=>{
  if(busy)return;busy=true;const step=list[index];
  const switching=(step.view&&step.view!==currentView)||step.pane;
  card.classList.add('is-out');ring.style.opacity='0';
  if(switching){root.classList.add('is-hazy');await wait(220);if(step.view&&step.view!==currentView){go(step.view);currentView=step.view}if(step.pane)pane(step.pane);await wait(260)}else await wait(160);
  const target=step.target&&document.querySelector(step.target);
  if(target)target.scrollIntoView({block:'center',behavior:'auto'});
  await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));
  text_(step);place(holeFor(target));
  root.classList.remove('is-hazy');card.classList.remove('is-out');void card.offsetWidth;card.classList.add('is-in');ring.style.opacity='';
  next.focus({preventScroll:true});busy=false;
 };
 const close=()=>{if(closed)return;closed=true;removeEventListener('resize',onResize);removeEventListener('keydown',keys,true);root.classList.add('is-leaving');setTimeout(()=>root.remove(),reduceMotion()?0:300);previousFocus?.focus?.({preventScroll:true});onDone({finished:index>=list.length-1})};
 const onResize=()=>place(holeFor(list[index].target&&document.querySelector(list[index].target)));
 const forward=()=>{if(busy)return;if(index>=list.length-1){close();return}index++;void render()};
 const backward=()=>{if(busy||index===0)return;index--;void render()};
 const keys=event=>{if(event.key==='Escape'){event.preventDefault();close()}else if(event.key==='ArrowRight'){event.preventDefault();forward()}else if(event.key==='ArrowLeft'){event.preventDefault();backward()}};
 next.onclick=forward;back.onclick=backward;root.querySelector('.tour-skip').onclick=close;
 addEventListener('resize',onResize);addEventListener('keydown',keys,true);void render();
 return {close,get index(){return index},get length(){return list.length}};
}
