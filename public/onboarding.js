import {nextSetupStep} from './onboarding-model.js';
import {CredentialsClient,mountCredentials} from './credentials.js';
import {mountCaptureSources} from './native-sources.js';
import {captureActive} from './native-capture.js';
import {openLayer} from './ui/layers.js';

/** Short, resumable setup. No microphone or provider request without a click. */
export async function openOnboarding({library,storage,configure,choose,ensureNative,onArchive,onComplete=()=>{},onError=()=>{},helpTemplate,initialStep=null,canPlay=()=>true,playAudio=audio=>audio.play()}){
 const preferences=await library.json('/preferences'),keys=new CredentialsClient(library);let key=await keys.status(),progress=preferences.onboarding;
 let step=initialStep==='sound'&&storage().libraryAvailable?'sound':nextSetupStep({library:storage(),key,progress});if(!step)return null;
 const root=document.createElement('div');root.className='setup-backdrop';root.innerHTML='<section class="setup-panel glass" role="dialog" aria-modal="true" aria-labelledby="setup-title" tabindex="-1"><div class="setup-top"><span class="small-label setup-step"></span><button type="button" class="icon-btn setup-close" aria-label="Продолжить позже">×</button></div><h2 id="setup-title"></h2><p class="setup-intro"></p><div class="setup-body"></div><p class="field-hint setup-message" role="status" aria-live="polite"></p><div class="setup-actions"></div></section>';
 document.body.append(root);const panel=root.firstElementChild,title=root.querySelector('h2'),intro=root.querySelector('.setup-intro'),body=root.querySelector('.setup-body'),actions=root.querySelector('.setup-actions'),message=root.querySelector('.setup-message');
 let form=null,sourceView=null,unsubscribe=null,picker=null,testId=null,closed=false,preparingAudio=false,soundController=null;
 const cleanup=()=>{form?.destroy();form=null;sourceView?.destroy();sourceView=null;unsubscribe?.();unsubscribe=null;body.querySelectorAll('audio').forEach(audio=>{audio.pause();audio.removeAttribute('src');audio.load()})};
 const layer=openLayer({element:panel,modal:true,background:document.querySelector('.app-shell'),onClose:()=>{closed=true;picker?.abort();if(testId&&captureActive(soundController?.snapshot))void soundController.stop().catch(onError);if(testId){const id=testId;setTimeout(()=>void soundController?.client?.discardTest(id).then(()=>onArchive()).catch(()=>{}),captureActive(soundController?.snapshot)?6000:0)}cleanup();root.remove();void onComplete()}});
 const stateDisabled=(button,value)=>{button.dataset.stateDisabled=String(value);button.disabled=value};
 const button=(label,action,primary=false)=>{const b=document.createElement('button');b.type='button';b.className='btn '+(primary?'btn-primary':'btn-outline');b.textContent=label;b.onclick=async()=>{if(b.disabled)return;const controls=[...actions.querySelectorAll('button')],disabled=controls.map(control=>control.disabled);controls.forEach(control=>control.disabled=true);message.textContent='';try{await action()}catch(error){message.textContent=error.message;onError(error)}finally{controls.forEach((control,i)=>{if(control.isConnected)control.disabled=control.dataset.stateDisabled==='true'||disabled[i]})}};actions.append(b);return b};
 const save=async patch=>{const result=await library.json('/preferences',{method:'PATCH',body:{onboarding:patch}});progress=result.onboarding};
 const discard=async()=>{if(testId){const {controller}=await ensureNative();if(captureActive(controller.snapshot)&&controller.snapshot.recordId===testId)throw new Error('Дождитесь завершения проверки звука.');await controller.client.discardTest(testId);testId=null;await onArchive()}};
 const finish=async tested=>{await discard();await save({completed:true,soundTested:tested});layer.close('complete')};
 const next=async()=>{key=await keys.status();step=nextSetupStep({library:storage(),key,progress});await render()};
 // The folder step is done once the archive is configured. The capture module starts in the background
 // (its first launch on Windows can take many seconds) and is awaited only by the sound step.
 const archiveReady=async()=>{await onArchive();if(closed)return;void ensureNative().catch(()=>{});await next()};
 async function render(){
  cleanup();body.replaceChildren();actions.replaceChildren();message.textContent='';root.querySelector('.setup-step').textContent={folder:'1 из 3 · МЕСТО ДЛЯ ЗАПИСЕЙ',reconnect:'ПОДКЛЮЧЕНИЕ АРХИВА',key:'2 из 3 · РАСШИФРОВКА',sound:'3 из 3 · ВАШ ЗВУК'}[step]||'';
  if(step==='folder'||step==='reconnect'){
   title.textContent=step==='folder'?'Добро пожаловать в MONO':'Подключите ваш архив';intro.textContent=step==='folder'?'Записывайте встречи и превращайте разговоры в текст. Для начала выберите, где хранить аудио и расшифровки.':'Папка с записями сейчас недоступна. Подключите диск или выберите прежнюю папку.';
   const detail=document.createElement('p');detail.className='field-hint';detail.textContent=step==='folder'?'Файлы остаются на вашем компьютере. Если закрыть это окно, записи будут сохраняться в «Документы» — папку можно сменить в настройках.':'Файлы остаются на вашем компьютере. Папку можно перенести в настройках.';body.append(detail);
   const chooseButton=button('Выбрать папку',async()=>{picker=new AbortController();message.textContent='Выберите папку в системном окне…';try{const choice=await choose(step==='reconnect'?'open':'create',{signal:picker.signal});if(choice.cancelled||closed){message.textContent='Выбор отменён.';return}await configure({choiceId:choice.choiceId});await archiveReady()}finally{picker=null}},step==='reconnect');
   if(step==='folder')button('Использовать «Документы»',async()=>{chooseButton.disabled=true;try{await configure({useDefault:true});await archiveReady()}finally{chooseButton.disabled=false}},true);
  }else if(step==='key'){
   title.textContent='Разговор становится текстом';intro.textContent='Подключите свой аккаунт Groq для расшифровки. Записывать и слушать можно без него.';
   const formHost=document.createElement('div');body.append(formHost);form=mountCredentials(formHost,{client:keys,onChange:value=>{key=value;continueButton.hidden=!value.configured}});
   if(helpTemplate)body.append(helpTemplate.cloneNode(true));
   const continueButton=button('Продолжить',next,true);continueButton.hidden=!key.configured;
   button('Подключить позже',async()=>{await save({keySkipped:true});await next()});
  }else if(step==='sound'){
   title.textContent='Проверим звук';intro.textContent='Выберите источник и запишите пять секунд.';
   message.textContent='Запускаем модуль записи…';let native=null,failure=null;
   // First launch on Windows can take a while (self-extracting helper, antivirus scan): be patient, retry quietly.
   for(let attempt=0;attempt<6&&!closed;attempt++){try{native=await ensureNative();break}catch(error){failure=error;await new Promise(r=>setTimeout(r,2500))}}
   if(closed)return;if(!native)throw failure||new Error('Модуль записи не запустился. Нажмите «Пропустить» и повторите проверку позже в настройках.');
   message.textContent='';const {controller,sources}=native;soundController=controller;const sourceHost=document.createElement('div');body.append(sourceHost);sourceView=mountCaptureSources(sourceHost,{model:sources,onError});const meter=document.createElement('div');meter.className='setup-meter';meter.hidden=true;meter.innerHTML='<span class="small-label">УРОВЕНЬ</span><div class="level-track"><div class="setup-meter-fill"></div></div><span class="setup-meter-hint">Говорите — шкала должна двигаться</span>';body.append(meter);const meterFill=meter.querySelector('.setup-meter-fill'),meterHint=meter.querySelector('.setup-meter-hint');let heard=false;
   const audition=document.createElement('div');audition.className='setup-audition';audition.hidden=true;const audio=document.createElement('audio');audio.preload='metadata';const play=document.createElement('button');play.className='btn btn-outline btn-small';play.type='button';play.textContent='Прослушать проверку';const seek=document.createElement('input');seek.className='seek';seek.type='range';seek.min='0';seek.max='1000';seek.value='0';seek.setAttribute('aria-label','Позиция проверки звука');audition.append(play,seek,audio);body.append(audition);
   play.onclick=async()=>{if(captureActive(controller.snapshot))return;if(!audio.paused){audio.pause();return}if(!canPlay())return;try{await playAudio(audio)}catch(error){if(error.name!=='AbortError')message.textContent=error.message||'Не удалось воспроизвести проверку. Повторите её или проверьте устройство вывода.'}};audio.onplay=()=>{if(!canPlay()){audio.pause();return}play.textContent='Приостановить'};audio.onpause=()=>play.textContent='Прослушать проверку';audio.ontimeupdate=()=>seek.value=String(audio.duration?Math.round(1000*audio.currentTime/audio.duration):0);seek.oninput=()=>{if(Number.isFinite(audio.duration))audio.currentTime=audio.duration*Number(seek.value)/1000};
   const testButton=button('Записать 5 секунд',async()=>{await discard();audition.hidden=true;confirm.hidden=true;const result=await controller.start(await sources.selection(),{test:true});testId=result.recordId;message.textContent='Идёт проверка. Скажите несколько слов или включите звук встречи.'},true);
   const confirm=button('Слышу звук — начать',()=>finish(true),true);confirm.hidden=true;
   const skip=button('Проверить позже',()=>finish(false));
   unsubscribe=controller.subscribe(async value=>{
    // Live level during the five-second test: the person sees the microphone react.
    const testing=Boolean(testId&&value.recordId===testId&&captureActive(value));meter.hidden=!testing&&!heard;
    if(testing){const rms=Math.max(0,...Object.values(value.levels||{}).map(level=>Number(level?.rms)||0)),db=rms>0?20*Math.log10(rms):-90;meterFill.style.width=Math.max(0,Math.min(100,(db+65)/65*100))+'%';if(db>-45){heard=true;meterHint.textContent='Звук есть ✓'}}

    const active=captureActive(value);stateDisabled(testButton,active||!value.connected);stateDisabled(skip,active);root.querySelector('.setup-close').disabled=active;
    if(!testId||value.recordId!==testId||active||preparingAudio)return;
    if(value.state!=='ready'){message.textContent='Проверка не завершена. Проверьте источник и повторите попытку.';return}
    if(audio.src)return;preparingAudio=true;message.textContent='Готовим запись для прослушивания…';
    try{const record=await library.get(testId);if(record.status!=='saved'||!record.size)throw new Error('В проверке нет сохранённого звука. Повторите запись.');const response=await library.request('/records/'+testId+'/audio',{method:'HEAD'});if(!response.ok)throw new Error('Проверка пока недоступна.');if(closed)return;audio.src=library.audioURL(testId);audition.hidden=false;confirm.hidden=false;testButton.className='btn btn-outline';testButton.textContent='Записать ещё раз';message.textContent='Прослушайте запись. Если слышно всё нужное, можно начинать.'}catch(error){message.textContent=error.message}finally{preparingAudio=false}
   });
  }
  if(!closed)title.focus({preventScroll:true});
 }
 title.tabIndex=-1;root.querySelector('.setup-close').onclick=()=>layer.close('later');await render();if(!closed)panel.focus();return {get closed(){return closed},close:()=>layer.close('later')};
}
