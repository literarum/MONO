import {deviceName} from './browser-microphone.js';
/** One durable selection model shared by studio, settings and onboarding. */
export class CaptureSources{
 constructor(client,library){this.client=client;this.library=library;this.value={mode:'mic',inputId:null,outputId:null};this.capability={modes:[],inputDevices:[],outputDevices:[]};this.listeners=new Set();this.queue=Promise.resolve();this.busy=false;this.apps=[];this.appsReason=null}
 emit(){for(const fn of this.listeners)fn(this)}
 subscribe(fn){this.listeners.add(fn);fn(this);return()=>this.listeners.delete(fn)}
 async load(){this.value=(await this.library.json('/preferences')).capture;this.emit();return this.refresh()}
 /** A saved mode can be unavailable (no native helper on this OS/build). Record with the browser microphone instead of failing every start. */
 fallbackMode(mode=this.value.mode){const modes=this.capability.modes||[];return modes.length&&!modes.includes(mode)&&modes.includes('browser')?'browser':mode}
 async refresh({requestAccess=false}={}){
  if(requestAccess&&this.fallbackMode()==='browser')await this.client.requestDevices(this.value.browserInputId||null);
  this.capability=await this.client.capabilities({signal:AbortSignal.timeout(10000)});
  const mode=this.fallbackMode();
  // The fallback is effective only and never saved: a module that was briefly unavailable must not
  // pin the person to the browser channel forever (seen on a real laptop after a helper fault).
  // A chosen device that disappeared (unplugged headset): follow the system default.
  const browser=mode==='browser',list=(browser?this.capability.browserInputDevices:this.capability.inputDevices)||[],chosen=browser?this.value.browserInputId:this.value.inputId;
  if(chosen&&list.length&&list.every(device=>device.labelled!==false)&&!list.some(device=>device.id===chosen)&&!this.busy){
   try{await this.update({inputId:null});this.notice='Выбранный микрофон отключён — записываем с микрофона по умолчанию.'}catch{}
  }
  this.emit();return this.capability;
 }
 setBusy(value){if(this.busy===value)return;this.busy=value;this.emit()}
 update(patch,{quiet=false}={}){const operation=this.queue.then(async()=>{const adjusted={...patch};if((patch.mode||this.value.mode)==='browser'&&'inputId' in patch){adjusted.browserInputId=patch.inputId;delete adjusted.inputId}const changed=Object.entries(adjusted).some(([key,value])=>this.value[key]!==value);const result=await this.library.json('/preferences',{method:'PATCH',body:{capture:{...this.value,...adjusted},...(changed&&!quiet?{onboarding:{soundTested:false}}:{})}});this.value=result.capture;this.emit();return this.value});this.queue=operation.catch(()=>{});return operation}
 /** Devices the system will actually use now: names for the person, never IDs. */
 activeDevices(){
  const mode=this.fallbackMode(),browser=mode==='browser',inputs=(browser?this.capability.browserInputDevices:this.capability.inputDevices)||[],outputs=(browser?this.capability.browserOutputDevices:this.capability.outputDevices)||[];
  const chosenInput=browser?this.value.browserInputId:this.value.inputId,chosenOutput=browser?null:this.value.outputId;
  const pick=(list,id)=>list.find(device=>device.id===id)||list.find(device=>device.default)||list[0];
  const input=pick(inputs,chosenInput),output=pick(outputs,chosenOutput);
  return {input:input&&input.labelled!==false?deviceName(input):null,output:output&&output.labelled!==false?deviceName(output):null,needsPermission:browser&&inputs.length>0&&inputs.every(device=>device.labelled===false)};
 }
 async selection(){await this.queue;const value={...this.value,mode:this.fallbackMode()};
  if(value.mode==='app'){
   // A program gets a new process each time it starts: the saved name finds today's process.
   const list=await this.applications().catch(()=>[]),app=list.find(item=>item.processName===value.appName);
   return {mode:'app',inputId:null,outputId:null,processId:app?.processId??null,appName:app?.name||value.appName||null};
  }
  return {mode:value.mode,inputId:value.mode==='system'?null:value.mode==='browser'?value.browserInputId||null:value.inputId,outputId:['mic','browser'].includes(value.mode)?null:value.outputId}}
 /** Programs with a window whose sound can be recorded on its own (Windows 11 process loopback). */
 async applications(){const result=await this.library.json('/capture/applications',{signal:AbortSignal.timeout(8000)});this.apps=result.available?result.applications:[];this.appsReason=result.available?null:result.reason;return this.apps}
 /** Why a mode cannot record here, and what MONO can do about it. */
 unavailable(mode){
  const modes=this.capability.modes||[];if(modes.includes(mode)||mode==='browser'&&modes.includes('browser'))return null;
  const nativeModes=modes.filter(item=>item!=='browser');
  if(mode==='app'&&nativeModes.includes('system'))return {reason:'windows',text:'Запись звука отдельного приложения есть в Windows 11 (с версии 21H2) и Windows Server 2022'+(this.capability.windowsBuild?` — на этом компьютере сборка ${this.capability.windowsBuild}`:'')+'. Выберите «Звук компьютера»: запишется всё, что звучит в колонках или наушниках.',action:'Выбрать «Звук компьютера»',fix:{mode:'system'}};
  const windows=/Windows/i.test(globalThis.navigator?.userAgent||'');
  if(!windows)return {reason:'platform',text:'Этот режим работает в Windows: там MONO записывает звук компьютера своим модулем. Здесь доступна запись микрофона.',action:null};
  return {reason:'helper',text:'Для этого режима нужен модуль записи MonoAudio — он записывает звук прямо из Windows. MONO установит его сам: это займёт несколько минут и потребует интернет.',action:'Установить модуль',install:true};
 }
 async installHelper(onProgress=()=>{}){
  const started=await this.library.json('/capture/install_helper',{method:'POST',body:{}});
  if(!started.started){const why={PACKAGED:'Модуль входит в установленную версию MONO, но Windows его не запустила. Переустановите MONO из MONO-Setup.exe.',NOT_WINDOWS:'Модуль записи работает только в Windows.',NO_INSTALLER:'Не найден установщик MONO рядом с приложением. Запустите «Установить и запустить MONO» ещё раз.',NO_POWERSHELL:'Windows не дала запустить установку (PowerShell недоступен).'}[started.reason]||'Не удалось начать установку модуля.';throw Object.assign(new Error(why),{code:'HELPER_INSTALL_'+started.reason})}
  onProgress('Устанавливаем модуль записи — окно установки покажет, что происходит…');
  const deadline=Date.now()+30*60_000;let status;
  do{await new Promise(resolve=>setTimeout(resolve,2000));status=await this.library.json('/capture/install_status').catch(()=>({running:true}))}while(status.running&&Date.now()<deadline);
  if(status.running)throw Object.assign(new Error('Установка модуля идёт слишком долго. Проверьте окно установки.'),{code:'HELPER_INSTALL_TIMEOUT'});
  if(status.exitCode!==0)throw Object.assign(new Error('Модуль не установился. Подробности — в файле %TEMP%\\mono-install.log; можно запустить «Установить и запустить MONO» ещё раз.'),{code:'HELPER_INSTALL_FAILED'});
  await this.refresh();return this.capability;
 }
}
let serial=0;
/** Every way MONO can record, always listed; one the computer cannot do yet explains itself and offers the fix. */
export const MODES=Object.freeze([
 {id:'browser',name:'Микрофон'},
 {id:'system',name:'Звук компьютера'},
 {id:'both',name:'Звук компьютера + микрофон'},
 {id:'app',name:'Выбранное приложение'},
 {id:'mic',name:'Микрофон через модуль Windows',optional:true}
]);
export function mountCaptureSources(host,{model,onError=()=>{},onNotice=()=>{}}){
 const id='capture-source-'+(++serial);host.classList.add('capture-sources');
 host.innerHTML=`<div class="source-field"><label class="field-label" for="${id}-mode">Что записывать</label><select class="select" id="${id}-mode" data-source="mode"></select></div><div class="source-unavailable" role="status" hidden><p class="field-hint source-unavailable-text"></p><button type="button" class="btn btn-primary btn-small source-fix"></button></div><div class="source-field" data-app hidden><label class="field-label" for="${id}-app">Приложение</label><div class="source-app-row"><select class="select" id="${id}-app" data-source="appName"></select><button type="button" class="icon-btn source-apps-refresh" aria-label="Обновить список приложений" title="Обновить список приложений"><svg aria-hidden="true"><use href="#i-refresh"/></svg></button></div></div><div class="source-field" data-input><label class="field-label" for="${id}-input">Микрофон</label><select class="select" id="${id}-input" data-source="inputId"></select></div><div class="source-field" data-output><label class="field-label" for="${id}-output">Звук компьютера</label><select class="select" id="${id}-output" data-source="outputId"></select></div><div class="active-devices" role="status" aria-live="polite"><div><span class="active-devices-label">Микрофон</span><strong data-active-input>—</strong></div><div><span class="active-devices-label">Звук выводится</span><strong data-active-output>—</strong></div></div><p class="field-hint source-guidance" role="status"></p><button type="button" class="btn btn-outline btn-small source-refresh">Обновить устройства</button>`;
 const field=name=>host.querySelector(`[data-source="${name}"]`),selects=[...host.querySelectorAll('select')];let saving=false,refreshing=false,installing=null,wanted=null,appsLoading=false,appsLoaded=false;
 const options=(select,items,value,defaultLabel)=>{select.replaceChildren();if(defaultLabel)select.add(new Option(defaultLabel,''));for(const item of items)select.add(new Option(item.name||item.label||item.id,item.id));if(value&&!items.some(item=>item.id===value)){const missing=new Option('Недоступно — выберите устройство',value);missing.disabled=true;select.add(missing)}select.value=value||''};
 const loadApps=async()=>{if(appsLoading)return;appsLoading=true;render();try{await model.applications()}catch(error){onError(error)}finally{appsLoading=false;appsLoaded=true;render()}};
 const render=()=>{const {capability,busy}=model;const value={...model.value,mode:model.fallbackMode()};const browser=value.mode==='browser';const modes=capability.modes||[];
  /* every mode is listed; the module microphone only where it exists next to the browser one */
  const microphone=!modes.includes('browser')&&modes.includes('mic')?{id:'mic',name:'Микрофон'}:null;const list=MODES.filter(item=>!item.optional||modes.includes(item.id)&&modes.includes('browser')).map(item=>item.id==='browser'&&microphone?microphone:item);
  const shown=wanted||value.mode;options(field('mode'),list,shown);
  const blocker=wanted?model.unavailable(wanted):null,panel=host.querySelector('.source-unavailable');panel.hidden=!blocker;
  if(blocker){panel.querySelector('p').textContent=installing||blocker.text;const fix=panel.querySelector('.source-fix');fix.hidden=!blocker.action;fix.textContent=installing?'Устанавливаем…':blocker.action||'';fix.disabled=Boolean(installing)}
  const app=value.mode==='app'&&!wanted;host.querySelector('[data-app]').hidden=!app;
  if(app){const apps=model.apps.map(item=>({id:item.processName,name:item.title&&item.title!==item.name?`${item.name} — ${item.title.slice(0,60)}`:item.name}));
   if(value.appName&&!apps.some(item=>item.id===value.appName))apps.unshift({id:value.appName,name:`${value.appName} (сейчас не запущено)`});
   options(field('appName'),apps,value.appName,apps.length?'Выберите приложение':appsLoading?'Ищем открытые приложения…':'Нет открытых приложений');
   if(!appsLoaded&&!appsLoading)void loadApps();}
  options(field('inputId'),(browser?capability.browserInputDevices:capability.inputDevices)||[],browser?value.browserInputId:value.inputId,'Как в системе');options(field('outputId'),capability.outputDevices||[],value.outputId,'Как в системе');
  host.querySelector('[data-input]').hidden=['system','app'].includes(value.mode)||Boolean(blocker);host.querySelector('[data-output]').hidden=['mic','browser','app'].includes(value.mode)||Boolean(blocker);
  for(const select of selects)select.disabled=busy||saving||refreshing||Boolean(installing);host.querySelector('.source-apps-refresh').disabled=busy||appsLoading;
  const refresh=host.querySelector('.source-refresh');refresh.disabled=busy||saving||refreshing;const active=model.activeDevices();refresh.textContent='Разрешить доступ к микрофону';refresh.hidden=!active.needsPermission;/* devices refresh themselves; the button is only for the one consent MONO cannot give itself */
  host.querySelector('.active-devices').hidden=app||Boolean(blocker);
  host.querySelector('[data-active-input]').textContent=active.input||(active.needsPermission?'Разрешите доступ к микрофону, чтобы увидеть его название':'Системный по умолчанию');host.querySelector('[data-active-output]').textContent=active.output||'Системные по умолчанию';if(model.notice){onNotice(model.notice);model.notice=null}
  host.querySelector('.source-guidance').hidden=Boolean(blocker);
  host.querySelector('.source-guidance').textContent=capability.supported===false?'Модуль записи недоступен. Проверьте установку MONO.':browser?'Для записи голоса. Разрешите доступ и выберите микрофон; звук сохраняется в вашу папку.':value.mode==='mic'?'Для голоса и очных разговоров. Доступ к устройству контролирует операционная система.':value.mode==='system'?'Всё, что звучит в колонках или наушниках: видео, звонки, музыка. Ваш микрофон не записывается.':value.mode==='app'?'Только звук выбранной программы — например, браузера со встречей. Уведомления и музыка из других программ в запись не попадут; микрофон не записывается.':'Для встреч: ваш голос и собеседники. Наушники помогут избежать эха.'};
 const unsubscribe=model.subscribe(render);
 for(const select of selects)select.addEventListener('change',async()=>{
  if(select.dataset.source==='mode'){const mode=select.value;if(model.unavailable(mode)&&(model.capability.modes||[]).length){wanted=mode;render();return}wanted=null}
  const patch={[select.dataset.source]:select.value||null};saving=true;render();try{await model.update(patch);if(patch.mode==='app'){appsLoaded=false}}catch(error){onError(error)}finally{saving=false;render()}});
 host.querySelector('.source-fix').onclick=async()=>{
  const blocker=wanted&&model.unavailable(wanted);if(!blocker)return;
  if(blocker.fix){wanted=null;saving=true;render();try{await model.update(blocker.fix)}catch(error){onError(error)}finally{saving=false;render()}return}
  if(!blocker.install)return;
  installing='Готовим установку…';render();
  try{await model.installHelper(message=>{installing=message;render()});const mode=wanted;installing=null;
   if(mode&&!model.unavailable(mode)){wanted=null;await model.update({mode});onNotice('Модуль записи установлен — режим «'+(MODES.find(item=>item.id===mode)?.name||mode)+'» готов.')}
   else onNotice('Модуль установлен, но Windows пока не дала ему этот режим. Откройте «Настройки → Проверка».')}
  catch(error){installing=null;onError(error)}finally{installing=null;render()}};
 host.querySelector('.source-apps-refresh').onclick=()=>void loadApps();
 host.querySelector('.source-refresh').onclick=async()=>{refreshing=true;render();try{await model.refresh({requestAccess:true})}catch(error){onError(error)}finally{refreshing=false;render()}};
 // Plugging or unplugging a headset updates names and selection without a click.
 const devices=globalThis.navigator?.mediaDevices;let timer=0;
 const onDeviceChange=()=>{clearTimeout(timer);timer=setTimeout(()=>{if(!model.busy)void model.refresh().catch(()=>{})},400)};
 devices?.addEventListener?.('devicechange',onDeviceChange);
 return {destroy(){unsubscribe();devices?.removeEventListener?.('devicechange',onDeviceChange);clearTimeout(timer);host.replaceChildren()}};
}
