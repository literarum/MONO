// Settings navigation in the manner of macOS System Settings: the index on the left chooses one pane;
// the pane changes with a short cross-fade. Search looks through every setting — titles, hints,
// options and plain-word synonyms — tolerates a typo, and opens the pane with the found row
// centred in the window and softly lit.

/** Words people use for a setting that its own text does not contain. */
export const SYNONYMS=Object.freeze({
 'тема':'тёмная светлая ночная дневная оформление внешний вид dark light',
 'акцент':'цвет акцента синий фиолетовый розовый оранжевый зелёный бирюзовый',
 'стекло':'прозрачность размытие blur glass',
 'анимации':'движение плавность motion эффекты',
 'размер текста':'шрифт крупнее масштаб zoom увеличить',
 'groq':'ключ api апи токен расшифровка распознавание gsk подключить оплата биллинг',
 'расходы':'курс доллар рубль деньги стоимость цена usd rub',
 'распознавание':'термины имена подсказка словарь whisper язык',
 'обработка':'улучшить звук шум гул фильтр профиль',
 'источники':'микрофон звук компьютера устройство вход выход наушники колонки приложение программа zoom телеграм браузер',
 'запись':'отсчёт таймер название проверка звука тишина перегрузка горячая клавиша',
 'в фоне':'закрыть окно фон сон спящий режим уведомления сигнал',
 'библиотека':'плитки список сортировка вид сомнительные',
 'архив':'папка резервная копия экспорт импорт перенос диск',
 'обновление':'версия обновить monoupdate',
 'страховка':'страховочная дорожка копия резерв',
 'проверка':'диагностика ограничения ошибки неисправность',
 'справка':'помощь инструкция как пользоваться',
 'о mono':'версия тур обучение сброс напоминания'
});
export const normalise=text=>String(text||'').toLowerCase().replace(/ё/g,'е').replace(/[«»"'.,:;!?()\-–—·/]+/g,' ').replace(/\s+/g,' ').trim();

function distance(a,b){if(Math.abs(a.length-b.length)>1)return 2;let prev=Array.from({length:b.length+1},(_,i)=>i);for(let i=1;i<=a.length;i++){const row=[i];for(let j=1;j<=b.length;j++)row[j]=Math.min(prev[j]+1,row[j-1]+1,prev[j-1]+(a[i-1]===b[j-1]?0:1));prev=row}return prev[b.length]}

/** Score one entry for a query: every query word must match a word (prefix, inside, or one typo). */
export function score(entry,query){
 const words=normalise(query).split(' ').filter(Boolean);if(!words.length)return 0;
 const title=normalise(entry.title),hay=normalise([entry.title,entry.hint,entry.section,entry.extra].join(' ')),tokens=hay.split(' ');
 let total=0,titleHits=0;
 for(const word of words){
  let best=0;
  if(title.startsWith(word))best=6;else if(title.split(' ').some(token=>token.startsWith(word)))best=5;
  else if(tokens.some(token=>token.startsWith(word)))best=3;else if(hay.includes(word))best=2;
  else if(word.length>=4&&tokens.some(token=>token.length>=4&&(distance(token.slice(0,word.length),word)<=1||distance(token,word)<=1)))best=1;
  if(!best)return 0;total+=best;if(best>=5)titleHits++;
 }
 return total+(entry.kind==='section'&&titleHits===words.length?1:0);
}
export function search(entries,query,limit=8){return entries.map(entry=>({entry,score:score(entry,query)})).filter(item=>item.score>0).sort((a,b)=>b.score-a.score).slice(0,limit).map(item=>item.entry)}

/** Smooth scroll of a container so that `target` sits in the middle of the visible area. */
export function scrollToCentre(container,target,{duration=480,reduce=false,raf=globalThis.requestAnimationFrame,now=()=>performance.now()}={}){
 const box=target.getBoundingClientRect(),frame=container.getBoundingClientRect();
 const goal=Math.max(0,Math.min(container.scrollHeight-container.clientHeight,container.scrollTop+(box.top-frame.top)-(container.clientHeight-Math.min(box.height,container.clientHeight))/2));
 if(reduce||!raf){container.scrollTop=goal;return Promise.resolve()}
 const from=container.scrollTop,delta=goal-from,start=now(),ease=t=>t<.5?4*t*t*t:1-Math.pow(-2*t+2,3)/2;
 return new Promise(resolve=>{const step=()=>{const t=Math.min(1,(now()-start)/duration);container.scrollTop=from+delta*ease(t);t<1?raf(step):resolve()};raf(step)});
}

/** Everything that can be found: each card (a section) and each row inside it. */
export function collectEntries(grid){
 const entries=[];
 for(const card of grid.querySelectorAll(':scope>.settings-card')){
  if(card.hidden)continue;const section=card.querySelector(':scope>h2')?.textContent.trim()||'';if(!section)continue;
  const key=Object.keys(SYNONYMS).find(name=>normalise(section).includes(name)||name.includes(normalise(section)));
  entries.push({kind:'section',card,el:card,title:section,hint:card.querySelector(':scope>p')?.textContent||'',section:'',extra:key?SYNONYMS[key]:''});
  for(const row of card.querySelectorAll('.set-row,.source-field,.set-field,.guide-step,details>summary,.credential-state,.usage-tile')){
   const title=(row.querySelector('.set-row-title,.field-label,strong,label')||row).textContent.trim().replace(/\s+/g,' ').slice(0,90);if(!title)continue;
   const hint=row.querySelector('.set-row-hint,.usage-sub,p,.credential-detail')?.textContent||'';
   const options=[...row.querySelectorAll('option,button[data-value]')].map(node=>node.textContent||node.getAttribute('aria-label')||'').join(' ');
   entries.push({kind:'row',card,el:row.matches('summary')?row.parentElement:row,title,hint,section,extra:options+' '+(key?SYNONYMS[key]:'')});
  }
 }
 return entries;
}
