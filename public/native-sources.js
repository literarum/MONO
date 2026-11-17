import {deviceName} from './browser-microphone.js';
/** One durable selection model shared by studio, settings and onboarding. */
export class CaptureSources{
 constructor(client,library){this.client=client;this.library=library;this.value={mode:'mic',inputId:null,outputId:null};this.capability={modes:[],inputDevices:[],outputDevices:[]};this.listeners=new Set();this.queue=Promise.resolve();this.busy=false}
 emit(){for(const fn of this.listeners)fn(this)}
 subscribe(fn){this.listeners.add(fn);fn(this);return()=>this.listeners.delete(fn)}
 async load(){this.value=(await this.library.json('/preferences')).capture;this.emit();return this.refresh()}
 /** A saved mode can be unavailable (no native helper on this OS/build). Record with the browser microphone instead of failing every start. */
 fallbackMode(mode=this.value.mode){const modes=this.capability.modes||[];return modes.length&&!modes.includes(mode)&&modes.includes('browser')?'browser':mode}
 async refresh({requestAccess=false}={}){
  if(requestAccess&&this.fallbackMode()==='browser')await this.client.requestDevices(this.value.browserInputId||null);
  this.capability=await this.client.capabilities({signal:AbortSignal.timeout(10000)});
  const mode=this.fallbackMode();
  if(mode!==this.value.mode&&!this.busy){try{await this.update({mode})}catch{/* Effective selection still falls back; persistence is retried on the next refresh. */}}
  // A chosen device that disappeared (unplugged headset): follow the system default.
  const browser=mode==='browser',list=(browser?this.capability.browserInputDevices:this.capability.inputDevices)||[],chosen=browser?this.value.browserInputId:this.value.inputId;
  if(chosen&&list.length&&list.every(device=>device.labelled!==false)&&!list.some(device=>device.id===chosen)&&!this.busy){
   try{await this.update({inputId:null});this.notice='Выбранный микрофон отключён — записываем с микрофона по умолчанию.'}catch{}
  }
  this.emit();return this.capability;
 }
 setBusy(value){if(this.busy===value)return;this.busy=value;this.emit()}
 update(patch){const operation=this.queue.then(async()=>{const adjusted={...patch};if((patch.mode||this.value.mode)==='browser'&&'inputId' in patch){adjusted.browserInputId=patch.inputId;delete adjusted.inputId}const changed=Object.entries(adjusted).some(([key,value])=>this.value[key]!==value);const result=await this.library.json('/preferences',{method:'PATCH',body:{capture:{...this.value,...adjusted},...(changed?{onboarding:{soundTested:false}}:{})}});this.value=result.capture;this.emit();return this.value});this.queue=operation.catch(()=>{});return operation}
 /** Devices the system will actually use now: names for the person, never IDs. */
 activeDevices(){
  const mode=this.fallbackMode(),browser=mode==='browser',inputs=(browser?this.capability.browserInputDevices:this.capability.inputDevices)||[],outputs=(browser?this.capability.browserOutputDevices:this.capability.outputDevices)||[];
  const chosenInput=browser?this.value.browserInputId:this.value.inputId,chosenOutput=browser?null:this.value.outputId;
  const pick=(list,id)=>list.find(device=>device.id===id)||list.find(device=>device.default)||list[0];
  const input=pick(inputs,chosenInput),output=pick(outputs,chosenOutput);
  return {input:input&&input.labelled!==false?deviceName(input):null,output:output&&output.labelled!==false?deviceName(output):null,needsPermission:browser&&inputs.length>0&&inputs.every(device=>device.labelled===false)};
 }
 async selection(){await this.queue;const value={...this.value,mode:this.fallbackMode()};return {mode:value.mode,inputId:value.mode==='system'?null:value.mode==='browser'?value.browserInputId||null:value.inputId,outputId:['mic','browser'].includes(value.mode)?null:value.outputId}}
}
let serial=0;
export function mountCaptureSources(host,{model,onError=()=>{},onNotice=()=>{}}){
 const id='capture-source-'+(++serial);host.classList.add('capture-sources');
 host.innerHTML=`<div class="source-field"><label class="field-label" for="${id}-mode">Что записывать</label><select class="select" id="${id}-mode" data-source="mode"></select></div><div class="source-field" data-input><label class="field-label" for="${id}-input">Микрофон</label><select class="select" id="${id}-input" data-source="inputId"></select></div><div class="source-field" data-output><label class="field-label" for="${id}-output">Звук компьютера</label><select class="select" id="${id}-output" data-source="outputId"></select></div><div class="active-devices" role="status" aria-live="polite"><div><span class="active-devices-label">Микрофон</span><strong data-active-input>—</strong></div><div><span class="active-devices-label">Звук выводится</span><strong data-active-output>—</strong></div></div><p class="field-hint source-guidance" role="status"></p><button type="button" class="btn btn-outline btn-small source-refresh">Обновить устройства</button>`;
 const selects=[...host.querySelectorAll('select')];let saving=false,refreshing=false;
 const options=(select,items,value,defaultLabel)=>{select.replaceChildren();if(defaultLabel)select.add(new Option(defaultLabel,''));for(const item of items)select.add(new Option(item.name||item.label||item.id,item.id));if(value&&!items.some(item=>item.id===value)){const missing=new Option('Недоступно — выберите устройство',value);missing.disabled=true;select.add(missing)}select.value=value||''};
 const render=()=>{const {value,capability,busy}=model;const browser=value.mode==='browser';options(selects[0],[{id:'browser',name:'Микрофон браузера'},{id:'mic',name:'Микрофон (системный модуль)'},{id:'system',name:'Звук компьютера'},{id:'both',name:'Микрофон и компьютер'}].filter(item=>!capability.modes.length||capability.modes.includes(item.id)),value.mode);options(selects[1],(browser?capability.browserInputDevices:capability.inputDevices)||[],browser?value.browserInputId:value.inputId,'Как в системе');options(selects[2],capability.outputDevices||[],value.outputId,'Как в системе');host.querySelector('[data-input]').hidden=value.mode==='system';host.querySelector('[data-output]').hidden=['mic','browser'].includes(value.mode);for(const select of selects)select.disabled=busy||saving||refreshing;const refresh=host.querySelector('.source-refresh');refresh.disabled=busy||saving||refreshing;refresh.textContent=browser?'Разрешить и обновить микрофоны':'Обновить устройства';const active=model.activeDevices();host.querySelector('[data-active-input]').textContent=active.input||(active.needsPermission?'Разрешите доступ к микрофону, чтобы увидеть его название':'Системный по умолчанию');host.querySelector('[data-active-output]').textContent=active.output||'Системные по умолчанию';if(model.notice){onNotice(model.notice);model.notice=null}host.querySelector('.source-guidance').textContent=capability.supported===false?'Модуль записи недоступен. Проверьте установку MONO.':browser?'Для записи голоса. Разрешите доступ и выберите микрофон; звук сохраняется в вашу папку.':value.mode==='mic'?'Для голоса и очных разговоров. Доступ к устройству контролирует операционная система.':value.mode==='system'?'Для звука приложений. Ваш микрофон не записывается.':'Для встреч: ваш голос и собеседники. Наушники помогут избежать эха.'};
 const unsubscribe=model.subscribe(render);
 for(const select of selects)select.addEventListener('change',async()=>{const patch={[select.dataset.source]:select.value||null};saving=true;render();try{await model.update(patch)}catch(error){onError(error)}finally{saving=false;render()}});
 host.querySelector('.source-refresh').onclick=async()=>{refreshing=true;render();try{await model.refresh({requestAccess:true})}catch(error){onError(error)}finally{refreshing=false;render()}};
 // Plugging or unplugging a headset updates names and selection without a click.
 const devices=globalThis.navigator?.mediaDevices;let timer=0;
 const onDeviceChange=()=>{clearTimeout(timer);timer=setTimeout(()=>{if(!model.busy)void model.refresh().catch(()=>{})},400)};
 devices?.addEventListener?.('devicechange',onDeviceChange);
 return {destroy(){unsubscribe();devices?.removeEventListener?.('devicechange',onDeviceChange);clearTimeout(timer);host.replaceChildren()}};
}
