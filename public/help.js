import {GuidanceModel} from './help-model.js';
export function mountGuidance(host,{library,controller,sources,onAction=()=>{},onError=()=>{}}){
 const model=new GuidanceModel();let dismissed=null,current=null,signature='',destroyed=false,saving=false;
 host.classList.add('context-guidance');host.setAttribute('aria-live','polite');host.hidden=true;
 const render=()=>{
  if(destroyed||dismissed===null)return;current=model.update({capture:controller.snapshot,mode:sources.value.mode,dismissed});const next=JSON.stringify(current);if(next===signature)return;signature=next;host.replaceChildren();host.hidden=!current;if(!current)return;
  const title=document.createElement('h3'),text=document.createElement('p'),actions=document.createElement('div');title.textContent=current.title;text.textContent=current.text;actions.className='guidance-actions';host.append(title,text,actions);
  const displayed=current;
  if(displayed.action){const action=document.createElement('button');action.type='button';action.className='btn btn-outline btn-small';action.textContent=displayed.action==='listen'?'Открыть запись':'Проверить звук';action.onclick=()=>void Promise.resolve().then(()=>onAction(displayed.action,controller.snapshot.recordId)).catch(onError);actions.append(action)}
  const close=document.createElement('button');close.type='button';close.className='btn-plain';close.textContent='Не показывать';close.setAttribute('aria-label','Не показывать совет «'+displayed.title+'»');close.onclick=async()=>{if(saving)return;saving=true;close.disabled=true;try{const preferences=await library.json('/preferences');const result=await library.json('/preferences',{method:'PATCH',body:{dismissedHints:[...new Set([...preferences.dismissedHints,displayed.id])]}});dismissed=result.dismissedHints;render()}catch(error){onError(error)}finally{saving=false;if(close.isConnected)close.disabled=false}};actions.append(close);
 };
 const unsubscribeCapture=controller.subscribe(render),unsubscribeSources=sources.subscribe(render);
 void library.json('/preferences').then(value=>{if(!destroyed){dismissed=value.dismissedHints;render()}}).catch(onError);
 return {destroy(){destroyed=true;unsubscribeCapture();unsubscribeSources();host.replaceChildren()}};
}
export function mountHelp(host){
 host.classList.add('help-notes');host.innerHTML='<h2>Как пользоваться MONO</h2><details class="setup-details"><summary>Во время встречи</summary><p>Выберите «Микрофон и звук компьютера», подключите наушники и проверьте пять секунд звука. Запись начинается только после нажатия кнопки. Предупредите участников.</p></details><details class="setup-details"><summary>Пауза и завершение</summary><p>На паузе звук не записывается; промежуток остаётся на общей шкале времени. Нажмите «Завершить» и дождитесь подтверждения сохранения.</p></details><details class="setup-details"><summary>Готовый аудиофайл</summary><p>Добавьте файл в библиотеку и прослушайте его перед расшифровкой. Исходник сохраняется отдельно от текста и правок.</p></details><details class="setup-details"><summary>Расшифровка и конфиденциальность</summary><p>Подключение ключа не отправляет аудио. Перед отправкой в Groq вы отдельно подтверждаете запись и видите оценочную стоимость. Повторная обработка также требует подтверждения.</p></details><details class="setup-details"><summary>Архив и резервная копия</summary><p>Аудио и текст находятся в выбранной папке. Для дополнительной копии используйте экспорт библиотеки в настройках. Исходная папка сохраняется при переносе архива.</p></details>';
}
