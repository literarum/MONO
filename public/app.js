import {openDB,putRecording,getRecording,listRecordings,patchRecording,addChunk,saveImportedRecording,getBlob,removeRecording,restoreRecording,streamRecordingAudio,storageDetails,configureLibrary,chooseLibraryFolder,audioURL,transcriptPage,saveSegmentEdit,submitLocalTranscription,startLibraryTransfer,libraryTransferStatus,cancelLibraryTransfer,resumeLibraryTransfer,recoverLibraryTransfer,refreshStorageStatus} from './db.js';
import {audioExtension,validBackupItem,portableRecord} from './backup-core.js';
import {enhanceUI,syncControls,closeDrawer} from './ui/index.js';
import {migrateLegacy} from './library-migration.js';
import {localLibraryClient} from './db.js';
import {CredentialsClient,mountCredentials} from './credentials.js';
import {CaptureClient,captureErrors,captureFailureMessage} from './capture-client.js';
import {BrowserMicrophoneClient} from './browser-microphone.js';
import {NativeCaptureController,captureActive} from './native-capture.js';
import {CaptureSources,mountCaptureSources} from './native-sources.js';
import {openOnboarding} from './onboarding.js';
import {mountGuidance,mountHelp} from './help.js';
import {MediaInterlock} from './media-interlock.js';
import {AudioReview} from './audio-review.js';
import {captureSelection,selectionKey} from './transcription-selection.js';
import {Preflight,mountPreflight} from './preflight.js';

const $=s=>document.querySelector(s), $$=s=>[...document.querySelectorAll(s)];
const setText=(selector,value)=>{const element=$(selector);if(element.textContent!==value)element.textContent=value};
const icon=(name)=>`<svg aria-hidden="true"><use href="#i-${name}"/></svg>`;
const h=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const fmtDate=d=>new Intl.DateTimeFormat('ru-RU',{day:'2-digit',month:'short',year:'numeric'}).format(new Date(d));
const durationText=n=>{n=Math.max(0,Math.floor(Number(n)||0));return `${String(Math.floor(n/3600)).padStart(2,'0')}:${String(Math.floor(n%3600/60)).padStart(2,'0')}:${String(n%60).padStart(2,'0')}`};
const shortTime=n=>{
 n=Math.max(0,Math.floor(Number(n)||0));
 return n>=3600?durationText(n):`${String(Math.floor(n/60)).padStart(2,'0')}:${String(n%60).padStart(2,'0')}`;
};
const sizeText=n=>n>=1024**2?`${(n/1024**2).toFixed(1)} МБ`:`${Math.round(n/1024)} КБ`;
const money=n=>new Intl.NumberFormat('ru-RU',{minimumFractionDigits:2,maximumFractionDigits:2}).format(n);
const MODEL_PRICE=.04;
const DEFAULTS={theme:'system',profile:'standard',rate:83.0784,prompt:''};
const settings={...DEFAULTS,...readSettings()};
const state={records:[],view:'dashboard',recorder:null,recordingId:null,capture:null,health:null,
  editorId:null,editorPage:0,playerURL:null,pollBusy:false,recordBusy:false,pendingEdits:new Map(),failedEdits:new Map(),visibleSegments:new Map()};
let credentialForm=null,pendingTranscriptionId=null;
let nativeController=null,captureSources=null,nativeCompleted=null,nativeFrame=0,nativeInitializing=null,setupWindow=null,setupOpening=null;
let mediaInterlock=null,audioReview=null,preflight=null;
function pauseAudition(){audioReview?.player.pause();if(mediaInterlock)mediaInterlock.pauseAll();else document.querySelectorAll('audio,video').forEach(media=>media.pause())}
function canAudition(){if(storageDetails().local&&(!nativeController?.snapshot.connected||captureActive(nativeController.snapshot))){notify('Завершите запись перед прослушиванием, чтобы звук плеера не попал в неё.','error');return false}return true}
async function playAudition(media){if(!canAudition())return;try{if(storageDetails().local){if(!mediaInterlock)throw new Error('Дождитесь подключения модуля записи.');await mediaInterlock.play(media)}else await media.play()}catch(error){if(error.name!=='AbortError')notify(error.message||'Не удалось воспроизвести аудио.','error')}}
/** Warn while recording, not after: a silent or clipping input is fixable only now. */
const captureHealth={session:null,lastSound:0,clipUntil:0};
function captureHealthHint(value){
 const now=performance.now();
 if(captureHealth.session!==value.sessionId){Object.assign(captureHealth,{session:value.sessionId,lastSound:now,clipUntil:0})}
 if(value.state!=='recording'){captureHealth.lastSound=now;return ''}
 const levels=Object.values(value.levels||{}).filter(level=>Number.isFinite(level?.rms)&&(level.ageMs??0)<3000);
 // −50 dBFS RMS: below any normal speech, above typical digital silence.
 if(!levels.length||levels.some(level=>level.rms>0.00316))captureHealth.lastSound=now;
 if(levels.some(level=>level.clippedFrames>=3))captureHealth.clipUntil=now+4000;
 if(now-captureHealth.lastSound>10000)return ' · ⚠ Микрофон молчит больше 10 с — проверьте выбранный вход и его громкость';
 if(now<captureHealth.clipUntil)return ' · ⚠ Перегрузка входа — уменьшите усиление микрофона или отодвиньтесь';
 return '';
}
function onNativeState(value){
 const wasActive=Boolean(state.capture?.native&&captureActive(state.capture.snapshot)&&state.capture.id===value.recordId);
 const active=captureActive(value);captureSources?.setBusy(active);
 mediaInterlock?.observe(value);
 audioReview?.captureState(value);
 if(active){
  if(!state.capture?.native)state.capture={native:true,peaks:[]};
  Object.assign(state.capture,{id:value.recordId,paused:value.state==='paused',stopping:value.state==='stopping',snapshot:value});state.recordingId=value.recordId;pauseAudition();
  if(!nativeFrame)nativeFrame=requestAnimationFrame(drawWave);
 }else if(state.capture?.native){state.capture=null;state.recordingId=null}
 $('#start-record').hidden=active;$('#start-record').disabled=!value.connected;
 $('#pause-record').hidden=!active;$('#stop-record').hidden=!active;
 $('#pause-record').disabled=!value.connected||Boolean(value.pendingAction)||!['recording','paused'].includes(value.state);
 $('#stop-record').disabled=value.state==='stopping';$('#pause-record').innerHTML=icon(value.state==='paused'?'play':'pause')+(value.state==='paused'?' Продолжить':' Пауза');
 setText('#record-saved',!value.connected?'Связь потеряна. Остановка и сохранение не подтверждены.':value.state==='requesting'?'Подключаем источник звука…':value.state==='stopping'?'Завершаем запись и проверяем сохранение…':active?'Подтверждено в архиве: '+durationText(value.duration)+captureHealthHint(value):value.errorCode?captureFailureMessage(value):'Аудио сохраняется в выбранной папке');
 updateRecordUI();
 if(!active&&value.recordId&&nativeCompleted!==value.recordId){nativeCompleted=value.recordId;void refresh().catch(e=>notify(e.message,'error'));if(wasActive)notify(value.state==='ready'?'Запись сохранена в библиотеке.':captureFailureMessage(value),value.state==='ready'?'info':'error')}
}
async function initializeNative(local){
 if(nativeInitializing)return nativeInitializing;
 nativeInitializing=(async()=>{
 if(!nativeController){
  const client=new BrowserMicrophoneClient(new CaptureClient({library:local}));captureSources=new CaptureSources(client,local);
  mediaInterlock=new MediaInterlock({status:options=>client.status(options),channel:typeof BroadcastChannel==='function'?new BroadcastChannel('mono-media'):null});
  nativeController=new NativeCaptureController(client,{onState:onNativeState,onError:error=>notify(error.message,'error'),onIntent:options=>mediaInterlock.beforeCapture(options)});
  const studio=$('#audio-source').closest('.side-card');studio.replaceChildren();mountCaptureSources(studio,{model:captureSources,onError:error=>notify(error.message,'error')});
  const card=document.createElement('article');card.className='glass settings-card';card.innerHTML='<div class="settings-card-icon"><svg><use href="#i-mic"/></svg></div><h2>Источники записи</h2><div class="settings-capture-sources"></div><button type="button" class="btn btn-outline btn-small" id="check-native-sound">Проверить звук</button>';$('#view-settings .settings-grid').prepend(card);mountCaptureSources(card.querySelector('.settings-capture-sources'),{model:captureSources,onError:error=>notify(error.message,'error')});card.querySelector('button#check-native-sound').onclick=()=>void showSetup('sound').catch(error=>notify(error.message,'error'));
  const guide=$('.studio-side>.side-card:not(.capture-sources)');guide.replaceChildren();mountGuidance(guide,{library:local,controller:nativeController,sources:captureSources,onError:error=>notify(error.message,'error'),onAction:async(action,recordId)=>{if(action==='listen'){await refresh();go('editor',recordId)}else await showSetup('sound')}});
  const help=document.createElement('article');help.className='glass settings-card';mountHelp(help);$('#view-settings .settings-grid').append(help);
  // Pre-flight check: compact (problems only) in the studio, full in settings.
  preflight=new Preflight(local);
  const studioCheck=document.createElement('div');studioCheck.className='glass side-card';$('.studio-side').prepend(studioCheck);mountPreflight(studioCheck,{model:preflight,compact:true,onError:()=>{}});
  const settingsCheck=document.createElement('article');settingsCheck.className='glass settings-card';settingsCheck.innerHTML='<div class="settings-card-icon"><svg><use href="#i-check"/></svg></div><h2>Предполётная проверка</h2><div></div>';$('#view-settings .settings-grid').prepend(settingsCheck);mountPreflight(settingsCheck.lastElementChild,{model:preflight,onError:error=>notify(error.message,'error')});
 }
 await nativeController.connect();
 await captureSources.load();
 return {controller:nativeController,sources:captureSources};
 })().catch(error=>{nativeInitializing=null;throw error});return nativeInitializing;
}
async function showSetup(initialStep=null){
 if(setupWindow)return;if(setupOpening){await setupOpening;if(initialStep&&!setupWindow)return showSetup(initialStep);return}setupOpening=(async()=>{const local=await localLibraryClient();if(!local)return;
 const opened=await openOnboarding({library:local,storage:storageDetails,configure:configureLibrary,choose:chooseLibraryFolder,ensureNative:()=>initializeNative(local),onArchive:async()=>{updateStorageSettings();await refresh()},onComplete:()=>{setupWindow=null;void credentialForm?.refresh()},onError:error=>notify(error.message,'error'),helpTemplate:$('#groq-settings-card .setup-details'),initialStep,canPlay:canAudition,playAudio:audio=>mediaInterlock.play(audio)});setupWindow=opened&&!opened.closed?opened:null;
 })().finally(()=>{setupOpening=null});return setupOpening;
}
/** Transcriber controls: Ctrl+Space / F9 / Space play–pause (pausing steps back 2 s), Alt+←/→ seek ±5 s. */
async function transcriptHotkey(action){
 const review=audioReview?.player,element=$('#audio-element');
 const playing=review?review.snapshot.playing:!element.paused,time=review?review.time:element.currentTime;
 const seek=async seconds=>{seconds=Math.max(0,seconds);if(review)await review.seek(seconds);else element.currentTime=seconds};
 if(action==='toggle'){
  if(playing){if(review)review.pause();else element.pause();await seek(time-2);return}
  if(review){if(canAudition())await review.play()}else{if(!element.src){notify('Аудиофайл недоступен','error');return}await playAudition(element)}
  return;
 }
 await seek(time+action);
}
function readSettings(){try{return JSON.parse(localStorage.getItem('mono-settings')||'{}')}catch{return {}}}
function saveSettings(){try{localStorage.setItem('mono-settings',JSON.stringify(settings))}catch{notify('Не удалось сохранить настройки','error')}}
function applyTheme(){
  const dark=settings.theme==='system'?(!matchMedia('(prefers-color-scheme: light)').matches):settings.theme==='dark';
  document.body.dataset.theme=dark?'dark':'light';
  $('#theme-toggle').innerHTML=icon(dark?'sun':'moon');
  document.querySelector('meta[name="theme-color"]').content=dark?'#08090b':'#f1f1ef';
}
function notify(message,type='info'){
  const active=notify.active??=new Map(),key=JSON.stringify([type,message]);
  let entry=active.get(key);
  if(entry&&!entry.el.isConnected){clearTimeout(entry.timer);active.delete(key);entry=null}
  if(!entry){
    const el=document.createElement('div');el.className='toast '+(type==='error'?'error':'');el.textContent=message;
    el.setAttribute('role',type==='error'?'alert':'status');$('#toast-area').append(el);
    entry={el,timer:null};active.set(key,entry);
  }
  clearTimeout(entry.timer);
  entry.timer=setTimeout(()=>{entry.el.remove();if(active.get(key)===entry)active.delete(key)},6500);
}
let modalReturnFocus=null;
function modal(title,body,actions=[]){
  modalReturnFocus=document.activeElement;
  $('#modal-title').textContent=title;$('#modal-text').innerHTML=body;const container=$('#modal-actions');container.replaceChildren();
  const cancel=document.createElement('button');cancel.className='btn btn-outline';cancel.textContent='Отмена';cancel.onclick=closeModal;container.append(cancel);
  for(const action of actions){
    const btn=document.createElement('button');btn.className='btn '+(action.primary?'btn-primary':'btn-outline');
    btn.textContent=action.text;btn.onclick=()=>{closeModal();void Promise.resolve().then(action.run).catch(e=>notify(e.message,'error'))};container.append(btn);
  }
  $('#modal').hidden=false;container.querySelector('button').focus();
}
function closeModal(){
  if($('#modal').hidden)return;
  $('#modal').hidden=true;
  if(modalReturnFocus?.isConnected)modalReturnFocus.focus();
  modalReturnFocus=null;
}
function statusLabel(r){
  if(r.status==='completed')return 'Готово';
  if(r.status==='processing'||r.status==='queued')return 'Обрабатывается';
  if(r.status==='recording'||r.status==='requesting')return 'Идёт запись';
  if(r.status==='paused')return 'Запись на паузе';
  if(r.status==='importing')return 'Импорт не завершён';
  if(r.status==='damaged')return 'Аудио повреждено';
  if(r.status==='uploading')return 'Загрузка / восстановление';
  if(r.status==='failed')return 'Ошибка обработки';
  if(r.status==='cancelled')return 'Отменено';
  if(r.status==='interrupted')return 'Прервано';
 if(r.status==='migrating')return 'Перенос не завершён';
  return 'Аудио сохранено';
}
function escapeNext(){return location.hash.slice(1).split('/')[0]}
function go(view,id=null){
  location.hash=view==='editor'&&id?`#editor/${encodeURIComponent(id)}`:`#${view}`;
  renderRoute();
}
function renderRoute({preserveDrawer=false}={}){
  const [requested,id]=location.hash.slice(1).split('/');
  let view=['dashboard','record','library','jobs','editor','settings'].includes(requested)?requested:'dashboard';
  if(state.view==='settings'&&view!=='settings')credentialForm?.clear();
  if(view==='settings'&&state.view!=='settings')void credentialForm?.refresh();
  if(view==='editor'){
    if(!id||!state.records.some(r=>r.id===id)){view='library';}
    else if(state.editorId!==id||state.view!=='editor'){state.editorId=id;state.editorPage=0;void renderEditor(id).catch(e=>notify(e.message,'error'))}
  }
 if(state.view==='editor'&&view!=='editor'){if(audioReview){audioReview.player.pause();void audioReview.cancel(true).catch(e=>notify(e.message,'error'))}else $('#audio-element').pause()}
  state.view=view;
  if(view==='settings')document.querySelectorAll('.archive-recovery-notice').forEach(notice=>notice.remove());
  $$('.view').forEach(el=>el.classList.toggle('active',el.id==='view-'+view));
  $$('.nav-link[data-view]').forEach(el=>(el.classList.toggle('selected',el.dataset.view===view),el.setAttribute('aria-current',el.dataset.view===view?'page':'false')));
  const titles={dashboard:'Обзор',record:'Студия записи',library:'Библиотека',jobs:'Обработка',editor:'Редактор',settings:'Настройки'};
  $('#current-breadcrumb').textContent=titles[view];
  if(!preserveDrawer)closeDrawer('route');
  if(view==='library')renderLibrary();
  if(view==='jobs')renderJobs();
  $('#main').scrollTo({top:0,behavior:'instant'});
}
async function refresh(){
  state.records=(await listRecordings()).sort((a,b)=>new Date(b.createdAt)-new Date(a.createdAt));
  $('#nav-count').textContent=state.records.length;
  renderDashboard();
  if(state.view==='library')renderLibrary();
  if(state.view==='jobs')renderJobs();
}
function renderDashboard(){
  const list=state.records,totalSeconds=list.reduce((s,r)=>s+(r.duration||0),0);
  // Calendar month in the person's time zone, not UTC.
  const monthOf=value=>{const d=new Date(value);return Number.isNaN(d.getTime())?'':`${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`};
  const month=monthOf(Date.now());
  const monthRecords=list.filter(r=>r.status==='completed'&&monthOf(r.completedAt)===month);
  const monthSeconds=monthRecords.reduce((s,r)=>s+(r.duration||0),0);
  const usd=list.filter(r=>r.estimatedUSD &&
    monthOf(r.transcriptionStartedAt||r.completedAt||r.createdAt)===month
  ).reduce((s,r)=>s+r.estimatedUSD,0);
  $('#metric-total').textContent=String(list.length);
  $('#metric-duration').innerHTML=`${Math.floor(totalSeconds/3600)}<small>ч</small> ${String(Math.floor(totalSeconds%3600/60)).padStart(2,'0')}<small>м</small>`;
  $('#metric-month').innerHTML=`${Math.round(monthSeconds/60)}<small>мин</small>`;
  $('#metric-cost').innerHTML=`${money(usd*settings.rate)} <small>₽</small>`;
  $('#recent-list').innerHTML=list.length?list.slice(0,4).map(r=>`
    <button class="recent-item" data-open="${h(r.id)}"><span class="item-icon">${icon('file')}</span>
    <span class="item-main"><strong>${h(r.title)}</strong><span>${fmtDate(r.createdAt)} · ${durationText(r.duration)} · ${sizeText(r.size||0)}</span></span>
    <span class="item-status">${statusLabel(r)}</span>${icon('chevron')}</button>`).join(''):
    `<div class="empty-state">${icon('mic')}<strong>Здесь появятся ваши записи</strong><p>Начните запись или загрузите аудио,<br>чтобы создать первую транскрипцию.</p><button class="btn btn-outline btn-small" data-go="record">Открыть студию ${icon('arrow')}</button></div>`;
}
let libraryGeneration=0;
async function renderLibrary(){
  const generation=++libraryGeneration;
  const q=$('#library-search').value.trim().toLowerCase(),filter=$('#library-filter').value,sort=$('#library-sort').value;
  const local=storageDetails().local;let source=state.records;
  if(local&&(q||filter==='trash')){try{source=await listRecordings(q,{trash:filter==='trash'})}catch(e){if(generation===libraryGeneration)notify(e.message,'error');return}}
  if(generation!==libraryGeneration)return;
  let records=source.filter(r=>{
    if(filter==='completed'&&r.status!=='completed')return false;
    if(filter==='saved'&&['completed','recording','requesting','paused','damaged','importing','migrating'].includes(r.status))return false;
    const texts=(r.transcript?.segments||[]).map(s=>s.text).join(' ');
    return local||!q||`${r.title} ${texts}`.toLowerCase().includes(q);
  });
  if(sort==='oldest')records=records.sort((a,b)=>new Date(a.createdAt)-new Date(b.createdAt));
  if(sort==='name')records=records.sort((a,b)=>a.title.localeCompare(b.title,'ru'));
  $('#library-count').textContent=`${records.length} ${({one:'ЗАПИСЬ',few:'ЗАПИСИ'})[new Intl.PluralRules('ru-RU').select(records.length)]||'ЗАПИСЕЙ'}`;
  $('#library-list').innerHTML=records.length?records.map(r=>`
   <article class="record-card glass"><div class="record-card-head"><span class="item-icon">${icon('file')}</span><span class="record-status">${statusLabel(r)}</span></div>
   <h3 title="${h(r.title)}">${h(r.title)}</h3><p class="record-sub">${fmtDate(r.createdAt)} · ${h(r.source||'Импорт')}</p>
   <div class="record-card-meta"><div><span>ДЛИТЕЛЬНОСТЬ</span><strong>${durationText(r.duration)}</strong></div><div><span>РАЗМЕР</span><strong>${sizeText(r.size||0)}</strong></div><div><span>СТОИМОСТЬ · ОЦЕНКА</span><strong>${money((r.estimatedUSD||0)*settings.rate)} ₽</strong></div></div>
   <div class="record-card-actions">${r.trashed?`<button class="btn btn-outline btn-small" data-restore="${h(r.id)}" data-version="${r.version}">Восстановить ${icon('refresh')}</button>`:`<button class="btn ${r.status==='completed'?'btn-primary':'btn-outline'} btn-small" data-open="${h(r.id)}">${r.status==='completed'?'Открыть текст':'Открыть запись'} ${icon('arrow')}</button>
   <div class="card-icon-actions"><button class="icon-btn" data-rename="${h(r.id)}" title="Переименовать" aria-label="Переименовать запись">${icon('file')}</button><button class="icon-btn" data-delete="${h(r.id)}" title="Удалить запись" aria-label="Удалить запись">${icon('trash')}</button></div>`}</div></article>`).join(''):
   `<div class="glass" style="grid-column:1/-1;border-radius:18px"><div class="empty-state">${icon('library')}<strong>${filter==='trash'?'Корзина пуста':'Записей не найдено'}</strong><p>${filter==='trash'?'Здесь можно восстановить удалённые записи.':state.records.length?'Измените условия поиска.':'Создайте запись или импортируйте аудио.'}</p>${filter==='trash'?'':`<button class="btn btn-outline btn-small" data-go="record">Студия записи ${icon('arrow')}</button>`}</div></div>`;
}
function renderJobs(){
 const items=state.records.filter(r=>r.jobId||r.status==='uploading').sort((a,b)=>new Date(b.createdAt)-new Date(a.createdAt));
 $('#jobs-list').innerHTML=items.length?items.map(r=>{
  const progress=r.job?.total?Math.min(100,Math.round(r.job.completed/r.job.total*100)):0;
  const failed=r.status==='failed',active=['queued','processing'].includes(r.status);
  return `<article class="job-card glass"><div class="job-top"><div><span class="small-label">ЗАДАНИЕ / ${h(r.jobId?.slice(0,8).toUpperCase()||'LOADING')}</span><h3>${h(r.title)}</h3><p>${h(r.job?.stage||statusLabel(r))}${r.job?.error?' · '+h(r.job.error):''}</p></div><span class="record-status">${statusLabel(r)}</span></div>
  <div class="job-progress-track" role="progressbar" aria-valuenow="${progress}" aria-valuemin="0" aria-valuemax="100"><div class="job-progress-fill" style="width:${progress}%"></div></div>
  <div class="job-bottom"><span>${r.job?.total?`Обработано ${r.job.completed||0} из ${r.job.total} фрагментов`:'Ожидание информации от сервера'}</span>
  <div>${failed?`<button class="btn btn-outline btn-small" data-retry="${h(r.id)}">${icon('refresh')} Повторить</button>`:''}${active?`<button class="btn btn-outline btn-small" data-cancel="${h(r.id)}">Отменить</button>`:''}${r.status==='completed'?`<button class="btn btn-primary btn-small" data-open="${h(r.id)}">Открыть текст ${icon('arrow')}</button>`:''}</div></div></article>`;
 }).join(''):`<div class="glass" style="border-radius:18px"><div class="empty-state">${icon('activity')}<strong>Пока нет задач</strong><p>Загрузите аудио и запустите распознавание.</p><button class="btn btn-outline btn-small" data-go="library">Перейти в библиотеку ${icon('arrow')}</button></div></div>`;
}
function withInput(fn){const f=$('#file-input');f.value='';f.onchange=()=>{if(f.files?.length)void fn(f.files[0])};f.click()}
async function fileDuration(file){
 return new Promise(resolve=>{
  const audio=document.createElement('audio'),url=URL.createObjectURL(file);
  let settled=false;
  const finish=value=>{
   if(settled)return;settled=true;clearTimeout(timer);
   audio.onloadedmetadata=null;audio.onerror=null;
   audio.removeAttribute('src');audio.load();URL.revokeObjectURL(url);
   resolve(Number.isFinite(value)&&value>0?value:0);
  };
  const timer=setTimeout(()=>finish(0),5000);
  audio.preload='metadata';audio.onloadedmetadata=()=>finish(audio.duration);audio.onerror=()=>finish(0);audio.src=url;
 });
}
async function importFile(file){
 if(archiveOperation){notify('Дождитесь завершения операции с архивом.','error');return}
 if(!file||!(/\.(wav|mp3|mp4|m4a|ogg|opus|webm|flac|aac)$/i.test(file.name)||file.type.startsWith('audio/'))){notify('Выберите аудиофайл поддерживаемого формата.','error');return}
 const importLimit=storageDetails().local?32*1024**3:1024**3;
 if(file.size>importLimit){notify(`Файл больше ${storageDetails().local?'32':'1'} ГБ. Разбейте его перед импортом.`,'error');return}
 const id=crypto.randomUUID(),duration=await fileDuration(file);
 const rec={id,title:file.name.replace(/\.[^.]+$/,'').slice(0,130),createdAt:new Date().toISOString(),
  duration,mime:file.type||mimeForName(file.name),size:file.size,source:'Импорт файла',chunkCount:0,status:'saved'};
 try{await saveImportedRecording(rec,file);await refresh();notify('Аудиофайл сохранён на устройстве.');go('library')}
 catch(e){await removeRecording(id).catch(()=>{});notify('Ошибка сохранения файла: '+e.message,'error')}
}
function mimeForName(name){const ext=name.split('.').pop().toLowerCase();return {'mp3':'audio/mpeg','m4a':'audio/mp4','mp4':'audio/mp4','wav':'audio/wav','ogg':'audio/ogg','opus':'audio/ogg','flac':'audio/flac','aac':'audio/aac','webm':'audio/webm'}[ext]||'audio/webm'}
function streamTracks(stream){return stream?.getTracks?.()||[]}
function stopTracks(...streams){for(const stream of streams){for(const track of streamTracks(stream))try{track.stop()}catch{}}}
async function getCapture(source){
 let mic=null,display=null,ctx=null,destination=null,analyser=null;
 try{
   // getDisplayMedia requires transient user activation: request it before other async permissions.
   if(source==='system'||source==='both'){
    if(!navigator.mediaDevices.getDisplayMedia)throw new Error('Этот браузер не поддерживает захват звука вкладки или экрана');
    display=await navigator.mediaDevices.getDisplayMedia({video:true,audio:true});
    if(display.getAudioTracks().length===0)throw new Error('Источник не передал аудио. При выборе экрана включите «Поделиться звуком».');
   }
   if(source==='mic'||source==='both')mic=await navigator.mediaDevices.getUserMedia({audio:{echoCancellation:false,noiseSuppression:false,autoGainControl:false},video:false});
   ctx=new AudioContext();
   analyser=ctx.createAnalyser();analyser.fftSize=512;analyser.smoothingTimeConstant=.7;
   destination=ctx.createMediaStreamDestination();
   for(const stream of [mic,display].filter(Boolean)){
    const src=ctx.createMediaStreamSource(new MediaStream(stream.getAudioTracks()));
    src.connect(destination);src.connect(analyser);
   }
   await ctx.resume();
   return {mic,display,ctx,destination,analyser,stream:destination.stream};
 }catch(e){stopTracks(mic,display);if(ctx)await ctx.close().catch(()=>{});throw e}
}
function chosenMime(){
 const opts=['audio/webm;codecs=opus','audio/webm','audio/mp4','audio/ogg;codecs=opus'];
 return opts.find(t=>MediaRecorder.isTypeSupported(t))||'';
}
async function beginRecord(){
 if(archiveOperation){notify('Дождитесь завершения операции с архивом.','error');return}
 if(storageDetails().local){try{if(!nativeController)throw new Error('Подключите папку архива перед записью.');const blocked=await preflight?.gate();if(blocked){notify(`${blocked.title}. ${blocked.action||blocked.detail||''}`.trim(),'error');void preflight.run({force:true}).catch(()=>{});return}await nativeController.start(await captureSources.selection())}catch(error){if(error?.name!=='AbortError')notify(error.message||'Не удалось начать запись.','error')}return}
 if(state.recordBusy||state.capture)return;
 state.recordBusy=true;
 let capture=null;
 try{
   if(!navigator.mediaDevices||typeof MediaRecorder==='undefined')throw new Error('Для записи необходим современный браузер и HTTPS или localhost.');
   const source=$('#audio-source').value;
   capture=await getCapture(source);
   const estimate=await navigator.storage?.estimate?.().catch(()=>null);
   if(estimate?.quota&&estimate.quota-estimate.usage<150*1024*1024)notify('В браузере осталось менее 150 МБ доступного места.','error');
   const mime=chosenMime();
   const recorder=new MediaRecorder(capture.stream,mime?{mimeType:mime,audioBitsPerSecond:96000}:{audioBitsPerSecond:96000});
   const id=crypto.randomUUID(),now=new Date().toISOString();
   const rec={id,title:'Новая запись · '+new Intl.DateTimeFormat('ru-RU',{day:'2-digit',month:'2-digit',hour:'2-digit',minute:'2-digit'}).format(new Date()),
     createdAt:now,duration:0,mime:recorder.mimeType||mime||'audio/webm',size:0,source:source==='mic'?'Микрофон':source==='both'?'Микрофон + экран':'Звук экрана',status:'recording',chunkCount:0};
   await putRecording(rec);
   const runtime={id,recorder,capture,start:performance.now(),pauseStart:0,pauseMs:0,paused:false,index:0,
     pending:Promise.resolve(),failed:false,stopping:false, peaks:[],warned:false};
   state.capture=runtime;state.recordingId=id;
   recorder.ondataavailable=e=>{
     if(!e.data?.size)return;
     const index=runtime.index++;
     runtime.pending=runtime.pending.then(()=>addChunk(id,index,e.data)).then(size=>{
       $('#record-saved').textContent=`Сохранено на устройстве: ${sizeText(size)} · ${index+1} блоков`;
     }).catch(err=>{runtime.failed=true;notify('Не удалось сохранить аудиоблок: '+err.message,'error');void endRecord()});
   };
   recorder.onstop=()=>{void finalizeRecord(runtime)};
   recorder.onerror=()=>{runtime.failed=true;notify('Ошибка MediaRecorder. Сохранённые блоки будут доступны.','error');void endRecord()};
   for(const t of [...streamTracks(capture.mic),...streamTracks(capture.display)]){
     t.addEventListener('ended',()=>{if(!runtime.stopping){notify('Аудиоисточник отключился. Завершаем запись.','error');void endRecord()}},{once:true});
   }
   recorder.start(5000);
   $('#start-record').hidden=true;$('#pause-record').hidden=false;$('#stop-record').hidden=false;
   $('#audio-source').disabled=true;updateRecordUI();
   state.recordBusy=false;drawWave();
 }catch(e){
   if(capture){stopTracks(capture.mic,capture.display);await capture.ctx.close().catch(()=>{})}
   if(state.recordingId&&!state.capture){
    await patchRecording(state.recordingId,{status:'interrupted'}).catch(()=>{});
    state.recordingId=null;
   }
   state.recordBusy=false;notify('Не удалось начать запись: '+e.message,'error');
 }
}
function currentRecordingSeconds(){
 const r=state.capture;if(!r)return 0;
 if(r.native)return r.snapshot.duration||0;
 return Math.max(0,((r.paused?r.pauseStart:performance.now())-r.start-r.pauseMs)/1000);
}
function updateRecordUI(){
 const r=state.capture;
 if(r?.native){const value=r.snapshot,labels={requesting:'Подключаем звук',recording:'Идёт запись',paused:'Пауза',stopping:'Сохраняем'};$('#record-state').classList.toggle('recording',value.state==='recording'&&value.connected);setText('#record-state',value.connected?labels[value.state]:'Нет связи');setText('#record-caption',value.state==='paused'?'ПАУЗА СОХРАНЯЕТСЯ НА ШКАЛЕ ВРЕМЕНИ':value.state==='recording'?'ПОДТВЕРЖДЕНО В АРХИВЕ':'ОЖИДАЕМ ПОДТВЕРЖДЕНИЕ');setText('#record-timer',durationText(value.duration));return}
 $('#record-state').classList.toggle('recording',Boolean(r&&!r.paused));
 $('#record-state').innerHTML=r?(r.paused?'Пауза':`<span class="tiny-dot"></span> Идёт запись`):`<span class="tiny-dot"></span> Ожидание`;
 $('#record-caption').textContent=r?(r.paused?'ЗАПИСЬ ПРИОСТАНОВЛЕНА':'ЗАПИСЬ В ПРОЦЕССЕ'):'ГОТОВО К ЗАПИСИ';
 $('#record-timer').textContent=durationText(currentRecordingSeconds());
}
function pauseRecord(){
 if(storageDetails().local){void (nativeController.snapshot.state==='paused'?nativeController.resume():nativeController.pause()).catch(error=>notify(error.message,'error'));return}
 const r=state.capture;if(!r||r.stopping)return;
 if(r.paused){
  r.recorder.resume();r.pauseMs+=performance.now()-r.pauseStart;r.paused=false;
  $('#pause-record').innerHTML=`${icon('pause')} Пауза`;
 }else{
  r.recorder.pause();r.paused=true;r.pauseStart=performance.now();
  $('#pause-record').innerHTML=`${icon('play')} Продолжить`;
 }
 updateRecordUI();
}
async function endRecord(){
 if(storageDetails().local){try{await nativeController.stop()}catch(error){notify(error.message,'error')}return}
 const r=state.capture;if(!r||r.stopping)return;
 r.stopping=true;r.finalSeconds=currentRecordingSeconds();
 $('#pause-record').disabled=true;$('#stop-record').disabled=true;
 try{if(r.recorder.state!=='inactive')r.recorder.stop();else await finalizeRecord(r)}
 catch(e){await finalizeRecord(r)}
}
async function finalizeRecord(r){
 if(r.finalized)return;r.finalized=true;
 stopTracks(r.capture.mic,r.capture.display);
 await r.capture.ctx.close().catch(()=>{});
 await r.pending.catch(()=>{});
 try{
  const rec=await getRecording(r.id);
  if(!rec)return;
  const status=rec.chunkCount>0?(r.failed?'interrupted':'saved'):'interrupted';
  await patchRecording(r.id,{duration:r.finalSeconds||0,status,peaks:r.peaks.slice(-500)});
  notify(status==='saved'?'Запись сохранена.':'Запись прервана; доступные фрагменты сохранены.',status==='saved'?'info':'error');
 }catch(e){notify('Ошибка завершения записи: '+e.message,'error')}
 if(state.capture===r){state.capture=null;state.recordingId=null}
 $('#audio-source').disabled=false;$('#start-record').hidden=false;$('#pause-record').hidden=true;$('#stop-record').hidden=true;
 $('#pause-record').disabled=false;$('#stop-record').disabled=false;$('#pause-record').innerHTML=`${icon('pause')} Пауза`;
 $('#record-saved').textContent='Данные сохраняются на этом устройстве';
 updateRecordUI();await refresh();go('library');
 const finished=state.records.find(x=>x.id===r.id);
 if(finished?.status==='saved'&&state.health?.groq&&state.health?.ffmpeg&&state.health?.ffprobe){
   void startTranscription(finished);
 }
}
function drawWave(){
 nativeFrame=0;
 const canvas=$('#record-wave'),c=canvas.getContext('2d'),r=state.capture;
 const dark=document.body.dataset.theme==='dark';
 const width=canvas.width,height=canvas.height;
 c.clearRect(0,0,width,height);
 const values=[];
 if(r&&!r.paused){
   let rms=0;
   if(r.native){rms=r.snapshot.connected&&r.snapshot.state==='recording'?Math.max(0,...Object.values(r.snapshot.levels||{}).map(level=>level.rms||0)):0}
   else{const a=new Uint8Array(r.capture.analyser.fftSize);r.capture.analyser.getByteTimeDomainData(a);for(const v of a){const f=(v-128)/128;rms+=f*f}rms=Math.sqrt(rms/a.length)}
   const db=rms>0?20*Math.log10(rms):-90;
   $('#level-fill').style.width=`${Math.max(0,Math.min(100,(db+65)/65*100))}%`;
   setText('#level-num',rms>0?`${Math.round(db)} dB`:'−∞ dB');
   r.peaks.push(Math.min(1,rms*5));if(r.peaks.length>500)r.peaks.shift();
   values.push(...r.peaks.slice(-90));
 }else {
   $('#level-fill').style.width='0%';setText('#level-num','−∞ dB');
   for(let i=0;i<90;i++)values.push(storageDetails().local||r?.paused?0:.045+Math.sin(i*1.71)**2*.07);
 }
 const count=90,gap=width/count,bar=3.8;
 c.fillStyle=dark?'rgba(237,237,238,.85)':'rgba(38,39,43,.82)';
 for(let i=0;i<count;i++){
   const v=values[Math.max(0,values.length-count+i)]??.035;
   const bh=Math.max(3,v*(height*.83));
   c.globalAlpha=i<count-20?.35+(i/count)*.5:1;
   c.fillRect(i*gap+gap/2-bar/2,(height-bh)/2,bar,bh);
 }
 c.globalAlpha=1;
 if(state.capture){if(!r?.native)updateRecordUI();nativeFrame=requestAnimationFrame(drawWave)}
}
async function startTranscription(rec){
 if(archiveOperation){notify('Дождитесь завершения операции с архивом.','error');return}
 if(!rec||rec.status==='recording'||!rec.size){notify('Нет доступного аудиофайла.','error');return}
 if(['queued','processing','uploading'].includes(rec.status)){go('jobs');return}
 const selection=captureSelection(rec.id,audioReview?.selected,settings);
 if(rec.status==='completed'){
  modal('Повторная транскрибация',`Вариант: ${selection.title}.\n\nЭто создаст новый платный запрос и заменит текущую расшифровку. Исходный звук останется на устройстве. Продолжить?`,
   [{text:'Повторить',primary:true,run:()=>uploadTranscription(rec,true,selection)}]);return;
 }
 if(!state.health?.groq||!state.health?.ffmpeg||!state.health?.ffprobe){
  if(storageDetails().local&&!state.health?.groq)pendingTranscriptionId=rec.id;
  modal(storageDetails().local&&!state.health?.groq?'Подключите распознавание':'Обработка пока недоступна',storageDetails().local?'Подключите Groq в настройках. Запись уже сохранена; после подключения можно продолжить с неё.':'Проверьте подключение Groq и обработчик аудио на сервере приложения.',
   [{text:'Открыть настройки',primary:true,run:()=>go('settings')}]);return;
 }
 const est=rec.duration?money((Math.max(10,rec.duration)/3600)*MODEL_PRICE*settings.rate):'определяется после анализа файла';
 modal('Отправить аудио в Groq?',`Вариант: ${selection.title}.\n\nАудио будет передано через сервер приложения в Groq для распознавания русской речи.\n\nОриентировочная стоимость: ${est}${rec.duration?' ₽':''} (фактическая сумма может отличаться).\n\nПодтвердите отправку, если участники встречи дали необходимые согласия.`,
  [{text:'Отправить и обработать',primary:true,run:()=>uploadTranscription(rec,false,selection)}]);
}
const inUpload=new Set();
async function jobFetch(route,options){const local=await localLibraryClient();return local?local.jobRequest(route,options):fetch(route,options)}
async function uploadTranscription(rec,force,selection){
 if(inUpload.has(rec.id))return;inUpload.add(rec.id);notify('Готовим аудио к обработке…');
 try{
  const clientKey=force?crypto.randomUUID().replace(/-/g,''):await selectionKey(rec.id,selection);
  await patchRecording(rec.id,{clientKey,status:'uploading',jobId:null,serverAcked:false,
    transcriptionStartedAt:new Date().toISOString()});
  await refresh();
  let data;
  if(storageDetails().local){const {title,...options}=selection;data=await submitLocalTranscription(rec.id,{clientKey,...options})}
  else{const blob=await getBlob(rec);
  const response=await jobFetch(`/api/jobs?profile=${encodeURIComponent(selection.profile)}`,{
    method:'POST',headers:{'Content-Type':rec.mime||'application/octet-stream','X-Client-Task-Key':clientKey,
      'X-Transcription-Prompt':encodeURIComponent(selection.prompt)},body:blob
  });
  data=await response.json();
  if(!response.ok)throw new Error(data.error||`Ошибка HTTP ${response.status}`);
  }
  await patchRecording(rec.id,{jobId:data.id,status:'queued',clientKey,job:{stage:'Ожидает обработки',completed:0,total:0}});
  await refresh();go('jobs');notify('Задание создано. Вы можете переключать разделы.');
 }catch(e){
  notify('Загрузка прервана. Проверим сервер при восстановлении связи: '+e.message,'error');
 }finally{inUpload.delete(rec.id);void pollJobs()}
}
async function pollJobs(){
 if(state.pollBusy||!navigator.onLine)return;state.pollBusy=true;
 try{
  let changed=false;
  for(const rec of state.records.filter(r=>r.status==='uploading'&&r.clientKey&&!r.jobId&&!inUpload.has(r.id))){
   try{
    const response=await jobFetch(`/api/jobs/by-key/${encodeURIComponent(rec.clientKey)}`,{cache:'no-store',signal:AbortSignal.timeout(7000)});
    if(response.ok){
     const job=await response.json();
     await patchRecording(rec.id,{jobId:job.id,status:'queued',job:{stage:'Задание восстановлено',completed:0,total:0}});changed=true;
    }else if(response.status===404){
     await patchRecording(rec.id,{status:'saved'});changed=true;
    }
   }catch{} // Network outage is not proof that the upload failed.
  }
  if(changed)await refresh();
  const pending=state.records.filter(r=>r.jobId&&(['queued','processing','failed','cancelled'].includes(r.status)||(r.status==='completed'&&!r.serverAcked)));
  changed=false;
  for(const r of pending){
   try{
    const res=await jobFetch(`/api/jobs/${encodeURIComponent(r.jobId)}`,{cache:'no-store',signal:AbortSignal.timeout(8000)});
    if(res.status===404){
      await patchRecording(r.id,{status:'failed',jobId:null,
        job:{stage:'Задание отсутствует на сервере. Аудио сохранено в браузере; можно создать новую транскрибацию.',error:'Сервер удалил или потерял задание'}});
      changed=true;continue;
    }
    if(!res.ok)continue;
    const job=await res.json();
    if(job.status==='completed'){
     if(r.status==='completed'&&(r.transcript||r.transcriptSummary)){
      const ack=await jobFetch(`/api/jobs/${r.jobId}/ack`,{method:'POST'}).catch(()=>null);
      if(ack?.ok||ack?.status===404){await patchRecording(r.id,{serverAcked:true});changed=true}
      continue;
     }
     const result=await jobFetch(`/api/jobs/${r.jobId}/result`);
     if(!result.ok)throw new Error('Результат ещё не получен');
     const data=await result.json();
     const segments=(data.segments?.length?data.segments:[{start:0,end:data.duration||r.duration||0,text:data.text||''}]).map((s,i)=>({
       start:s.start,end:s.end,text:s.text,original:s.text,id:i
     }));
     await patchRecording(r.id,{status:'completed',duration:data.duration||r.duration,
       completedAt:new Date().toISOString(),estimatedUSD:job.estimatedUSD||0,
       transcript:{segments,rawText:data.text,model:data.model},job:{stage:'Завершено',completed:job.total,total:job.total}});
     // Client has durably persisted transcript, so delete the server copy.
     const ack=await jobFetch(`/api/jobs/${r.jobId}/ack`,{method:'POST'}).catch(()=>null);
     if(ack?.ok||ack?.status===404)await patchRecording(r.id,{serverAcked:true});
     notify(`Расшифровка «${r.title}» готова`);changed=true;
    }else{
     const nextStatus=job.status;
     if(JSON.stringify(r.job)!==JSON.stringify({stage:job.stage,completed:job.completed,total:job.total,error:job.error})||
        r.status!==nextStatus||r.estimatedUSD!==job.estimatedUSD){
      await patchRecording(r.id,{status:nextStatus,estimatedUSD:job.estimatedUSD||0,
         job:{stage:job.stage,completed:job.completed,total:job.total,error:job.error}});changed=true;
     }
    }
   }catch{ /* unreachable jobs remain in local queue until server returns */ }
  }
  if(changed)await refresh();
 }finally{state.pollBusy=false}
}
async function retryJob(rec){
 if(!rec?.jobId)return;
 modal('Повторить обработку?',`Повторная отправка может привести к дополнительной оплате со стороны Groq. Успешно сохранённые на сервере сегменты будут повторно использованы.`,
  [{text:'Повторить',primary:true,run:async()=>{
   try{const r=await jobFetch(`/api/jobs/${rec.jobId}/retry`,{method:'POST'});const d=await r.json();if(!r.ok)throw new Error(d.error);await patchRecording(rec.id,{status:'queued'});await refresh()}
   catch(e){notify('Ошибка повтора: '+e.message,'error')}
  }}]);
}
async function cancelJob(rec){
 modal('Остановить обработку?',`Сохранённые аудиозаписи останутся в библиотеке. Уже обработанные Groq сегменты могут быть оплачены.`,
 [{text:'Остановить',primary:true,run:async()=>{try{await jobFetch(`/api/jobs/${rec.jobId}/cancel`,{method:'POST'});notify('Отмена запрошена');await pollJobs()}catch(e){notify('Ошибка отмены: '+e.message,'error')}}}]);
}
async function openRecord(id){
 const rec=state.records.find(r=>r.id===id);if(!rec)return;
 if(rec.status==='migrating'){modal('Перенос не завершён','Исходная запись сохранена в браузере. Откройте настройки и повторите перенос записей из браузера — MONO проверит уже скопированные фрагменты.',[{text:'Открыть настройки',primary:true,run:()=>go('settings')}]);return}
 if(rec.status==='completed'&&(rec.transcript||rec.transcriptSummary)||['saved','interrupted'].includes(rec.status)&&rec.size>0){go('editor',id);return}
 modal(rec.title,`Статус: ${statusLabel(rec)}\nДлительность: ${durationText(rec.duration)}\nРазмер: ${sizeText(rec.size||0)}\n\nИсходное аудио сохранено локально. Вы можете скачать оригинал или запустить транскрибацию.`,
 [{text:'Скачать аудио',run:()=>downloadAudio(rec)},{text:rec.jobId?'Открыть обработку':'Транскрибировать',primary:true,run:()=>rec.jobId?go('jobs'):startTranscription(rec)}]);
}
async function downloadAudio(rec){
 try{const native=rec.tracks?.some(track=>['mic','system'].includes(track.id));const name=rec.title.replace(/[\\/:*?"<>|]/g,'_').slice(0,80)+'.'+extensionForMime(native?'audio/flac':rec.mime),url=audioURL(rec);
  if(url){const a=document.createElement('a');a.href=url;a.download=name;a.click()}else downloadBlob(await getBlob(rec),name)}
 catch(e){notify('Не удалось получить аудио: '+e.message,'error')}
}
function extensionForMime(mime){if(mime?.includes('wav'))return 'wav';if(mime?.includes('mp4'))return 'm4a';if(mime?.includes('ogg'))return 'ogg';if(mime?.includes('mpeg'))return 'mp3';if(mime?.includes('flac'))return 'flac';return 'webm'}
function downloadBlob(blob,name){const url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),30000)}
function renameRecord(rec){
 modal('Название записи',`<label class="field-label" for="rename-input">Новое название</label><input id="rename-input" class="select" maxlength="130" value="${h(rec.title)}">`,
 [{text:'Сохранить',primary:true,run:async()=>{const name=$('#rename-input').value.trim();if(!name){notify('Название не может быть пустым','error');return}await patchRecording(rec.id,{title:name});await refresh()}}]);
}
function deleteRecord(rec){
 if(storageDetails().local){
  modal('Переместить в корзину?',`«${h(rec.title)}» исчезнет из библиотеки. Аудио и текст сохранятся в папке архива.`,[{text:'В корзину',primary:true,run:async()=>{
   const result=await removeRecording(rec.id);await refresh();
   const toast=document.createElement('div');toast.className='toast';toast.append('Запись в корзине. ');
   const undo=document.createElement('button');undo.className='btn btn-outline btn-small';undo.textContent='Восстановить';undo.onclick=async()=>{try{await restoreRecording(rec.id,result.version);await refresh();toast.remove()}catch(e){notify(e.message,'error')}};toast.append(undo);$('#toast-area').append(toast);
  }}]);return;
 }
 modal('Удалить запись?',`«${h(rec.title)}» будет удалена вместе с локальным аудио и транскриптом. Если запись отправлялась в Groq, приложение также удалит связанные временные файлы локального сервера.\n\nУдаление нельзя отменить.`,
 [{text:'Удалить безвозвратно',primary:true,run:async()=>{
   try{
     if(rec.jobId){
       const response=await jobFetch(`/api/jobs/${encodeURIComponent(rec.jobId)}`,{method:'DELETE'});
       if(!response.ok&&response.status!==404&&response.status!==202)throw new Error('Сервер не подтвердил удаление');
       if(response.status===202)notify('Удаление на сервере выполняется асинхронно.');
     }
     await removeRecording(rec.id);await refresh();notify('Локальная запись и доступные серверные копии удалены.');
   }catch(e){notify('Удаление отложено: '+e.message,'error')}
 }}]);
}
let saveEditPromise=Promise.resolve(),editorGeneration=0;
async function renderEditor(id){
 const generation=++editorGeneration;
 const rec=await getRecording(id,{transcript:!storageDetails().local});if(generation!==editorGeneration||state.editorId!==id||!rec)return;
 state.records=state.records.map(r=>r.id===id?rec:r);
 $('#editor-name').textContent=rec.title;$('#editor-date').textContent=fmtDate(rec.createdAt);
 $('#editor-duration').textContent=durationText(rec.duration);
 const hasTranscript=Boolean(rec.transcriptSummary||rec.transcript);$('#editor-segments-count').textContent=(rec.transcriptSummary?.segmentCount??rec.transcript?.segments?.length??0).toLocaleString('ru-RU');
 $('#editor-status').textContent=statusLabel(rec);
 $('#editor-heading').textContent=rec.title;
 $('#editor-helper').textContent=hasTranscript?'Исправления сохраняются автоматически на этом устройстве.':'Прослушайте запись перед расшифровкой. Аудио остаётся на компьютере до подтверждения отправки.';
 $('#copy-transcript').hidden=!hasTranscript;$('#export-transcript').hidden=!hasTranscript;$('#editor-transcribe').textContent=hasTranscript?'Расшифровать заново':'Расшифровать';$('#editor-transcribe').disabled=['recording','requesting','processing','queued','uploading'].includes(rec.status)||!rec.size;$('#editor-download').disabled=!rec.size;
 void renderEditorSegments(rec);
 if(state.playerURL)URL.revokeObjectURL(state.playerURL);
 state.playerURL=null;
 const audio=$('#audio-element');audio.pause();audio.removeAttribute('src');
 if(storageDetails().local){
  if(!audioReview){const host=document.createElement('section');host.setAttribute('aria-label','Подготовка и сравнение аудио');$('.editor-document-header').after(host);audioReview=new AudioReview({library:await localLibraryClient(),host,original:audio,play:media=>{if(!canAudition()||!mediaInterlock)return Promise.reject(new Error('Завершите запись перед прослушиванием.'));return mediaInterlock.play(media)},onError:error=>notify(error.message,'error'),onPlayer:value=>{setText('#player-now',shortTime(value.time));setText('#player-total',shortTime(value.duration));$('#player-seek').value=String(value.duration?Math.floor(1000*value.time/value.duration):0);const button=$('#player-toggle'),playing=String(value.playing);if(button.dataset.playing!==playing){button.dataset.playing=playing;button.innerHTML=icon(value.playing?'pause':'play');button.setAttribute('aria-label',value.playing?'Приостановить воспроизведение':'Воспроизвести запись')}}})}
  audioReview.captureState(nativeController?.snapshot||{connected:false});audioReview.open(rec,audioURL(rec));return;
 }
 try{const url=audioURL(rec);if(url){audio.src=url}else{const blob=await getBlob(rec);if(state.editorId!==id)return;state.playerURL=URL.createObjectURL(blob);audio.src=state.playerURL}audio.load();
 }catch(e){notify('Оригинальное аудио недоступно: '+e.message,'error')}
 $('#player-total').textContent=shortTime(rec.duration);
 $('#player-now').textContent='00:00';$('#player-seek').value='0';$('#player-toggle').innerHTML=icon('play');
}
let pageGeneration=0;
async function renderEditorSegments(rec){
 const generation=++pageGeneration;
 const segments=rec.transcript?.segments||[],search=$('#editor-search').value.trim().toLowerCase();
 const filtered=segments.map((s,i)=>({s,i})).filter(x=>!search||x.s.text.toLowerCase().includes(search));
 const pageSize=65;let total=filtered.length,visible;
 if(storageDetails().local){
  try{await flushEdits();let page=await transcriptPage(rec.id,{offset:state.editorPage*pageSize,limit:pageSize,query:search});if(generation!==pageGeneration||state.editorId!==rec.id)return;
   total=page.total;const lastPage=Math.max(0,Math.ceil(total/pageSize)-1);
   if(state.editorPage>lastPage){state.editorPage=lastPage;page=await transcriptPage(rec.id,{offset:lastPage*pageSize,limit:pageSize,query:search});if(generation!==pageGeneration)return}
   visible=page.segments.map(({index,...s})=>({s,i:index}));
  }catch(e){if(generation===pageGeneration)notify(e.message,'error');return}
 }
 const pageCount=Math.max(1,Math.ceil(total/pageSize));
 state.editorPage=Math.min(state.editorPage,pageCount-1);
 visible??=filtered.slice(state.editorPage*pageSize,(state.editorPage+1)*pageSize);
 state.visibleSegments=new Map(visible.map(({s,i})=>[i,s]));
 $('#editor-content').innerHTML=visible.length?visible.map(({s,i})=>
 `<div class="transcript-paragraph"><button class="segment-time" data-seek="${Number(s.start)||0}" title="Прослушать с этого места">${shortTime(s.start)}</button><textarea class="segment-edit ${search?'match':''}" rows="${Math.min(5,Math.max(2,Math.ceil(s.text.length/85)))}" data-segment="${i}" aria-label="Фрагмент текста ${i+1}">${h(s.text)}</textarea></div>`).join(''):`<div class="empty-state"><strong>${!rec.transcript&&!rec.transcriptSummary?'Запись готова к прослушиванию':'Нет совпадений'}</strong><p>${!rec.transcript&&!rec.transcriptSummary?'Запустите плеер, затем при необходимости создайте расшифровку.':'Попробуйте другой поисковый запрос.'}</p></div>`;
 $('#editor-pagination').innerHTML=pageCount>1?`<button data-page="-1" ${state.editorPage===0?'disabled':''}>← Назад</button><span>${state.editorPage+1} / ${pageCount}</span><button data-page="1" ${state.editorPage>=pageCount-1?'disabled':''}>Далее →</button>`:'';
}
function storeEdit(id,index,text){
 const key=id+':'+index;
 saveEditPromise=saveEditPromise.then(async()=>{
  try{await saveSegmentEdit(id,index,text);state.failedEdits.delete(key);if(state.editorId===id)$('#editor-status').textContent='Сохранено'}
  catch(e){state.failedEdits.set(key,{id,index,text});if(state.editorId===id)$('#editor-status').textContent='Не сохранено';notify('Ошибка автосохранения: '+e.message,'error')}
 });
 return saveEditPromise;
}
async function flushEdits(){for(const [key,item] of state.pendingEdits){clearTimeout(item.timer);state.pendingEdits.delete(key);void storeEdit(item.id,item.index,item.text)}await saveEditPromise;if(state.failedEdits.size)throw new Error('Есть несохранённые правки. Сохраните их перед продолжением.')}
function editSegment(el){
 const id=state.editorId,index=Number(el.dataset.segment),text=el.value;
 if(!state.visibleSegments.has(index))return;
 state.visibleSegments.get(index).text=text;
 const key=id+':'+index;clearTimeout(state.pendingEdits.get(key)?.timer);
 const item={id,index,text,timer:setTimeout(()=>{state.pendingEdits.delete(key);void storeEdit(id,index,text)},300)};
 state.pendingEdits.set(key,item);$('#editor-status').textContent='Сохраняем…';
}
async function copyText(){
 try{await flushEdits();const r=await getRecording(state.editorId);if(!r?.transcript)return;await navigator.clipboard.writeText(r.transcript.segments.map(s=>s.text).join('\n\n'));notify('Текст скопирован')}
 catch(e){notify('Не удалось скопировать текст: '+e.message,'error')}
}
function srtTime(t,sep=','){
 const whole=Math.max(0,Math.round((Number(t)||0)*1000));
 const hh=Math.floor(whole/3600000),mm=Math.floor(whole%3600000/60000),
       ss=Math.floor(whole%60000/1000),ms=whole%1000;
 return `${String(hh).padStart(2,'0')}:${String(mm).padStart(2,'0')}:${String(ss).padStart(2,'0')}${sep}${String(ms).padStart(3,'0')}`;
}
function xmlText(s){return String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&apos;'}[c]))}
function crc32(bytes){let crc=-1;for(const b of bytes){crc^=b;for(let j=0;j<8;j++)crc=crc&1?(crc>>>1)^0xedb88320:crc>>>1}return (crc^-1)>>>0}
function zip(entries){
 const out=[],central=[];let offset=0;const enc=new TextEncoder();
 const u16=(view,n,p)=>view.setUint16(p,n,true),u32=(view,n,p)=>view.setUint32(p,n,true);
 for(const [name,content] of entries){
  const bytes=enc.encode(content),fn=enc.encode(name),checksum=crc32(bytes),local=new Uint8Array(30+fn.length),v=new DataView(local.buffer);
  u32(v,0x04034b50,0);u16(v,20,4);u16(v,0,6);u16(v,0,8);u32(v,checksum,14);u32(v,bytes.length,18);u32(v,bytes.length,22);u16(v,fn.length,26);local.set(fn,30);
  out.push(local,bytes);
  const cent=new Uint8Array(46+fn.length),w=new DataView(cent.buffer);
  u32(w,0x02014b50,0);u16(w,20,4);u16(w,20,6);u32(w,checksum,16);u32(w,bytes.length,20);u32(w,bytes.length,24);u16(w,fn.length,28);u32(w,offset,42);cent.set(fn,46);
  central.push(cent);offset+=local.length+bytes.length;
 }
 const centralSize=central.reduce((n,c)=>n+c.length,0),end=new Uint8Array(22),v=new DataView(end.buffer);
 u32(v,0x06054b50,0);u16(v,entries.length,8);u16(v,entries.length,10);u32(v,centralSize,12);u32(v,offset,16);
 return new Blob([...out,...central,end],{type:'application/vnd.openxmlformats-officedocument.wordprocessingml.document'});
}
function docxBlob(paragraphs){
 const p=paragraphs.map(line=>`<w:p><w:r><w:rPr><w:rFonts w:ascii="Arial" w:hAnsi="Arial" w:eastAsia="Arial"/></w:rPr><w:t xml:space="preserve">${xmlText(line)}</w:t></w:r></w:p>`).join('');
 const doc=`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${p}<w:sectPr/></w:body></w:document>`;
 return zip([
  ['[Content_Types].xml','<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>'],
  ['_rels/.rels','<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>'],
  ['word/document.xml',doc]
 ]);
}
function exportRecord(){
 const rec=state.records.find(r=>r.id===state.editorId);if(!rec||!(rec.transcript||rec.transcriptSummary))return;
 modal('Экспорт расшифровки',`<label class="field-label" for="export-format">Формат файла</label><select class="select" id="export-format"><option value="txt">TXT — обычный текст</option><option value="md">Markdown</option><option value="docx">DOCX — документ Word</option><option value="json">JSON — данные и метки</option><option value="srt">SRT — субтитры</option><option value="vtt">VTT — субтитры</option><option value="pdf">PDF — через печать браузера</option></select><label class="field-label" for="export-version" style="margin-top:18px">Версия текста</label><select class="select" id="export-version"><option value="edited">Отредактированный</option><option value="original">Исходный результат модели</option></select>`,
 [{text:'Экспортировать',primary:true,run:async()=>{const format=$('#export-format').value,version=$('#export-version').value;await doExport(rec,format,version)}}]);
}
async function doExport(rec,format,version){
 // Open the print window synchronously in the originating click gesture.
 const printWindow=format==='pdf'?window.open('','_blank'):null;
 if(format==='pdf'&&!printWindow){notify('Разрешите всплывающие окна для печати PDF.','error');return}
 await flushEdits();
 const latest=await getRecording(rec.id);
 if(!latest?.transcript){printWindow?.close();notify('Транскрипт недоступен','error');return}
 const segments=latest.transcript.segments.map(s=>({...s,text:version==='original'?s.original??s.text:s.text}));
 const text=segments.map(s=>s.text).join('\n\n');
 let blob;
 if(format==='txt')blob=new Blob([text],{type:'text/plain;charset=utf-8'});
 else if(format==='md')blob=new Blob([`# ${rec.title}\n\n${text}\n`],{type:'text/markdown;charset=utf-8'});
 else if(format==='json')blob=new Blob([JSON.stringify({title:rec.title,model:latest.transcript.model,duration:rec.duration,segments},null,2)],{type:'application/json;charset=utf-8'});
 else if(format==='srt'||format==='vtt'){
  const rows=segments.map((s,i)=>`${format==='srt'?i+1+'\n':''}${srtTime(s.start,format==='vtt'?'.':',')} --> ${srtTime(Math.max(s.end,s.start+.1),format==='vtt'?'.':',')}\n${s.text}\n`).join('\n');
  blob=new Blob([format==='vtt'?'WEBVTT\n\n'+rows:rows],{type:'text/plain;charset=utf-8'});
 }else if(format==='docx')blob=docxBlob([rec.title,...segments.map(s=>s.text)]);
 else if(format==='pdf'){
  const win=printWindow;
  win.document.write(`<html lang="ru"><head><meta charset="utf-8"><title>${h(rec.title)}</title><style>body{max-width:800px;margin:60px auto;padding:0 24px;font:16px/1.8 Arial;color:#111}h1{font-size:30px}p{margin:0 0 18px}@media print{body{margin:0}}</style></head><body><h1>${h(rec.title)}</h1>${segments.map(s=>`<p>${h(s.text)}</p>`).join('')}</body></html>`);
  win.document.close();win.focus();setTimeout(()=>win.print(),350);return;
 }
 if(blob){downloadBlob(blob,rec.title.replace(/[\\/:*?"<>|]/g,'_').slice(0,80)+'.'+format);notify('Файл подготовлен к скачиванию')}
}
async function exportPortableLibrary(){
 if(storageDetails().local){await runLibraryTransfer('export');return}
 if(!window.showDirectoryPicker){
  notify('Экспорт всей библиотеки требует Chromium/Edge с поддержкой выбора папки.','error');
  return;
 }
 // Must be the first awaited operation: browsers require a genuine user gesture.
 let directory;
 try{directory=await window.showDirectoryPicker({mode:'readwrite'})}
 catch(e){if(e?.name!=='AbortError')notify('Не удалось выбрать папку для копии.','error');return}
 const stamp=new Date().toISOString().replace(/[:.]/g,'-');
 const backup=await directory.getDirectoryHandle(`MONO_BACKUP_${stamp}`,{create:true});
 const source=await listRecordings();
 const records=source.filter(r=>r.status!=='recording');
 const manifest={format:'mono-portable-v1',createdAt:new Date().toISOString(),
   version:'0.4.0',records:[]};
 try{
  for(const rec of records){
   if(!/^[a-f0-9-]{36}$/i.test(rec.id))throw new Error('Некорректный ID записи');
   const kind=audioExtension(rec.mime);
   const name=`${rec.id}.${kind}`;
   const fileHandle=await backup.getFileHandle(name,{create:true});
   const writer=await fileHandle.createWritable();
   try{await streamRecordingAudio(rec,writer);await writer.close()}
   catch(e){await writer.abort().catch(()=>{});throw e}
   manifest.records.push({audio:name,record:rec});
  }
  const handle=await backup.getFileHandle('manifest.json',{create:true});
  const writer=await handle.createWritable();
  await writer.write(JSON.stringify(manifest,null,2));await writer.close();
  notify(`Резервная копия готова: ${manifest.records.length} записей.`);
 }catch(e){
  notify('Копия не завершена: '+String(e.message||e).slice(0,140),'error');
 }
}
async function importPortableLibrary(){
 if(storageDetails().local){await runLibraryTransfer('import');return}
 if(!window.showDirectoryPicker){
  notify('Импорт библиотеки требует Chromium/Edge с поддержкой выбора папки.','error');
  return;
 }
 let directory;
 try{directory=await window.showDirectoryPicker({mode:'read'})}
 catch(e){if(e?.name!=='AbortError')notify('Не удалось открыть папку.','error');return}
 try{
  const file=await (await directory.getFileHandle('manifest.json')).getFile();
  if(file.size>25*1024*1024)throw new Error('Манифест слишком большой');
  const manifest=JSON.parse(await file.text());
  if(manifest.format!=='mono-portable-v1'||!Array.isArray(manifest.records)||
     manifest.records.length>10000)throw new Error('Неподдерживаемый формат копии');
  let restored=0;
  for(const item of manifest.records){
   if(!validBackupItem(item))
     throw new Error('Неверная запись в манифесте');
   const audio=await (await directory.getFileHandle(item.audio)).getFile();
   if(audio.size<1)throw new Error('Аудиофайл пуст');
   const rec=portableRecord(item.record,crypto.randomUUID());
   await saveImportedRecording(rec,audio);
   restored++;
  }
  await refresh();
  notify(`Импортировано записей: ${restored}. Исходная библиотека не изменена.`);
 }catch(e){notify('Импорт остановлен: '+String(e.message||e).slice(0,140),'error')}
}

async function checkHealth(){
 try{
  const res=await fetch('/api/health',{signal:AbortSignal.timeout(4500),cache:'no-store'});if(!res.ok)throw new Error('Сервер недоступен');
  state.health=await res.json();
  $('#settings-health').textContent=`FFmpeg: ${state.health.ffmpeg?'доступен':'нет'} · FFprobe: ${state.health.ffprobe?'доступен':'нет'} · Groq: ${state.health.groq?'ключ задан':'не настроен'}`;
 }catch{
  state.health=null;$('#settings-health').textContent='Сервер недоступен. Запись, локальная библиотека и редактор работают автономно.';
 }
}
function wire(){
 $$('.nav-link[data-view]').forEach(b=>b.addEventListener('click',()=>go(b.dataset.view)));
 document.addEventListener('click',e=>{
  const goButton=e.target.closest('[data-go]');if(goButton){go(goButton.dataset.go);return}
  const open=e.target.closest('[data-open]');if(open){void openRecord(open.dataset.open);return}
  const renamed=e.target.closest('[data-rename]');if(renamed){renameRecord(state.records.find(r=>r.id===renamed.dataset.rename));return}
  const deleted=e.target.closest('[data-delete]');if(deleted){deleteRecord(state.records.find(r=>r.id===deleted.dataset.delete));return}
  const restored=e.target.closest('[data-restore]');if(restored){void restoreRecording(restored.dataset.restore,Number(restored.dataset.version)).then(refresh).catch(error=>notify(error.message,'error'));return}
  const retry=e.target.closest('[data-retry]');if(retry){void retryJob(state.records.find(r=>r.id===retry.dataset.retry));return}
  const cancel=e.target.closest('[data-cancel]');if(cancel){void cancelJob(state.records.find(r=>r.id===cancel.dataset.cancel));return}
  const seek=e.target.closest('[data-seek]');if(seek){if(!canAudition())return;if(audioReview){void audioReview.player.seek(Number(seek.dataset.seek)||0).then(()=>audioReview.player.play()).catch(error=>{if(error.name!=='AbortError')notify(error.message,'error')});return}const audio=$('#audio-element');audio.currentTime=Number(seek.dataset.seek)||0;void playAudition(audio);return}
  const page=e.target.closest('[data-page]');if(page){
    state.editorPage+=Number(page.dataset.page);
    const rec=state.records.find(r=>r.id===state.editorId);if(rec)renderEditorSegments(rec);
  }
 });
 $('#theme-toggle').onclick=()=>{settings.theme=document.body.dataset.theme==='dark'?'light':'dark';saveSettings();applyTheme();$('#setting-theme').value=settings.theme;syncControls()};
 for(const id of ['hero-import','record-import','library-import'])$('#'+id).onclick=()=>withInput(importFile);
 $('#start-record').onclick=beginRecord;$('#pause-record').onclick=pauseRecord;$('#stop-record').onclick=endRecord;
 for(const id of ['library-search','library-filter','library-sort'])$('#'+id).addEventListener(id==='library-search'?'input':'change',renderLibrary);
 $('#editor-search').addEventListener('input',()=>{state.editorPage=0;const rec=state.records.find(r=>r.id===state.editorId);if(rec)renderEditorSegments(rec)});
 $('#editor-content').addEventListener('input',e=>{if(e.target.matches('.segment-edit'))editSegment(e.target)});
 $('#copy-transcript').onclick=copyText;$('#export-transcript').onclick=exportRecord;
 $('#editor-transcribe').onclick=()=>{const rec=state.records.find(r=>r.id===state.editorId);if(rec)void startTranscription(rec)};
 $('#editor-download').onclick=()=>{const rec=state.records.find(r=>r.id===state.editorId);if(rec)void downloadAudio(rec)};
 $('#player-toggle').onclick=async()=>{if(audioReview){if(audioReview.player.snapshot.playing)audioReview.player.pause();else if(canAudition())await audioReview.player.play().catch(error=>{if(error.name!=='AbortError')notify(error.message,'error')});return}const a=$('#audio-element');if(!a.src)return notify('Аудиофайл недоступен','error');if(a.paused)await playAudition(a);else a.pause()};
 const a=$('#audio-element');
 a.addEventListener('play',()=>{if(audioReview)return;if(!canAudition()){a.pause();return}$('#player-toggle').innerHTML=icon('pause');$('#player-toggle').setAttribute('aria-label','Приостановить воспроизведение')});
 a.addEventListener('pause',()=>{if(audioReview)return;$('#player-toggle').innerHTML=icon('play');$('#player-toggle').setAttribute('aria-label','Воспроизвести запись')});
 a.addEventListener('timeupdate',()=>{if(audioReview)return;$('#player-now').textContent=shortTime(a.currentTime);$('#player-seek').value=String(a.duration&&Number.isFinite(a.duration)?Math.floor(1000*a.currentTime/a.duration):0)});
 a.addEventListener('loadedmetadata',()=>{if(!audioReview)$('#player-total').textContent=shortTime(a.duration)});
 $('#player-seek').oninput=e=>{if(audioReview){void audioReview.player.seek(audioReview.player.snapshot.duration*Number(e.target.value)/1000).catch(error=>{if(error.name!=='AbortError')notify(error.message,'error')})}else if(Number.isFinite(a.duration))a.currentTime=a.duration*Number(e.target.value)/1000};
 $('#player-speed').onchange=e=>{if(audioReview)audioReview.player.setRate(Number(e.target.value));else a.playbackRate=Number(e.target.value)};
 $('#setting-theme').value=settings.theme;$('#setting-theme').onchange=e=>{settings.theme=e.target.value;saveSettings();applyTheme()};
 $('#setting-profile').value=settings.profile;$('#setting-profile').onchange=e=>{settings.profile=e.target.value;saveSettings()};
 $('#setting-prompt').value=settings.prompt;$('#setting-prompt').oninput=e=>{settings.prompt=e.target.value;saveSettings()};
 $('#setting-rate').value=settings.rate;$('#setting-rate').onchange=e=>{settings.rate=Math.max(1,Math.min(1000,Number(e.target.value)||83.0784));saveSettings();renderDashboard()};
 $('#refresh-health').onclick=checkHealth;
 $('#export-library').onclick=()=>{void exportPortableLibrary()};
 $('#import-library').onclick=()=>{void importPortableLibrary()};
 $('#move-library').onclick=()=>{void runLibraryTransfer('move').catch(e=>notify(e.message,'error'))};
 $('#migrate-library').onclick=()=>{modal('Перенести записи из браузера?','MONO скопирует доступные в этом профиле записи в папку архива и проверит их. Исходные записи останутся в браузере. Если использовался другой браузер или профиль, откройте его и экспортируйте библиотеку.',[{text:'Перенести записи',primary:true,run:runLegacyMigration}])};
 $('#request-persistence').onclick=async()=>{
  if(storageDetails().local){showLibrarySetup();return}
  if(!navigator.storage?.persist)return notify('Браузер не поддерживает запрос постоянного хранения.','error');
  const ok=await navigator.storage.persist();$('#storage-persistence').textContent=ok?'Постоянное хранение предоставлено':'Браузер не предоставил постоянное хранение';notify(ok?'Хранение защищено от автоматического вытеснения.':'Постоянное хранение не предоставлено.')
 };
 $('#modal-close').onclick=closeModal;$('#modal').onclick=e=>{if(e.target===$('#modal'))closeModal()};
 // Closing the window ends a browser-microphone recording; ask first.
 addEventListener('beforeunload',e=>{if(captureActive(nativeController?.snapshot)||state.capture){e.preventDefault();e.returnValue=''}});
 document.addEventListener('keydown',e=>{
  if(!$('#modal').hidden||e.defaultPrevented||state.view!=='editor')return;
  const ctrl=e.ctrlKey||e.metaKey,typing=e.target?.closest?.('input,textarea,select,[contenteditable]:not([contenteditable="false"])');
  const toggle=ctrl&&e.code==='Space'||e.key==='F9'||!typing&&!ctrl&&!e.altKey&&e.code==='Space';
  const jump=e.altKey&&!ctrl&&(e.key==='ArrowLeft'?-5:e.key==='ArrowRight'?5:0);
  if(!toggle&&!jump)return;
  e.preventDefault();void transcriptHotkey(toggle?'toggle':jump).catch(error=>{if(error?.name!=='AbortError')notify(error.message||'Не удалось управлять воспроизведением.','error')});
 });
 document.addEventListener('keydown',e=>{
  if($('#modal').hidden)return;
  if(e.key==='Escape'){closeModal();return}
  if(e.key==='Tab'){
   const focusable=[...$('#modal').querySelectorAll('button:not([disabled]),input:not([disabled]),select:not([disabled])')];
   const first=focusable[0],last=focusable.at(-1);if(!first)return;
   if(e.shiftKey&&document.activeElement===first){e.preventDefault();last.focus()}
   else if(!e.shiftKey&&document.activeElement===last){e.preventDefault();first.focus()}
  }
 });
 window.addEventListener('hashchange',renderRoute);
 window.addEventListener('beforeunload',e=>{if(state.capture||state.pendingEdits.size||state.failedEdits.size){e.preventDefault();e.returnValue=''}});
 window.addEventListener('online',()=>{void checkHealth();void pollJobs()});
 window.addEventListener('offline',checkHealth);
 let dragDepth=0;
 document.addEventListener('dragenter',e=>{if(e.dataTransfer?.types.includes('Files')){dragDepth++;document.body.classList.add('drag-over')}});
 document.addEventListener('dragleave',()=>{dragDepth=Math.max(0,dragDepth-1);if(!dragDepth)document.body.classList.remove('drag-over')});
 document.addEventListener('dragover',e=>{if(e.dataTransfer?.types.includes('Files'))e.preventDefault()});
 document.addEventListener('drop',e=>{e.preventDefault();dragDepth=0;document.body.classList.remove('drag-over');if(e.dataTransfer?.files?.length)void importFile(e.dataTransfer.files[0])});
 matchMedia('(prefers-color-scheme: dark)').addEventListener('change',()=>{if(settings.theme==='system')applyTheme()});
}
async function init(){
 applyTheme();wire();enhanceUI();await openDB();
 const local=await localLibraryClient();if(local)credentialForm=mountCredentials($('#groq-credentials'),{client:new CredentialsClient(local),onChange:value=>{$('#resume-transcription').hidden=!value.configured||!pendingTranscriptionId;void checkHealth()}});else $('#groq-settings-card').hidden=true;
 $('#resume-transcription').onclick=async()=>{const id=pendingTranscriptionId;if(!id)return;await checkHealth();const rec=state.records.find(r=>r.id===id);if(rec){pendingTranscriptionId=null;$('#resume-transcription').hidden=true;go('editor',id);void startTranscription(rec)}};
 const storage=storageDetails(),available=!storage.local||storage.libraryAvailable;
 const orphaned=available?await listRecordings():[];
 for(const r of orphaned.filter(r=>!storage.local&&r.status==='recording')){
  await patchRecording(r.id,{status:'interrupted',duration:r.duration||Math.max(0,((r.lastChunkAt||Date.parse(r.createdAt))-Date.parse(r.createdAt))/1000)});
 }
 if(available)await refresh();renderRoute({preserveDrawer:true});await checkHealth();
 updateStorageSettings();
 if(local&&available)await initializeNative(local).catch(error=>notify(error.message,'error'));
 if(local)await showSetup();
 if(storage.transfer?.state==='running')void runLibraryTransfer(null,storage.transfer);
 else if(state.view!=='settings'&&(storage.transfer||storage.transferRecoveryError)){
  const notice=document.createElement('div');notice.className='toast archive-progress archive-recovery-notice';notice.setAttribute('role','status');
  const text=document.createElement('span');text.textContent=storage.transferRecoveryError?'Не удалось прочитать журнал копирования. Исходный архив сохранён.':'Копирование не завершено. Его можно продолжить в настройках.';
  const button=document.createElement('button');button.className='btn btn-outline btn-small';button.textContent='Открыть настройки';button.onclick=()=>{go('settings');$('#transfer-recovery')?.scrollIntoView({block:'center'});notice.remove()};notice.append(text,button);$('#toast-area').append(notice);
 }
 void pollJobs();setInterval(()=>{if(!document.hidden)void pollJobs()},3500);document.addEventListener('visibilitychange',()=>{if(!document.hidden)void pollJobs()});
 if('serviceWorker' in navigator){navigator.serviceWorker.register('/sw.js').catch(()=>{})}
}
function updateStorageSettings(){
 const storage=storageDetails();if(!storage.local)return;
 if(!$('#library-filter option[value="trash"]')){const option=document.createElement('option');option.value='trash';option.textContent='Корзина';$('#library-filter').append(option);syncControls()}
 $('#request-persistence').textContent=storage.libraryConfigured?'Подключить папку архива':'Выбрать папку для записей';
 $('#storage-persistence').textContent=storage.libraryPath||'Аудио и расшифровки будут сохранены в выбранной папке.';
 $('#move-library').hidden=!storage.libraryAvailable;
 $('#migrate-library').hidden=false;
 let recovery=$('#transfer-recovery');
 if(!recovery){recovery=document.createElement('article');recovery.id='transfer-recovery';recovery.className='glass settings-card';recovery.innerHTML='<h2>Незавершённое копирование</h2><p class="field-hint"></p><div class="inline-actions"><button type="button" class="btn btn-primary btn-small" data-transfer-resume>Продолжить</button><button type="button" class="btn btn-outline btn-small" data-transfer-cancel>Остановить копирование</button></div>';$('#view-settings .settings-grid').prepend(recovery)}
 const pending=storage.transfer;recovery.hidden=!pending&&!storage.transferRecoveryError;
 if(recovery.hidden)document.querySelectorAll('.archive-recovery-notice').forEach(notice=>notice.remove());
 recovery.querySelector('p').textContent=storage.transferRecoveryError?'Не удалось прочитать состояние прежней операции. Исходный архив и частичная копия сохранены. Завершите прежнюю операцию, чтобы начать копирование заново.':pending?.state==='running'?'Копирование продолжается. Можно посмотреть ход операции.':'MONO проверит исходный архив и уже скопированные файлы. Если данные изменились, продолжение будет остановлено. Исходная папка сохранена.';
 const resume=recovery.querySelector('[data-transfer-resume]'),cancel=recovery.querySelector('[data-transfer-cancel]');resume.hidden=!pending&&!storage.transferRecoveryError;cancel.hidden=!pending;
 resume.disabled=cancel.disabled=archiveOperation;resume.textContent=storage.transferRecoveryError?'Завершить прежнюю операцию':pending?.state==='running'?'Показать ход':'Продолжить';
 resume.onclick=()=>storage.transferRecoveryError?modal('Завершить прежнюю операцию?','Записи и частичная копия останутся на месте. MONO отдельно сохранит сведения о сбое. После этого можно будет начать копирование заново.',[{text:'Завершить прежнюю операцию',primary:true,run:async()=>{await recoverLibraryTransfer();await refreshStorageStatus();updateStorageSettings();notify('Можно начать копирование заново. Записи сохранены.')}}]):void runLibraryTransfer(null,pending);
 cancel.onclick=()=>modal('Остановить копирование?','Исходный архив и частичная копия останутся на месте. После остановки можно начать новую операцию.',[{text:'Остановить копирование',run:async()=>{await cancelLibraryTransfer(pending.id);await refreshStorageStatus();updateStorageSettings()}}]);
}
async function runLegacyMigration(){
 if(archiveOperation||state.capture)throw new Error('Дождитесь сохранения текущей записи.');
 archiveOperation=true;const cancellation=new AbortController(),toast=document.createElement('div'),label=document.createElement('span'),cancel=document.createElement('button');
 toast.className='toast archive-progress';toast.setAttribute('role','status');label.textContent='Ищем записи в этом браузере…';cancel.className='btn btn-outline btn-small';cancel.textContent='Отменить';cancel.onclick=()=>{cancellation.abort();cancel.disabled=true};toast.append(label,cancel);$('#toast-area').append(toast);
 try{const result=await migrateLegacy({signal:cancellation.signal,onProgress:progress=>{label.textContent=`Переносим «${progress.title}»${progress.totalBytes?`: ${Math.min(100,Math.round(100*progress.bytes/progress.totalBytes))}%`:'…'}`}});await refresh();notify(result.copied||result.verified?`Перенесено: ${result.copied}. Повторно проверено: ${result.verified}.${result.skipped?' Активные записи пропущены.':''}`:'В этом профиле браузера сохранённых записей не найдено. Исходный профиль можно открыть отдельно и экспортировать библиотеку.')}
 catch(error){await refresh();notify(error.name==='AbortError'?'Перенос отменён. Исходные записи в браузере сохранены.':error.message,'error')}
 finally{archiveOperation=false;toast.remove()}
}
let archiveOperation=false;
async function runLibraryTransfer(kind,existing=null){
 if(archiveOperation||state.capture||inUpload.size){notify('Дождитесь сохранения текущей записи.','error');return}
 await flushEdits();archiveOperation=true;
 updateStorageSettings();
 const controls=['start-record','hero-import','record-import','library-import','export-library','import-library','move-library','request-persistence'].map(id=>$('#'+id));
 const disabled=controls.map(el=>el.disabled);controls.forEach(el=>el.disabled=true);
 const toast=document.createElement('div');toast.className='toast archive-progress';toast.setAttribute('role','status');
 const label=document.createElement('span'),cancel=document.createElement('button');cancel.className='btn btn-outline btn-small';cancel.textContent='Отменить';
 const pickerCancellation=new AbortController();cancel.onclick=()=>{cancel.disabled=true;pickerCancellation.abort()};
 label.textContent='Выберите папку в системном окне…';toast.append(label,cancel);$('#toast-area').append(toast);
 try{
  let operation;
  if(existing){kind=existing.kind;operation=existing.state==='running'?await libraryTransferStatus(existing.id):await resumeLibraryTransfer(existing.id)}
  else{const choice=await chooseLibraryFolder({export:'backup',import:'import',move:'move'}[kind],{signal:pickerCancellation.signal});if(choice.cancelled)return;operation=await startLibraryTransfer(kind,choice.choiceId)}
  label.textContent='Проверяем архив…';
  cancel.onclick=()=>{cancel.disabled=true;void cancelLibraryTransfer(operation.id).catch(e=>notify(e.message,'error'))};
  while(operation.state==='running'){
   const progress=operation.totalBytes?Math.min(100,Math.round(100*operation.copiedBytes/operation.totalBytes)):null;
   label.textContent=operation.phase==='verifying'?'Проверяем целостность копии…':operation.phase==='checking'?'Проверяем архив…':operation.phase==='converting'?'Подготавливаем прежнюю копию…':`Копируем записи${progress===null?'…':`: ${progress}%`}`;
   await new Promise(resolve=>setTimeout(resolve,350));operation=await libraryTransferStatus(operation.id);
  }
  if(operation.state==='cancelled'){notify('Копирование отменено. Исходный архив сохранён.');return}
  if(operation.state!=='completed')throw new Error(operation.errorCode==='TRANSFER_SOURCE_CHANGED'?'Исходный архив изменился. Остановите прежнее копирование и начните новую операцию.':operation.errorCode==='TRANSFER_CONFLICT'?'Содержимое папки копии отличается от ожидаемого. Исходные данные сохранены.':operation.errorCode==='BACKUP_CHECKSUM'?'Копия не прошла проверку целостности. Исходные данные сохранены.':'Копирование не завершено. Исходный архив сохранён.');
  await refreshStorageStatus();updateStorageSettings();await refresh();notify(kind==='move'?'Архив перенесён. Исходная папка сохранена.':kind==='import'?`Восстановлено записей: ${operation.result.records}.`:`Резервная копия готова: ${operation.result.records} записей.`);
  if(operation.cleanupPending)notify('Копия проверена, но очистка временных файлов не завершена. Проверьте доступность диска перед следующим копированием.','error');
 }catch(e){notify(e.message,'error')}
 finally{toast.remove();controls.forEach((el,i)=>el.disabled=disabled[i]);archiveOperation=false;await refreshStorageStatus().then(updateStorageSettings).catch(error=>notify(error.message,'error'))}
}
function showLibrarySetup(){
 const storage=storageDetails();
 modal(storage.libraryConfigured?'Подключите ваш архив':'Место для ваших записей',storage.libraryConfigured?'Папка архива сейчас недоступна. Подключите диск или выберите папку, в которой уже хранятся ваши записи.':'MONO сохраняет аудио и расшифровки в обычной папке на компьютере. Оставьте папку «Документы / MONO Library» или выберите свою.',[
  {text:'Выбрать папку',run:async()=>{const choice=await chooseLibraryFolder(storage.libraryConfigured?'open':'create');if(choice.cancelled)return;await configureLibrary({choiceId:choice.choiceId});updateStorageSettings();await refresh();await initializeNative(await localLibraryClient());notify('Архив подключён')}},
  ...(!storage.libraryConfigured?[{text:'Использовать «Документы»',primary:true,run:async()=>{await configureLibrary({useDefault:true});updateStorageSettings();await refresh();await initializeNative(await localLibraryClient());notify('Папка для записей готова')}}]:[])
 ]);
}
init().catch(e=>{notify('Ошибка инициализации: '+e.message,'error');console.error(e)});
