import {openDB,putRecording,getRecording,listRecordings,patchRecording,addChunk,saveImportedRecording,getBlob,removeRecording,restoreRecording,streamRecordingAudio,storageDetails,configureLibrary,chooseLibraryFolder,audioURL,transcriptPage,saveSegmentEdit,submitLocalTranscription,startLibraryTransfer,libraryTransferStatus,cancelLibraryTransfer,resumeLibraryTransfer,recoverLibraryTransfer,refreshStorageStatus} from './db.js';
import {audioExtension,validBackupItem,portableRecord} from './backup-core.js';
import {enhanceUI,syncControls,closeDrawer} from './ui/index.js';
import {migrateLegacy,hasLegacyRecords} from './library-migration.js';
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
import {Preflight,mountPreflight,remember,recentErrors} from './preflight.js';
import {windowProbe,microphonePaths,windowFindings,microphoneFindings,formatReport,consolidate} from './diagnostics.js';
import {SafetyTrack} from './safety-track.js';
import {LevelPreview,addBookmark,SaveClock,BatteryWatch,DEFAULT_TITLE,suggestTitle} from './studio-extras.js';import {PlayerWave} from './waveform.js';
import {speakerFor,SPEAKER_NAMES} from './speakers.js';
import {paragraphs,isDoubtful,nextDoubtful,silenceSkips,skipTarget,savedSeconds,cleanText,transcriptStats,learnTerms,rememberTerms,promptWithTerms} from './intelligence.js';
import {guardSingleWindow} from './window-guard.js';
import {RETRYABLE as AUTOPILOT_RETRY,recoverySteps,pickInput,needsRepair,REPAIR} from './autopilot.js';

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
const levelPreview=new LevelPreview(),saveClock=new SaveClock(),battery=new BatteryWatch({onWarn:message=>notify(message,'error')});
const takeMarks={id:null,marks:[]};
/** Bookmark the current moment of the take ("Важно", key B). Saved with the record when it ends. */
function markMoment(){
 const id=state.capture?.id||state.recordingId;if(!id||!state.capture)return;
 if(takeMarks.id!==id)Object.assign(takeMarks,{id,marks:[]});
 const before=takeMarks.marks.length;takeMarks.marks=addBookmark(takeMarks.marks,currentRecordingSeconds());
 if(takeMarks.marks.length>before)notify('Отмечено: '+durationText(currentRecordingSeconds()));
}
async function saveMarks(id){
 if(takeMarks.id!==id||!takeMarks.marks.length)return;const bookmarks=takeMarks.marks;Object.assign(takeMarks,{id:null,marks:[]});
 // Read the finished record first: the capture service bumped its version on stop.
 for(let attempt=0;attempt<3;attempt++){
  try{await getRecording(id);await patchRecording(id,{bookmarks});return}
  catch(error){if(error.code!=='VERSION_CONFLICT'||attempt===2){notify('Отметки не сохранены: '+error.message,'error');return}await new Promise(resolve=>setTimeout(resolve,300))}
 }
}
/** Live level before recording: only in the studio, only when idle, only with permission already granted. */
/** «Микрофон: USB Audio Device» under the timer — what will be recorded, without opening settings. */
function showRecordSource(){
 const el=document.getElementById('record-source');if(!el||!captureSources)return;
 try{const {input,output}=captureSources.activeDevices?.()||{};const mode=captureSources.fallbackMode?.()||captureSources.value?.mode;
  const parts=[];if(mode!=='system'&&input)parts.push('Микрофон: '+input);if(['system','both'].includes(mode)&&output)parts.push('Звук компьютера: '+output);
  el.textContent=parts.join(' · ');}catch{el.textContent=''}
}
function syncLevelPreview(){
 showRecordSource();
 const idle=state.view==='record'&&!state.capture&&!captureActive(nativeController?.snapshot)&&!document.hidden;
 if(!idle){if(state.previewRequested||levelPreview.wanted)stopLevelCheck();return}
 const choice=captureSources?.value||{},mode=captureSources?.fallbackMode?.()||choice.mode||'mic';
 if(mode==='system')return levelPreview.stop();
 // The microphone is only listened to, never recorded, and only for 45 s per visit:
 // Windows shows its "microphone in use" indicator while the preview is open.
 if(!state.previewRequested||levelPreview.wanted||state.previewDone===state.viewVisit)return;
 void levelPreview.start(mode==='browser'?choice.browserInputId||null:null).then(ok=>{if(!ok){stopLevelCheck();return}const visit=state.viewVisit;setText('#record-caption','МИКРОФОН ПРОСЛУШИВАЕТСЯ · НЕ ЗАПИСЫВАЕТСЯ');clearTimeout(state.previewTimer);state.previewUntil=Date.now()+LEVEL_CHECK_MS;state.previewTimer=setTimeout(()=>{if(state.viewVisit===visit)stopLevelCheck()},LEVEL_CHECK_MS);renderLevelCheck();if(!nativeFrame)nativeFrame=requestAnimationFrame(drawWave)});
}
/** «Проверить уровень» is a toggle with a visible countdown; it never comes back by itself. */
const LEVEL_CHECK_MS=45000;
function stopLevelCheck(){
 state.previewRequested=false;state.previewDone=state.viewVisit;state.previewUntil=0;clearTimeout(state.previewTimer);
 if(levelPreview.wanted||levelPreview.active)levelPreview.stop();
 if(!state.capture&&!captureActive(nativeController?.snapshot))setText('#record-caption','ГОТОВО К ЗАПИСИ');
 renderLevelCheck();
}
function renderLevelCheck(){
 const button=$('#level-check');if(!button)return;clearTimeout(state.levelTick);
 const left=Math.max(0,Math.ceil(((state.previewUntil||0)-Date.now())/1000)),on=left>0&&(levelPreview.active||levelPreview.wanted);
 button.classList.toggle('is-on',on);button.setAttribute('aria-pressed',String(on));
 button.textContent=on?`Остановить проверку · 0:${String(left).padStart(2,'0')}`:'Проверить уровень';
 button.title=on?'Микрофон слушается только для шкалы и не записывается':'Микрофон откроется на 45 секунд только для шкалы — без записи';
 if(on)state.levelTick=setTimeout(renderLevelCheck,250);
}
function pauseAudition(){audioReview?.player.pause();if(mediaInterlock)mediaInterlock.pauseAll();else document.querySelectorAll('audio,video').forEach(media=>media.pause())}
function canAudition(){if(storageDetails().local&&(!nativeController?.snapshot.connected||captureActive(nativeController.snapshot))){notify('Завершите запись перед прослушиванием, чтобы звук плеера не попал в неё.','error');return false}return true}
async function playAudition(media){if(!canAudition())return;if(media.ended||(Number.isFinite(media.duration)&&media.duration>0&&media.currentTime>=media.duration-.25))media.currentTime=0;try{if(storageDetails().local){if(!mediaInterlock)throw new Error('Дождитесь подключения модуля записи.');await mediaInterlock.play(media)}else await media.play()}catch(error){if(error.name!=='AbortError')notify(error.message||'Не удалось воспроизвести аудио.','error')}}
/** Warn while recording, not after: a silent or clipping input is fixable only now. */
const captureHealth={session:null,lastSound:0,clipUntil:0};
function captureHealthHint(value){
 const now=performance.now();
 if(captureHealth.session!==value.sessionId){Object.assign(captureHealth,{session:value.sessionId,lastSound:now,clipUntil:0,repairTried:false,quietSince:0,levelTried:false})}
 if(value.state!=='recording'){captureHealth.lastSound=now;return ''}
 const levels=Object.values(value.levels||{}).filter(level=>Number.isFinite(level?.rms)&&(level.ageMs??0)<3000);
 // −50 dBFS RMS: below any normal speech, above typical digital silence.
 if(!levels.length||levels.some(level=>level.rms>0.00316))captureHealth.lastSound=now;
 if(levels.some(level=>level.clippedFrames>=3))captureHealth.clipUntil=now+4000;
 // Quiet but present (−60…−48 dBFS) for 20 s: the Windows input level is probably too low.
 const quiet=levels.length&&levels.every(level=>level.rms>0.001&&level.rms<0.004);
 if(!quiet)captureHealth.quietSince=0;else if(!captureHealth.quietSince)captureHealth.quietSince=now;
 if(captureHealth.quietSince&&now-captureHealth.quietSince>20000&&!captureHealth.levelTried){captureHealth.levelTried=true;void raiseQuietInput()}
 if(now-captureHealth.lastSound>10000){if(!captureHealth.repairTried){captureHealth.repairTried=true;healthEvent('SILENCE',inputName());void silenceRepair(value)}return ' · ⚠ Микрофон молчит больше 10 с — проверьте выбранный вход и его громкость'}
 if(now<captureHealth.clipUntil)return ' · ⚠ Перегрузка входа — уменьшите усиление микрофона или отодвиньтесь';
 return '';
}
/** Ten seconds of silence while recording: if Windows muted the microphone or set its level
 * to ~0, fix it in place (the take continues); otherwise the on-screen hint stays. */
async function silenceRepair(value){
 if(!['mic','both'].includes(autopilot.mode))return;
 try{const local=await localLibraryClient();const report=await local.json('/capture/diagnose',{signal:AbortSignal.timeout(7000)});
  const {target}=pickInput(report,autopilot.inputId);
  if(needsRepair(target)){await local.json('/capture/repair',{method:'POST',body:REPAIR(target)});notify(`Микрофон «${target.name}» был выключен в Windows — включили, запись продолжается.`);captureHealth.lastSound=performance.now()}
 }catch{}
}
/** The taskbar shows the state too: «● 00:12 · Запись — MONO» and a red dot on the icon. */
const baseTitle=document.title;let iconState='';
function reflectRecordingInChrome(active,value){
 const paused=value?.state==='paused';
 document.title=active?`${paused?'❚❚':'●'} ${durationText(value?.duration||0)} · ${paused?'Пауза':'Запись'} — MONO`:baseTitle;
 const want=active?(paused?'paused':'recording'):'';if(want===iconState)return;iconState=want;
 const link=document.querySelector('link[rel=icon]');if(!link)return;
 if(!want){link.href='/icon.svg';return}
 const svg=`<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'><rect width='64' height='64' rx='14' fill='#111'/><g fill='#fff'><rect x='14' y='22' width='4' height='20' rx='2'/><rect x='22' y='16' width='4' height='32' rx='2'/><rect x='30' y='24' width='4' height='16' rx='2'/></g><circle cx='46' cy='18' r='12' fill='${want==='paused'?'#ff9f0a':'#ff453a'}'/></svg>`;
 link.href='data:image/svg+xml,'+encodeURIComponent(svg);
}
async function raiseQuietInput(){
 if(!['mic','both'].includes(autopilot.mode))return;
 try{const local=await localLibraryClient();const report=await local.json('/capture/diagnose',{signal:AbortSignal.timeout(7000)});const {target}=pickInput(report,autopilot.inputId);
  if(target&&typeof target.volume==='number'&&target.volume<.4){await local.json('/capture/repair',{method:'POST',body:{inputId:target.id,minimumVolume:.7}});notify(`Голос записывался очень тихо: MONO поднял уровень микрофона «${target.name}» до 70 %.`)}
 }catch{}
}
function onNativeState(value){
 const wasActive=Boolean(state.capture?.native&&captureActive(state.capture.snapshot)&&state.capture.id===value.recordId);
 const active=captureActive(value);captureSources?.setBusy(active);reflectRecordingInChrome(active,value);if(!active)showRecordSource();
 if(value.state==='recording'&&value.connected){autopilot.selection=null; // started: nothing left to recover
  document.querySelectorAll('.toast').forEach(t=>{if(/^Переподключаем звук/.test(t.textContent))t.remove()})}
 mediaInterlock?.observe(value);
 audioReview?.captureState(value);
 void followSafety(value,wasActive);if(!active&&wasActive){releaseDeferred();applyPendingSourceSwitch()}
 if(active){
  if(!state.capture?.native)state.capture={native:true,peaks:[]};
  Object.assign(state.capture,{id:value.recordId,paused:value.state==='paused',stopping:value.state==='stopping',snapshot:value});state.recordingId=value.recordId;pauseAudition();
  if(!nativeFrame)nativeFrame=requestAnimationFrame(drawWave);
 }else if(state.capture?.native){state.capture=null;state.recordingId=null}
 // Never a dead control: without a connection, pressing Start reconnects and explains.
 $('#start-record').hidden=active;$('#start-record').disabled=false;
 $('#pause-record').hidden=!active||value.state==='requesting';$('#level-check').hidden=active;$('#stop-record').hidden=!active;$('#mark-record').hidden=!active;$('.studio-buttons').classList.toggle('is-recording',active);
 watchDisk(active);
 if(active){saveClock.observe(value.sessionId||value.recordId,value.duration);if(!battery.active){battery.active=true;battery.reset()}void battery.check();stopLevelCheck()}else battery.active=false;
 $('#pause-record').disabled=!value.connected||Boolean(value.pendingAction)||!['recording','paused'].includes(value.state);
 $('#stop-record').disabled=value.state==='stopping';$('#pause-record').innerHTML=icon(value.state==='paused'?'play':'pause')+(value.state==='paused'?' Продолжить':' Пауза');
 setText('#record-saved',!value.connected?(active?'Связь потеряна. Остановка и сохранение не подтверждены.':'Подключаемся к модулю записи…'+(nativeController?.lastError?.code?` (${nativeController.lastError.code})`:'')):value.state==='requesting'?'Подключаем источник звука…':value.state==='stopping'?'Завершаем запись и проверяем сохранение…':active?'Подтверждено в архиве '+(value.state==='recording'?saveClock.text():'')+captureHealthHint(value):state.footerNote?state.footerNote:value.errorCode?captureFailureMessage(value):'');
 updateRecordUI();
 if(!active&&value.recordId&&nativeCompleted!==value.recordId){nativeCompleted=value.recordId;void saveMarks(value.recordId).then(()=>applyContinuationTitle(value.recordId));syncLevelPreview();
  if(wasActive&&value.state==='interrupted')markRecoveredSeen(value.recordId);
  if(wasActive&&value.errorCode)healthEvent('CAPTURE_ERROR',[value.errorCode,value.failureDetails?.stage,value.failureDetails?.nativeCode].filter(Boolean).join(' ')); // the journal sees module failures too
  // A start that never captured audio leaves an empty «Прервано · 0 с» record: it is noise, not a meeting.
  if(wasActive&&value.state==='interrupted'&&!(Number(value.savedBytes)>0)&&!(Number(value.savedFrames)>0)&&!(Number(value.duration)>0)){const empty=value.recordId;setTimeout(()=>{void getRecording(empty,{transcript:false}).then(r=>r&&!(r.size>0)&&!(r.duration>0)?removeRecording(empty).then(()=>refresh()):null).catch(()=>{})},1500)}
  if(wasActive&&value.state==='interrupted'&&!(Number(value.savedBytes)>0)&&AUTOPILOT_RETRY.has(value.errorCode)&&autopilot.selection&&autopilot.steps.length){void autopilotRetry(value.errorCode).then(handled=>{if(!handled)void notifyCaptureError(captureFailureMessage(value),value.errorCode)});void refresh().catch(()=>{});return}
  if(wasActive&&value.state==='interrupted'&&value.errorCode==='DEVICE_LOST'&&(Number(value.savedBytes)>0||Number(value.savedFrames)>0)){void continueAfterDeviceChange(value.recordId);return}void refresh().catch(e=>notify(e.message,'error'));if(wasActive&&!setupWindow)notify(value.state==='ready'?'Запись сохранена в библиотеке.':captureFailureMessage(value),value.state==='ready'?'info':'error',value.state==='ready'?{text:state.health?.groq?'Расшифровать':'Открыть',run:async()=>{go('editor',value.recordId);if(state.health?.groq){await refresh();const rec=state.records.find(r=>r.id===value.recordId);if(rec)void startTranscription(rec)}}}:fixFor(value.errorCode))}
}
/** Autopilot (Apple: recover quietly; ask only when nothing else can help).
 * Before a microphone take: Windows' own view of the microphone. A muted endpoint or a
 * near-zero input level is fixed on the spot — the person just pressed Record, so the intent
 * is explicit — and said in one line. A chosen microphone that disappeared falls back to
 * the system default instead of failing. */
async function autopilotBeforeStart(selection){
 if(!['mic','both'].includes(selection.mode))return selection;
 let local,report;try{local=await localLibraryClient();report=await local.json('/capture/diagnose',{signal:AbortSignal.timeout(7000)})}catch{return selection}
 if(!report?.available||!Array.isArray(report.inputs))return selection;
 const {target,fallback,disabledOnly}=pickInput(report,selection.inputId);
 if(disabledOnly){notify('Микрофон отключён в Windows. Включите его: Параметры → Система → Звук → Все звуковые устройства.','error',/Windows/i.test(navigator.userAgent)?{text:'Открыть параметры звука',run:()=>{window.open('ms-settings:sound','_blank')}}:null);return selection}
 if(fallback){selection={...selection,inputId:null};notify('Выбранный микрофон недоступен — записываем с микрофона по умолчанию.')}
 if(needsRepair(target)){
  try{const after=await local.json('/capture/repair',{method:'POST',body:REPAIR(target)});if(!after?.repairError)notify(`Микрофон «${target.name}» был выключен в Windows — MONO включил его.`)}catch{}
 }
 return selection;
}
/** Start failures that a different path can fix: same mode on the default devices, then the
 * browser channel for a microphone-only take. Two attempts per press, then an honest message. */
const autopilot={selection:null,steps:[],mode:null};
function arm(selection){autopilot.selection=selection;autopilot.mode=selection.mode;autopilot.inputId=selection.inputId;autopilot.steps=recoverySteps(selection,(captureSources?.capability?.modes||[]).includes('browser')||Boolean(captureSources?.client?.supported),nativeMicState())} // the window's own channel does not depend on the module having answered
// A capability never loaded (the first query timed out while the module was still launching)
// is «starting», not «absent»: the step refreshes it and decides then.
function nativeMicState(capability=captureSources?.capability){return capability?.nativeReady&&(capability.modes||[]).includes('mic')?true:capability?.nativeStarting||capability&&!('nativeReady' in capability)?'starting':false}
/** A fallback to the system module that is still launching waits for it (up to 20 s) instead of being lost. */
async function readyForStep(step){
 if(!step?.waitNative)return step;
 notify('Окно не открыло микрофон — ждём, пока запустится системный модуль записи…');
 for(const deadline=Date.now()+20000;Date.now()<deadline;){
  try{await captureSources.refresh()}catch{}
  const now=nativeMicState();if(now===true){const {waitNative,...ready}=step;return ready}if(now===false)return null;
  await new Promise(resolve=>setTimeout(resolve,700));
 }
 return null;
}
/** Once: MONO now records the microphone through its browser window (the person's own browser, which
 * security software trusts). A source left on the module microphone moves to the window. */
function migrateToBrowserSource(){
 try{if(localStorage.getItem('mono-source-browser-1')==='1')return}catch{return}
 if(captureActive(nativeController?.snapshot))return;
 const done=()=>{try{localStorage.setItem('mono-source-browser-1','1')}catch{}};
 if(captureSources?.value?.mode!=='mic'||!captureSources?.client?.supported){done();return}
 void captureSources.update({mode:'browser',inputId:null},{quiet:true}).then(done).catch(()=>{});
}
/** The browser channel could not open the microphone but the system module did: keep using it. */
function rememberPathSwitch(from,to){if(from==='browser'&&to==='mic'){notify('Окно не смогло открыть микрофон — эта запись идёт через модуль Windows.');healthEvent('BROWSER_FALLBACK')}}
// Settings cannot change during a take (the core answers CAPTURE_BUSY): the switch is saved when it ends.
let pendingSourceSwitch=null;
function applyPendingSourceSwitch(){if(!pendingSourceSwitch||!captureSources)return;const mode=pendingSourceSwitch;pendingSourceSwitch=null;void captureSources.update({mode,inputId:null},{quiet:true}).catch(()=>{pendingSourceSwitch=mode})}
function autopilotNext(){return autopilot.selection?autopilot.steps.shift()||null:null}
let startInFlight=null;
async function startWithAutopilot(selection){
 if(startInFlight)return startInFlight; // a double click never opens two sessions
 startInFlight=startWithAutopilotOnce(selection).finally(()=>{startInFlight=null});return startInFlight;
}
async function startWithAutopilotOnce(selection){
 state.footerNote=null;arm(selection);
 for(;;){
  try{captureMode=selection.mode;const started=await nativeController.start(selection);rememberPathSwitch(autopilot.mode,selection.mode);return started}
  catch(error){const next=AUTOPILOT_RETRY.has(error?.code)?await readyForStep(autopilotNext()):null;if(!next)throw error;notify('Переподключаем звук…');await new Promise(resolve=>setTimeout(resolve,800));if(next.mode==='browser'&&selection.mode!=='browser')notify('Записываем через запасной канал — окно MONO.');selection=next}
 }
}
async function autopilotRetry(code){
 const next=await readyForStep(autopilotNext());if(!next)return false;
 notify('Переподключаем звук…');await new Promise(resolve=>setTimeout(resolve,800));
 try{if(next.mode==='browser'&&autopilot.mode!=='browser'){notify('Записываем через запасной канал — окно MONO.');healthEvent('BROWSER_FALLBACK')}captureMode=next.mode;await nativeController.start(next);rememberPathSwitch(autopilot.mode,next.mode);return true}
 catch(error){if(AUTOPILOT_RETRY.has(error?.code)&&await autopilotRetry(error.code))return true;void notifyCaptureError(captureErrors[error?.code]||error.message||'Не удалось начать запись.',error?.code||code);return true}
}
/** A headset unplugged mid-meeting: the confirmed part is kept and recording continues
 * on the current system device as a linked take, instead of silently stopping. */
const continuations=[],continuationTitles=new Map();
async function applyContinuationTitle(id){
 const title=continuationTitles.get(id);if(!title)return;continuationTitles.delete(id);
 for(let attempt=0;attempt<3;attempt++){try{await getRecording(id);await patchRecording(id,{title});await refresh();return}catch(error){if(error.code!=='VERSION_CONFLICT')return;await new Promise(resolve=>setTimeout(resolve,300))}}
}
async function continueAfterDeviceChange(previousId){
 const now=Date.now();while(continuations.length&&now-continuations[0]>300000)continuations.shift();
 if(continuations.length>=3){notify('Устройство звука несколько раз отключилось. Запись остановлена, подтверждённые фрагменты сохранены.','error',fixFor('DEVICE_LOST'));return}
 continuations.push(now);notify('Устройство звука сменилось. Продолжаем запись на текущем устройстве…');
 try{
  await new Promise(resolve=>setTimeout(resolve,1200));await captureSources.load();
  const selection=await captureSources.selection();const previous=state.records.find(r=>r.id===previousId)||await getRecording(previousId).catch(()=>null);
  healthEvent('DEVICE_LOST',inputName());captureMode=selection.mode;const started=await nativeController.start({...selection,inputId:null,outputId:null});
  // The archive updates a live record continuously; the linked title is applied when the take ends.
  if(started?.recordId&&previous?.title)continuationTitles.set(started.recordId,previous.title.replace(/ · продолжение$/,'')+' · продолжение');
  notify('Запись продолжается. Первая часть сохранена в библиотеке.','info',{text:'Открыть первую часть',run:()=>go('editor',previousId)});
 }catch(error){notify('Не удалось продолжить запись: '+(error.message||error.code),'error',fixFor(error.code||'DEVICE_LOST'))}
 void refresh().catch(()=>{});
}
async function initializeNative(local){
 if(nativeInitializing)return nativeInitializing;
 nativeInitializing=(async()=>{
 if(!nativeController){
  const client=new BrowserMicrophoneClient(new CaptureClient({library:local}));captureSources=new CaptureSources(client,local);
  mediaInterlock=new MediaInterlock({status:options=>client.status(options),channel:typeof BroadcastChannel==='function'?new BroadcastChannel('mono-media'):null});
  nativeController=new NativeCaptureController(client,{onState:onNativeState,onError:error=>notify(error.message,'error',fixFor(error.code)),onIntent:async options=>{if(levelPreview.active||levelPreview.wanted){levelPreview.stop();await new Promise(resolve=>setTimeout(resolve,250))}return mediaInterlock.beforeCapture(options)}});
  const studio=$('#audio-source').closest('.side-card');studio.replaceChildren();mountCaptureSources(studio,{model:captureSources,onError:error=>notify(error.message,'error'),onNotice:message=>notify(message)});
  const card=document.createElement('article');card.className='glass settings-card';card.innerHTML='<div class="settings-card-icon"><svg><use href="#i-mic"/></svg></div><h2>Источники записи</h2><div class="settings-capture-sources"></div><button type="button" class="btn btn-outline btn-small" id="check-native-sound">Проверить звук</button>';$('#view-settings .settings-grid').prepend(card);mountCaptureSources(card.querySelector('.settings-capture-sources'),{model:captureSources,onError:error=>notify(error.message,'error')});card.querySelector('button#check-native-sound').onclick=()=>void showSetup('sound').catch(error=>notify(error.message,'error'));
  const guide=$('#studio-guide');guide.replaceChildren();mountGuidance(guide,{library:local,controller:nativeController,sources:captureSources,onError:error=>notify(error.message,'error'),onAction:async(action,recordId)=>{if(action==='listen'){await refresh();go('editor',recordId)}else await showSetup('sound')}});
  const safe=document.createElement('article');safe.className='glass settings-card';safe.innerHTML='<div class="settings-card-icon"><svg><use href="#i-shield"/></svg></div><h2>Страховочная дорожка</h2><p>Когда запись идёт через модуль Windows, окно параллельно пишет копию микрофона другим путём. Если основная запись оборвётся, MONO восстановит встречу из копии. Копия хранится сутки (после сбоя — неделю), около 14 МБ за час.</p><label class="check-row"><input type="checkbox" id="setting-safety"> Вести страховочную дорожку</label>';$('#view-settings .settings-grid').append(safe);
  $('#setting-safety').checked=safetySettings;$('#setting-safety').onchange=e=>{safetySettings=e.target.checked;try{localStorage.setItem('mono-safety-track',safetySettings?'1':'0')}catch{}};
  const help=document.createElement('article');help.className='glass settings-card';mountHelp(help);$('#view-settings .settings-grid').append(help);
  // Pre-flight check: compact (problems only) in the studio, full in settings.
  preflight=new Preflight(local);$('#system-health-card').hidden=true; // the pre-flight check below covers the same systems in depth
  const studioCheck=document.createElement('div');studioCheck.className='glass side-card';$('.studio-side').prepend(studioCheck);mountPreflight(studioCheck,{model:preflight,compact:true,onError:()=>{}});
  const settingsCheck=document.createElement('article');settingsCheck.className='glass settings-card';settingsCheck.innerHTML='<div class="settings-card-icon"><svg><use href="#i-check"/></svg></div><h2>Предполётная проверка</h2><div></div>';$('#view-settings .settings-grid').prepend(settingsCheck);mountPreflight(settingsCheck.lastElementChild,{model:preflight,onError:error=>notify(error.message,'error'),onDeep:()=>void runDeepDiagnostics()});mountSystemStatus(preflight);
 }
 await nativeController.connect();
 await captureSources.load();
 await loadWindowState();migrateToBrowserSource();
 return {controller:nativeController,sources:captureSources};
 })().catch(error=>{nativeInitializing=null;throw error});return nativeInitializing;
}
async function showSetup(initialStep=null){
 if(setupWindow)return;if(setupOpening){await setupOpening;if(initialStep&&!setupWindow)return showSetup(initialStep);return}setupOpening=(async()=>{const local=await localLibraryClient();if(!local)return;
 const opened=await openOnboarding({library:local,storage:storageDetails,configure:configureLibrary,choose:chooseLibraryFolder,ensureNative:()=>initializeNative(local),onArchive:async()=>{updateStorageSettings();await refresh()},onComplete:()=>{setupWindow=null;void credentialForm?.refresh();void ensureArchive('setup').then(()=>offerLegacyImport())},onError:error=>notify(error.message,'error'),helpTemplate:$('#groq-settings-card .setup-details'),initialStep,canPlay:canAudition,playAudio:audio=>mediaInterlock.play(audio)});setupWindow=opened&&!opened.closed?opened:null;
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
/** During a take, once a minute: will the disk hold the rest of it? (warn at ~30 and ~5 min) */
const diskWatch={timer:0,warned:new Set()};
function watchDisk(active){
 if(!active){clearInterval(diskWatch.timer);diskWatch.timer=0;diskWatch.warned.clear();return}
 if(diskWatch.timer)return;
 diskWatch.timer=setInterval(async()=>{
  try{const local=await localLibraryClient();const {freeBytes,bytesPerMinute}=await local.json('/storage',{signal:AbortSignal.timeout(5000)});const minutes=freeBytes/bytesPerMinute;
   for(const limit of [5,30])if(minutes<limit&&!diskWatch.warned.has(limit)){diskWatch.warned.add(limit);diskWatch.warned.add(30);notify(`На диске осталось места на ~${Math.max(0,Math.floor(minutes))} мин записи. Освободите место — запись продолжается.`,'error');break}
  }catch{}
 },60000);
}
/** The core restarts by itself (launcher supervisor); the window notices and reconnects. */
function watchConnection(){
 if(!storageDetails().local)return;
 let failures=0,banner=null;
 const tick=async()=>{
  if(document.hidden)return;
  let ok=false;try{ok=(await fetch('/api/health',{cache:'no-store',signal:AbortSignal.timeout(3000)})).ok}catch{}
  if(!ok){if(++failures>=2&&!banner){banner=document.createElement('div');banner.className='connection-banner';banner.setAttribute('role','status');banner.textContent='Связь с ядром MONO прервалась — восстанавливаем…';document.body.append(banner)}return}
  if(banner){banner.remove();banner=null;
   // A new core: fresh session and state. Never reload under a take in this window.
   if(!state.capture&&!captureActive(nativeController?.snapshot))location.reload();else void nativeController?.connect().catch(()=>{})}
  failures=0;
 };
 setInterval(tick,4000);
}
/** Background audio care: the microphone is kept ready before anyone presses Record.
 * Runs at start, on device plug/unplug, when the window returns, and every 3 min while idle;
 * never during a take, at most once per 20 s. Fixes what Windows silently changed (muted,
 * level ~0), keeps the capture module connected (backoff), and says each finding once. */
const audioCare={running:false,at:-Infinity,told:new Set(),reconnectDelay:2000};
async function backgroundAudioCare(reason='timer'){
 if(audioCare.running||!storageDetails().local||!storageDetails().libraryConfigured)return;
 if(state.capture||captureActive(nativeController?.snapshot)||setupWindow)return;
 if(reason!=='device'&&performance.now()-audioCare.at<20000)return;
 audioCare.running=true;audioCare.at=performance.now();
 try{
  const local=await localLibraryClient();
  // 1. Capture module alive? Reconnect quietly with backoff instead of waiting for a failure.
  if(nativeController&&!nativeController.snapshot.connected){try{await nativeController.connect();audioCare.reconnectDelay=2000}catch{audioCare.reconnectDelay=Math.min(60000,audioCare.reconnectDelay*2);setTimeout(()=>void backgroundAudioCare('reconnect'),audioCare.reconnectDelay)}}
  if(reason==='device')await captureSources?.load().catch(()=>{});
  // 2. Windows' view of the microphone: unmute / restore a near-zero level.
  const report=await local.json('/capture/diagnose',{signal:AbortSignal.timeout(7000)}).catch(()=>null);
  // Module still starting (first launch): look again shortly instead of waiting three minutes.
  if(report?.reason==='STARTING'&&!audioCare.retryStarting){audioCare.retryStarting=true;setTimeout(()=>{audioCare.retryStarting=false;void backgroundAudioCare('reconnect')},3000)}
  if(report?.available){
   const {target,disabledOnly}=pickInput(report,captureSources?.value?.inputId||null);
   if(needsRepair(target)){const after=await local.json('/capture/repair',{method:'POST',body:REPAIR(target)}).catch(()=>null);if(after&&!after.repairError)notify(`Микрофон «${target.name}» был выключен в Windows — MONO включил его.`)}
   if(disabledOnly&&!audioCare.told.has('disabled')){audioCare.told.add('disabled');notify('Микрофон отключён в Windows. Включите его: Параметры → Система → Звук → Все звуковые устройства.','error',/Windows/i.test(navigator.userAgent)?{text:'Открыть параметры звука',run:()=>{window.open('ms-settings:sound','_blank')}}:null)}
  }
  // 3. Privacy switch and the rest of the pre-flight, refreshed for the studio card.
  const result=await preflight?.run({force:true}).catch(()=>null);
  announceNewWarnings(result);
  const privacy=result?.checks?.find(check=>check.id==='mic-privacy');
  if(privacy&&!audioCare.told.has('privacy')){audioCare.told.add('privacy');notify(privacy.title+'. '+privacy.action,'error',fixFor('ACCESS_DENIED'))}
 }finally{audioCare.running=false}
 if(reason==='timer'&&performance.now()>10*60e3)void weeklyScrub().catch(()=>{}); // never competes with start-up
}
function startAudioCare(){
 if(audioCare.started)return;audioCare.started=true;
 void backgroundAudioCare('start');void reviewSafetyTracks();
 navigator.mediaDevices?.addEventListener?.('devicechange',()=>setTimeout(()=>void backgroundAudioCare('device'),1500));
 window.addEventListener('focus',()=>void backgroundAudioCare('focus'));
 setInterval(()=>{if(!document.hidden)void backgroundAudioCare('timer')},180000);
}
/** A transcript finished while the window was in the background: the title says so until return. */
function markDoneWhileAway(){if(!document.title.startsWith('✓')){const previous=document.title;document.title='✓ Расшифровка готова — MONO';document.addEventListener('visibilitychange',()=>{if(!document.hidden&&document.title.startsWith('✓'))document.title=previous},{once:true})}}
/** «?» — every keyboard shortcut in one sheet. */
function showShortcuts(){
 const rows=[['Ctrl + Alt + R','Начать или остановить запись из любого окна Windows'],['B','Отметить важный момент во время записи'],['Пробел, F9 или Ctrl + Пробел','Воспроизведение и пауза в редакторе (пауза отступает на 2 с)'],['Alt + ← / →','Перемотка на 5 с в редакторе'],['Shift + «Копировать»','Скопировать текст с таймкодами'],['N','Следующее место, где модель не уверена (в редакторе)'],['Esc','Закрыть окно или список'],['?','Эта подсказка']];
 modal('Сочетания клавиш','<dl class="shortcut-list">'+rows.map(([k,v])=>`<dt><kbd>${h(k)}</kbd></dt><dd>${h(v)}</dd>`).join('')+'</dl>');
}
/** Ctrl+Alt+R anywhere in Windows (registered by the launcher) starts or stops recording. */
/** A second MONO window that the browser did not let close: say so plainly, offer to work here. */
function showDuplicateWindow(takeOver){
 const veil=document.createElement('div');veil.className='duplicate-window';veil.setAttribute('role','alertdialog');veil.setAttribute('aria-modal','true');veil.setAttribute('aria-labelledby','duplicate-title');
 veil.innerHTML='<div class="duplicate-panel glass"><div class="duplicate-mark"><svg><use href="#i-grid"/></svg></div><h2 id="duplicate-title">MONO уже открыт</h2><p>Он работает в другом окне — переключитесь на него. Это окно можно закрыть.</p><div class="modal-actions"><button type="button" class="btn btn-primary">Работать в этом окне</button><button type="button" class="btn btn-outline">Закрыть окно</button></div></div>';
 document.body.append(veil);const [here,close]=veil.querySelectorAll('button');here.focus();
 here.onclick=()=>{takeOver();veil.remove()};close.onclick=()=>{try{window.close()}catch{}};
}
function listenForLauncherEvents(){
 if(!storageDetails().local||typeof EventSource!=='function')return;
 const source=new EventSource('/api/local/events');
 source.addEventListener('focus',()=>{try{window.focus()}catch{}document.body.classList.add('window-called');setTimeout(()=>document.body.classList.remove('window-called'),900)});
 source.addEventListener('hotkey',()=>{
  const recording=captureActive(nativeController?.snapshot)||Boolean(state.capture);
  if(recording){void endRecord();notify('Запись остановлена (Ctrl+Alt+R).')}
  else{go('record');void beginRecord();notify('Запись начата (Ctrl+Alt+R).')}
 });
}
/** A newer installer is available: offer it once per version (installing over keeps all data). */
function offerUpdate(update){
 if(!update?.version||!/^https:\/\//.test(update.url||''))return;
 try{if(localStorage.getItem('mono-update-offered')===update.version)return;localStorage.setItem('mono-update-offered',update.version)}catch{}
 notifyLater(`Доступна версия MONO ${update.version}. Установка поверх сохранит записи и настройки.`,'info',{text:'Скачать',run:()=>{window.open(update.url,'_blank','noopener')}});
}
/** Windows accent colour as the app tint, when it is readable on both themes (WCAG 3:1 for UI). */
function applyAccent(accent){
 const match=/^#([0-9a-f]{6})$/i.exec(accent||'');if(!match){document.body.style.removeProperty('--tint');document.body.style.removeProperty('--tint-strong');return}
 const n=parseInt(match[1],16),lin=c=>(c/=255)<=.03928?c/12.92:((c+.055)/1.055)**2.4,L=.2126*lin(n>>16&255)+.7152*lin(n>>8&255)+.0722*lin(n&255);
 const contrast=(a,b)=>(Math.max(a,b)+.05)/(Math.min(a,b)+.05);
 if(contrast(L,1)<3||contrast(L,0.012)<3)return; // white text on tint and tint on dark surface
 document.body.style.setProperty('--tint',accent);document.body.style.setProperty('--tint-strong',accent);
}
function notify(message,type='info',action=null){
  if(type==='error'&&typeof remember==='function')remember('notice',message); // the black box never breaks a notice
  const active=notify.active??=new Map(),key=JSON.stringify([type,message]);
  let entry=active.get(key);
  if(entry&&!entry.el.isConnected){clearTimeout(entry.timer);active.delete(key);entry=null}
  if(!entry){
    const el=document.createElement('div');el.className='toast '+(type==='error'?'error':'');el.textContent=message;
    el.setAttribute('role',type==='error'?'alert':'status');
    // Every error says what to do: one button that performs the fix.
    if(action){const fix=document.createElement('button');fix.type='button';fix.className='btn btn-outline btn-small toast-action';fix.textContent=action.text;fix.onclick=()=>{el.remove();active.delete(key);void Promise.resolve().then(action.run).catch(error=>notify(error.message,'error'))};el.append(' ',fix)}
    // A stack never grows past four: the oldest informational notice yields first.
    const area=$('#toast-area');while(area.children.length>=4){const victim=[...area.children].find(t=>!t.classList.contains('error'))||area.firstElementChild;victim.remove()}
    el.addEventListener('click',e=>{if(e.target.closest('button'))return;el.remove();active.delete(key)});el.title='Нажмите, чтобы скрыть';
    area.append(el);
    entry={el,timer:null};active.set(key,entry);
  }
  clearTimeout(entry.timer);
  if(!(type==='error'&&action?.sticky))entry.timer=setTimeout(()=>{entry.el.remove();if(active.get(key)===entry)active.delete(key)},action?12000:type==='error'?9000:6500);
}
/** «Busy» microphone: name the app Windows says is using it, instead of a generic guess. */
async function notifyCaptureError(message,code){
 if(!state.footerNote)state.footerNote='Запись не началась: '+message.replace(/\s+Нажмите.*$/,''); // stays visible until the next start
 void preflight?.run({force:true}).catch(()=>{}); // the status card must not keep saying «запись возможна»
 healthEvent(code==='DEVICE_LOST'?'DEVICE_LOST':['DEVICE_BUSY','BROWSER_OPEN_FAILED','START_TIMEOUT','ACCESS_DENIED','CAPTURE_NOT_READY','OPEN_FAILED','BROWSER_AUDIO_ERROR'].includes(code)?'START_FAILED':'CAPTURE_ERROR',inputName());
 let extra='';
 if(['DEVICE_BUSY','START_TIMEOUT','BROWSER_AUDIO_ERROR'].includes(code)&&storageDetails().local){
  try{const local=await localLibraryClient();const {apps}=await local.json('/microphone-users',{signal:AbortSignal.timeout(5000)});if(apps?.length)extra=` Сейчас микрофон, похоже, использует: ${apps.slice(0,3).join(', ')} — закройте его или выключите в нём микрофон.`}catch{}
 }
 const action=code==='DEVICE_BUSY'&&/Windows/i.test(navigator.userAgent)?{text:'Как освободить микрофон',run:showMicrophoneBusyHelp}:code==='BROWSER_OPEN_FAILED'?{text:'Диагностика',run:()=>void runDeepDiagnostics()}:fixFor(code);
 notify(message+extra,'error',action?{...action,sticky:true}:null); // a failed start stays until dismissed
}
/** Device busy on both paths: something holds the microphone, often in exclusive mode. */
async function showMicrophoneBusyHelp(){
 let apps=[],virtual=false;
 try{const local=await localLibraryClient();apps=(await local.json('/microphone-users',{signal:AbortSignal.timeout(5000)})).apps||[];const report=await local.json('/capture/diagnose',{signal:AbortSignal.timeout(7000)});virtual=(report?.inputs||[]).some(d=>/voicemeeter|vb-audio|virtual cable/i.test(d.name||''))}catch{}
 const steps=[
  apps.length?`<li><strong>Закройте ${h(apps.slice(0,3).join(', '))}</strong> или выключите в нём микрофон — Windows сейчас отдаёт микрофон ему.</li>`:'<li><strong>Закройте программы, которые могут держать микрофон</strong>: Discord, Zoom, Teams, OBS, другой браузер.</li>',
  virtual?'<li><strong>Voicemeeter</strong>: если ваш микрофон выбран в нём как аппаратный вход (Hardware Input), Voicemeeter может забирать его целиком. Уберите микрофон из Voicemeeter на время записи или закройте Voicemeeter.</li>':'',
  '<li><strong>Монопольный режим</strong>: «Панель управления» → «Звук» → вкладка «Запись» → ваш микрофон → «Свойства» → «Дополнительно» → снимите обе галочки в разделе «Монопольный режим» → «ОК». Тогда одна программа больше не сможет забрать микрофон у остальных.</li>',
  '<li>Нажмите «Начать запись» ещё раз — MONO сам попробует оба пути: системный модуль и окно.</li>'].filter(Boolean).join('');
 modal('Микрофон занят другой программой',`<ol class="busy-steps">${steps}</ol><p class="field-hint">Причина видна из ошибки Windows: устройство открыто, но звук отдать нельзя (NotReadableError / AUDCLNT_E_DEVICE_IN_USE).</p>`,
  [{text:'Открыть параметры звука',primary:true,run:()=>{window.open('ms-settings:sound','_blank')}}]);
}
/** The one action that resolves a capture/archive failure code. */
function fixFor(code){
 if(code==='ACCESS_DENIED'&&/Windows/i.test(navigator.userAgent))return {text:'Открыть параметры Windows',run:()=>{window.open('ms-settings:privacy-microphone','_blank')}};
 if(['ACCESS_DENIED','ACCESS_TIMEOUT','DEVICE_LOST','DEVICE_BUSY','START_TIMEOUT','NO_AUDIO_CAPTURED','UNSUPPORTED_FORMAT','NOT_SUPPORTED','BROWSER_AUDIO_ERROR'].includes(code))return {text:'Проверить звук',run:()=>showSetup('sound')};
 if(['LIBRARY_MISSING','LIBRARY_NOT_CONFIGURED','DISK_FULL'].includes(code))return {text:'Выбрать папку',run:()=>{go('settings');showLibrarySetup()}};
 if(['CAPTURE_HELPER_UNAVAILABLE','CAPTURE_HELPER_TIMEOUT','CAPTURE_CONNECTION_LOST','CAPTURE_NOT_READY','STOP_PENDING'].includes(code))return {text:'Переподключить',run:async()=>{await nativeController?.connect();await preflight?.run({force:true}).catch(()=>{});notify('Модуль записи подключён.')}};
 if(['SLEEP','DISCONTINUITY'].includes(code))return {text:'Продолжить запись',run:()=>{go('record');return beginRecord()}};
 if(code==='GROQ_NOT_CONFIGURED'||code==='INVALID_API_KEY')return {text:'Подключить Groq',run:()=>connectGroq(()=>{})};
 // Nothing to fix automatically: one tap copies what support needs (no recordings, no keys).
 if(code&&storageDetails().local)return {text:'Диагностика',run:()=>void runDeepDiagnostics()};
 return null;
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
// ---- Airliner-grade layer: dissimilar redundancy, trend monitoring, quiet cockpit ----
/** Health events feed the core journal; «Глубокая диагностика» turns repeats into trends. */
function healthEvent(code,device){void localLibraryClient().then(local=>local?.json('/diagnostics/event',{method:'POST',body:{code,...(device?{device:String(device).slice(0,120)}:{})}})).catch(()=>{})}
const inputName=()=>{const id=captureSources?.value?.inputId;return (captureSources?.capability?.inputDevices||[]).find(d=>d.id===id)?.name||(captureSources?.capability?.inputDevices||[]).find(d=>d.default)?.name||null};

/** Safety track: the window records the same microphone along an independent path. */
const safety=new SafetyTrack({onIssue:code=>healthEvent('SAFETY_FAILED')});
let captureMode=null,safetySettings=(()=>{try{return localStorage.getItem('mono-safety-track')!=='0'}catch{return true}})();
async function browserDeviceFor(name){
 if(!name)return null;try{const list=(await navigator.mediaDevices.enumerateDevices()).filter(d=>d.kind==='audioinput'&&d.deviceId&&d.deviceId!=='default'&&d.deviceId!=='communications');
  return (list.find(d=>d.label===name)||list.find(d=>d.label&&(d.label.includes(name)||name.includes(d.label))))?.deviceId||null}catch{return null}
}
async function followSafety(value,wasActive){
 const active=captureActive(value),micTake=value.engine!=='browser'&&(['mic','both'].includes(captureMode)||Boolean(value.levels?.mic));
 if(active&&micTake&&safetySettings&&value.recordId&&safety.active?.recordId!==value.recordId&&value.state==='recording'){
  const rec=state.records.find(r=>r.id===value.recordId);void safety.start(value.recordId,{deviceId:await browserDeviceFor(inputName()),title:rec?.title||''});return;
 }
 if(active&&safety.active){if(value.state==='paused')safety.pause();else if(value.state==='recording')safety.resume();return}
 if(!active&&safety.active&&wasActive){
  const failed=value.state==='interrupted'||Boolean(value.errorCode);const id=safety.active.recordId;const meta=await safety.stop({outcome:failed?'failed':'clean'});
  if(failed&&meta?.chunks)offerSafety(id,meta);
 }
}
function offerSafety(id,meta){
 state.footerNote='Основная запись прервалась — звук сохранён страховочной дорожкой. Нажмите «Восстановить» в уведомлении.';
 setText('#record-saved','Основная запись прервалась — звук сохранён страховочной дорожкой. Нажмите «Восстановить».');
 // One notice per event: the rescue replaces the generic failure toasts of the same take.
 document.querySelectorAll('.toast.error').forEach(t=>{if(/Запись прервана|модуля записи|Перезапустите MONO/.test(t.textContent))t.remove()});
 notify('Основная запись прервалась. Страховочная дорожка сохранила звук микрофона'+(meta.bytes?` (${Math.max(1,Math.round(meta.bytes/1024/1024))} МБ)`:'')+'.','error',{text:'Восстановить',run:()=>void restoreSafety(id,meta)});
}
async function restoreSafety(id,meta){
 try{
  const blob=await safety.blob(id);if(!blob.size)throw new Error('страховочная дорожка пуста');
  const original=state.records.find(r=>r.id===id)||await getRecording(id,{transcript:false}).catch(()=>null);
  const title=((original?.title||meta?.title||'Запись')+' · страховочная дорожка').slice(0,150);
  const file=new File([blob],title+'.webm',{type:blob.type||'audio/webm'});const newId=crypto.randomUUID();
  await saveImportedRecording({id:newId,title,createdAt:new Date(meta?.startedAt||Date.now()).toISOString(),duration:await fileDuration(file),mime:file.type,size:file.size,source:'Страховочная дорожка',chunkCount:0,status:'saved'},file);
  await safety.stop().catch(()=>{});const used=await safety.list();const entry=used.find(m=>m.recordId===id);if(entry)await safety.discard(id);
  healthEvent('SAFETY_USED');await refresh();notify('Страховочная дорожка сохранена в библиотеке.','info',{text:'Открыть',run:()=>go('editor',newId)});
 }catch(error){notify('Не удалось восстановить страховочную дорожку: '+error.message,'error')}
}
/** At start: a window that crashed mid-take leaves a backup marked «recording»; offer it once. */
async function reviewSafetyTracks(){
 if(!safety.supported||!storageDetails().local)return;
 try{
  await safety.prune();
  for(const meta of await safety.list()){
   if(safety.active?.recordId===meta.recordId||!meta.chunks||!['failed','recording'].includes(meta.outcome))continue;
   const rec=await getRecording(meta.recordId,{transcript:false}).catch(()=>null);
   if(rec&&!['interrupted','damaged'].includes(rec.status)&&meta.outcome==='recording'&&rec.duration>=(meta.chunks*4-8))continue; // main take is complete
   offerSafety(meta.recordId,meta);
  }
 }catch{}
}

/** Quiet cockpit: while recording, news that does not concern the take waits until it ends. */
const deferred=[];
function notifyLater(message,type='info',action=null){if(captureActive(nativeController?.snapshot)||state.capture){if(deferred.length<10)deferred.push([message,type,action]);return}notify(message,type,action)}
function releaseDeferred(){if(captureActive(nativeController?.snapshot)||state.capture||!deferred.length)return;const list=deferred.splice(0);setTimeout(()=>{for(const [m,t,a] of list)notify(m,t,a)},1200)}

/** Built-in test in the background: silent when healthy, one line for each new blocking problem. */
const announced=new Set();
function announceNewWarnings(result){
 for(const item of result?.checks||[]){
  if(item.level!=='warning'||announced.has(item.id)||item.id==='mic-privacy')continue;announced.add(item.id);
  notify(item.title+(item.action?'. '+item.action:''),'error',{text:'Диагностика',run:()=>void runDeepDiagnostics()});
 }
 for(const id of announced)if(!result?.checks?.some(item=>item.id===id&&item.level==='warning'))announced.delete(id); // cleared → may warn again later
}
/** Weekly integrity scrub of the archive (re-hash every stored part) in short 5-second passes, never during start-up or a take. */
async function weeklyScrub(){
 let last=0;try{last=Number(localStorage.getItem('mono-last-scrub'))||0}catch{}
 if(Date.now()-last<7*86400e3)return;
 const local=await localLibraryClient();if(!local)return;let cursor=null,damaged=[];
 for(let pass=0;pass<500;pass++){
  if(captureActive(nativeController?.snapshot)||state.capture)return; // never during a take; resumes next time
  const result=await local.json('/diagnostics/scrub',{method:'POST',body:{cursor},signal:AbortSignal.timeout(70000)}).catch(()=>null);if(!result)return;
  damaged.push(...result.damaged);if(result.complete)break;cursor=result.cursor;await new Promise(r=>setTimeout(r,2000));
 }
 try{localStorage.setItem('mono-last-scrub',String(Date.now()))}catch{}
 if(damaged.length){await refresh().catch(()=>{});notify(`Проверка целостности: повреждено записей — ${damaged.length}. Файлы изменились на диске после сохранения.`,'error',{text:'Диагностика',run:()=>void runDeepDiagnostics()})}
}
/** «Глубокая диагностика»: active tests of the core, archive, sound, Groq and this window,
 * with conclusions in plain words and a report that never contains titles, text, keys or paths. */
let deepRunning=false;
async function runDeepDiagnostics(){
 if(deepRunning)return;deepRunning=true;
 const recording=captureActive(nativeController?.snapshot)||Boolean(state.capture);
 modal('Глубокая диагностика','<p class="deep-progress" role="status">Проверяем ядро, архив, звук, Groq и окно — около 10 секунд.'+(recording?'':' Скажите что-нибудь в микрофон.')+'</p>');
 try{
  const local=await localLibraryClient();if(!recording)stopLevelCheck();
  const [server,windowInfo,microphone]=await Promise.all([
   local?local.json('/diagnostics',{signal:AbortSignal.timeout(45000)}).catch(error=>({error:error.code||error.message})):Promise.resolve(null),
   windowProbe().catch(()=>null),
   recording?Promise.resolve({raw:{skipped:'recording'}}):microphonePaths().catch(()=>null)]);
  const findings=consolidate([...(server?.findings||[]),...(server?.error?[{level:'warning',title:'Ядро не ответило на диагностику',detail:String(server.error),action:'Перезапустите MONO.'}]:[]),...windowFindings(windowInfo,null),...microphoneFindings(microphone,server?.capture?.probe,{engine:(await loadWindowState())?.engine})]);
  const report={generatedAt:new Date().toISOString(),findings,server:server&&!server.error?{...server,findings:undefined}:server,window:windowInfo,microphone,recentWindowErrors:recentErrors()};
  const text=formatReport(report);
  if($('#modal').hidden){notify('Диагностика готова','info',{text:'Показать',run:()=>showDeepReport(findings,text)});return}
  showDeepReport(findings,text,report);
 }catch(error){notify('Диагностика не завершилась: '+error.message,'error')}
 finally{deepRunning=false;syncLevelPreview()}
}
/** What was actually tested and worked — a check list, not only a fault list. */
function passedLine(report){
 const s=report.server||{},ok=[];
 if(s.core?.responds)ok.push('ядро');if(s.archive?.available&&s.archive.writeProbe==='ok')ok.push('запись в архив');
 if(typeof s.archive?.hoursLeft==='number'&&s.archive.hoursLeft>=2)ok.push('место на диске');
 if(s.capture?.probe?.opened&&s.capture.probe.peakDb>-90)ok.push('микрофон через системный модуль');
 if(report.microphone?.raw?.ok||report.microphone?.processed?.ok)ok.push('микрофон в окне');
 if(s.groq?.http===200)ok.push('связь с Groq');if((s.disks||[]).length&&s.disks.every(d=>d.health==='Healthy'))ok.push('здоровье диска');
 return ok.length?`<p class="deep-passed">✓ Работает: ${ok.join(', ')}.</p>`:'';
}
function showDeepReport(findings,text,report={}){
 const mark={warning:'✖',caution:'▲',advisory:'●'};
 const body=(findings.length?`<p>${findings.some(f=>f.level==='warning')?'Есть проблемы, которые мешают работе:':'Найдено:'}</p><ul class="deep-findings">${findings.map(f=>`<li data-level="${f.level}"><span class="deep-mark" aria-hidden="true">${mark[f.level]||'•'}</span><div><strong>${h(f.title)}</strong>${f.detail?`<span>${h(f.detail)}</span>`:''}${f.action?`<em>${h(f.action)}</em>`:''}</div></li>`).join('')}</ul>`:'<p><strong>Проблем не найдено.</strong></p>')+passedLine(report)+
  '<p class="field-hint">В отчёте нет названий записей, текста, ключей и путей к файлам. Названия звуковых устройств остаются — по ним видно, какой микрофон проверялся.</p><div class="inline-actions"><button type="button" class="btn btn-primary btn-small" id="deep-copy">Скопировать отчёт</button><button type="button" class="btn btn-outline btn-small" id="deep-save">Сохранить файл</button>'+(findings.some(f=>f.browser)?'<button type="button" class="btn btn-outline btn-small" id="deep-browser">Скопировать адрес MONO</button>':'')+'</div><p class="field-hint" id="deep-browser-hint" hidden></p>';
 modal('Глубокая диагностика',body);
 if($('#deep-browser'))$('#deep-browser').onclick=async()=>{const hint=$('#deep-browser-hint');hint.hidden=false;
  const address=location.origin;let copied=false;try{await navigator.clipboard.writeText(address);copied=true}catch{}
  hint.textContent=`${copied?'Адрес скопирован':'Адрес MONO'}: ${address}. Откройте Chrome или Edge сами, вставьте адрес и разрешите микрофон.`};const close=$('#modal-actions .btn-outline');if(close)close.textContent='Закрыть';
 $('#deep-copy').onclick=async()=>{try{await navigator.clipboard.writeText(text);$('#deep-copy').textContent='Скопировано'}catch(e){notify('Не удалось скопировать: '+e.message,'error')}};
 $('#deep-save').onclick=()=>downloadBlob(new Blob([text],{type:'text/plain;charset=utf-8'}),`MONO-диагностика-${new Date().toISOString().slice(0,16).replace(/[:T]/g,'-')}.txt`);
}
/** Window mode. «browser»: MONO opens as a tab in the person's own browser. A browser the person
 * started is not a program launched by MONO, so security software that restricts MONO's processes
 * (Kaspersky passes a parent's restrictions to its children) does not restrict its microphone. */
let windowState=null;
async function loadWindowState(){try{const local=await localLibraryClient();windowState=local?await local.json('/window'):null}catch{windowState=null}return windowState}
/** Settings read top to bottom by importance: connection and recognition first, the system check and
 * help last; an unfinished archive copy always comes first. */
const SETTINGS_ORDER=['Незавершённое копирование','Подключение Groq','Распознавание','Обработка аудио','Источники записи','Оформление','Архив и резервные копии','Обновление','Страховочная дорожка','Расходы','Предполётная проверка','Состояние системы','Как пользоваться MONO'];
/** Segmented controls mirror a hidden <select> (the select keeps the value and its change handler). */
function syncSegmented(){for(const group of document.querySelectorAll('.segmented[data-for]')){const select=document.getElementById(group.dataset.for);for(const button of group.querySelectorAll('button')){const on=button.dataset.value===select.value;button.setAttribute('aria-checked',String(on));button.tabIndex=on?0:-1}}}
function mountSegmented(){
 for(const group of document.querySelectorAll('.segmented[data-for]')){if(group.dataset.ready)continue;group.dataset.ready='1';const select=document.getElementById(group.dataset.for),buttons=[...group.querySelectorAll('button')];
  const choose=button=>{if(select.value===button.dataset.value)return;select.value=button.dataset.value;select.dispatchEvent(new Event('change',{bubbles:true}));syncSegmented()};
  group.addEventListener('click',event=>{const button=event.target.closest('button');if(button)choose(button)});
  group.addEventListener('keydown',event=>{const step={ArrowRight:1,ArrowDown:1,ArrowLeft:-1,ArrowUp:-1}[event.key];if(!step)return;event.preventDefault();const index=buttons.findIndex(button=>button.dataset.value===select.value),next=buttons[(index+step+buttons.length)%buttons.length];choose(next);next.focus()});
 }
 syncSegmented();
}
/** The settings index: one entry per visible card, in the cards' order; the entry of the card in view is highlighted. */
let settingsSpy=null;
function renderSettingsIndex(){
 const index=$('#settings-index'),grid=$('#view-settings .settings-grid');if(!index||!grid)return;
 const cards=[...grid.children].filter(card=>!card.hidden&&card.querySelector('h2')).sort((a,b)=>Number(a.style.order||0)-Number(b.style.order||0));
 const slug=text=>'set-'+text.toLowerCase().replace(/[^a-zа-яё0-9]+/gi,'-').replace(/^-|-$/g,'');
 index.replaceChildren(...cards.map(card=>{const title=card.querySelector('h2').textContent.trim();card.id||=slug(title);const link=document.createElement('a');link.href='#settings';link.dataset.target=card.id;link.dataset.tone=card.dataset.tone||'';
  const icon=card.querySelector('.settings-card-icon svg use')?.getAttribute('href')||'#i-settings';link.innerHTML=`<span class="settings-index-icon"><svg><use href="${icon}"/></svg></span><span></span>`;link.lastElementChild.textContent=SETTINGS_SHORT[title]||title;link.title=title;
  link.onclick=event=>{event.preventDefault();card.scrollIntoView({behavior:matchMedia('(prefers-reduced-motion: reduce)').matches?'auto':'smooth',block:'start'});mark(card.id)};return link}));
 const mark=id=>{for(const link of index.children)link.classList.toggle('active',link.dataset.target===id)};
 settingsSpy?.disconnect();settingsSpy=new IntersectionObserver(entries=>{const visible=entries.filter(entry=>entry.isIntersecting).sort((a,b)=>a.boundingClientRect.top-b.boundingClientRect.top)[0];if(visible)mark(visible.target.id)},{root:$('#main'),rootMargin:'-10% 0px -70% 0px'});
 for(const card of cards)settingsSpy.observe(card);if(cards[0])mark(cards[0].id);
}
/** The status light in the top bar, like a master caution: MONO checks its systems at start, every
 * five minutes, when the window comes back and when a device is plugged in; one glance says whether a
 * recording can start, and a click opens the full check. */
function mountSystemStatus(model){
 const button=$('#system-status');if(!button||button.dataset.ready)return;button.dataset.ready='1';button.hidden=false;
 const text=button.querySelector('.system-status-text');
 const LABEL={ok:'Системы в норме',advisory:'Системы в норме',caution:'Есть ограничения',warning:'Нужно действие'};
 model.subscribe(result=>{const notable=result.checks.filter(item=>['caution','warning'].includes(item.level));button.dataset.level=result.level;
  text.textContent=notable.length>1?`${LABEL[result.level]} · ${notable.length}`:LABEL[result.level]||'Системы';
  button.title=notable.length?notable.map(item=>'• '+item.title).join('\n'):'Все проверки пройдены. Нажмите, чтобы открыть подробности.'});
 button.onclick=()=>{go('settings');requestAnimationFrame(()=>document.getElementById('set-предполётная-проверка')?.scrollIntoView({block:'start'}))};
 const again=()=>void model.run().catch(()=>{});
 setInterval(()=>{if(!document.hidden)void model.run({force:true}).catch(()=>{})},5*60*1000);
 addEventListener('focus',again);addEventListener('online',again);navigator.mediaDevices?.addEventListener?.('devicechange',()=>void model.run({force:true}).catch(()=>{}));
 again();
}
const SETTINGS_ICONS={'Как пользоваться MONO':'#i-sparkle','Незавершённое копирование':'#i-refresh'};
const SETTINGS_SHORT={'Подключение Groq':'Groq','Архив и резервные копии':'Архив','Страховочная дорожка':'Страховка','Предполётная проверка':'Проверка','Как пользоваться MONO':'Справка','Незавершённое копирование':'Копирование','Источники записи':'Источники'};
const SETTINGS_TONES={'Источники записи':'red','Страховочная дорожка':'pink','Предполётная проверка':'green','Как пользоваться MONO':'blue','Незавершённое копирование':'orange'};
function orderSettings(){
 const grid=$('#view-settings .settings-grid');if(!grid)return;
 for(const card of grid.children){const title=card.querySelector('h2')?.textContent?.trim()||'',index=SETTINGS_ORDER.indexOf(title);card.style.order=String(index<0?SETTINGS_ORDER.length:index);if(!card.dataset.tone&&SETTINGS_TONES[title])card.dataset.tone=SETTINGS_TONES[title];if(title&&!card.querySelector(':scope>.settings-card-icon')){const icon=document.createElement('div');icon.className='settings-card-icon';icon.innerHTML=`<svg><use href="${SETTINGS_ICONS[title]||'#i-sparkle'}"/></svg>`;card.prepend(icon)}}
 if(!grid.dataset.ordered){grid.dataset.ordered='1';let queued=0;new MutationObserver(records=>{if(records.some(record=>record.type==='childList'||record.target.parentElement===grid)&&!queued)queued=requestAnimationFrame(()=>{queued=0;orderSettings()})}).observe(grid,{childList:true,subtree:true,attributes:true,attributeFilter:['hidden']})}
 renderSettingsIndex(); // cards added later (modules, recovery) take their place too
}
/** Offline update: the person picks a .monoupdate file; MONO checks its signature and every file's
 * hash, unpacks it beside the app, and MONO.exe switches to it on the next start. */
async function renderUpdateCard(){
 const card=$('#update-card');if(!card)return;let info=null;
 try{const local=await localLibraryClient();info=local?await local.json('/update'):null}catch{}
 if(!info?.supported){card.hidden=true;return}card.hidden=false;
 const status=$('#update-status'),button=$('#update-install');
 $('#update-summary').textContent=`MONO ${info.version}`;
 status.textContent=info.pending?`Версия ${info.pending} проверена и будет установлена при следующем запуске MONO. Закройте окно MONO и запустите его снова.`:info.applied?.result==='rolled-back'?`Обновление до ${info.applied.version} не удалось применить — MONO вернул прежнюю версию. Попробуйте ещё раз.`:!info.signed?'В этой сборке не настроена подпись обновлений: MONO не примет файл, который нельзя проверить.':'';
 button.disabled=!info.signed;
 button.onclick=()=>{const input=$('#update-input');input.value='';input.onchange=async()=>{const file=input.files?.[0];if(!file)return;button.disabled=true;status.textContent=`Проверяем подпись и файлы «${file.name}»…`;
  try{const local=await localLibraryClient(),result=await local.json('/update',{method:'POST',body:file,headers:{'Content-Type':'application/octet-stream'}});status.textContent=`Готово: версия ${result.version} проверена (${result.files} файлов). Закройте окно MONO и запустите его снова — обновление установится само.`;notify(`Обновление ${result.version} готово к установке при следующем запуске.`)}
  catch(error){status.textContent=error.message||'Файл обновления не принят.'}finally{button.disabled=false}};input.click()};
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
/** Session: where the person is, so that closing MONO and starting it again continues the work.
 * Unfinished work = a record left open in the editor (or a transcription still running). Someone who
 * went back to the library or the overview has finished, and MONO starts on the overview. */
const session={
 key:'mono-session-2',restoring:false,
 read(){try{return JSON.parse(localStorage.getItem(this.key)||'null')}catch{return null}},
 save(patch){if(this.restoring)return;try{const value={...(this.read()||{}),...patch,at:Date.now()};localStorage.setItem(this.key,JSON.stringify(value))}catch{}},
 resumable(records){
  const last=this.read();if(!last||Date.now()-(last.at||0)>30*24*3600*1000)return null;
  if(last.view==='editor'&&last.id){const record=records.find(r=>r.id===last.id);if(record&&!record.trashed)return {hash:`editor/${encodeURIComponent(last.id)}`,...last}}
  if(last.view==='jobs'&&records.some(r=>['uploading','queued','processing'].includes(r.status)))return {hash:'jobs',...last};
  return null;
 },
 async restore(last){
  this.restoring=true;
  try{
   if(last.view==='editor'){
    for(let i=0;i<60&&!(state.editorId===last.id&&document.querySelector('#editor-segments,#view-editor .editor-workspace'));i++)await new Promise(r=>setTimeout(r,100));
    await new Promise(r=>setTimeout(r,250));
    if(last.time>0){const time=last.time;if(audioReview?.player)await audioReview.player.seek(time).catch(()=>{});else{const a=$('#audio-element');const apply=()=>{try{a.currentTime=time}catch{}};a.readyState>=1?apply():a.addEventListener('loadedmetadata',apply,{once:true})}}
   }
   if(last.scroll>0)$('#main').scrollTop=last.scroll;
  }finally{this.restoring=false}
 },
 watch(){
  if(this.watching)return;this.watching=true;let queued=0;
  $('#main').addEventListener('scroll',()=>{if(queued)return;queued=setTimeout(()=>{queued=0;this.save({scroll:Math.round($('#main').scrollTop)})},400)},{passive:true});
  setInterval(()=>{if(state.view!=='editor'||document.hidden)return;const time=audioReview?.player?audioReview.player.time:$('#audio-element')?.currentTime;if(Number.isFinite(time))this.save({time:Math.round(time*10)/10})},2000);
  addEventListener('pagehide',()=>{const time=audioReview?.player?audioReview.player.time:$('#audio-element')?.currentTime;this.save({scroll:Math.round($('#main').scrollTop),...(state.view==='editor'&&Number.isFinite(time)?{time:Math.round(time*10)/10}:{})})});
 }
};
function escapeNext(){return location.hash.slice(1).split('/')[0]}
function go(view,id=null){
  location.hash=view==='editor'&&id?`#editor/${encodeURIComponent(id)}`:`#${view}`;
  renderRoute();
}
function renderRoute({preserveDrawer=false}={}){
  const [requested,id]=location.hash.slice(1).split('/');
  let view=['dashboard','record','library','jobs','editor','settings'].includes(requested)?requested:'dashboard';
  if(state.view==='settings'&&view!=='settings')credentialForm?.clear();
  if(view==='settings'&&state.view!=='settings'){void credentialForm?.refresh();orderSettings();void renderUpdateCard()}
  if(view==='editor'){
    if(!id||!state.records.some(r=>r.id===id)){view='library';}
    else if(state.editorId!==id||state.view!=='editor'){state.editorId=id;state.editorPage=0;void renderEditor(id).catch(e=>notify(e.message,'error'))}
  }
 if(state.view==='editor'&&view!=='editor'){if(audioReview){audioReview.player.pause();void audioReview.cancel(true).catch(e=>notify(e.message,'error'))}else $('#audio-element').pause()}
  const prior=state.view;state.view=view;try{if(view!=='editor')localStorage.setItem('mono-last-view',view)}catch{}
  if(prior!==view||(view==='editor'&&session.read()?.id!==state.editorId))session.save({view,id:view==='editor'?state.editorId:null,scroll:0,time:0});
  if(view==='settings')document.querySelectorAll('.archive-recovery-notice').forEach(notice=>notice.remove());
  $$('.view').forEach(el=>el.classList.toggle('active',el.id==='view-'+view));
  $$('.nav-link[data-view]').forEach(el=>(el.classList.toggle('selected',el.dataset.view===view),el.setAttribute('aria-current',el.dataset.view===view?'page':'false')));
  const titles={dashboard:'Обзор',record:'Запись',library:'Библиотека',jobs:'Расшифровка',editor:'Редактор',settings:'Настройки'};
  $('#current-breadcrumb').textContent=titles[view];
  if(!preserveDrawer)closeDrawer('route');
  if(view==='library')renderLibrary();
  if(view==='jobs')renderJobs();
  if(view==='record'&&state.previewView!=='record')state.viewVisit=(state.viewVisit||0)+1;state.previewView=view;
  syncLevelPreview();
  $('#main').scrollTo({top:0,behavior:'instant'});
}
const autoTitled=new Set();
/** Finished transcripts name their own records (only automatic names, once per record). */
async function nameFromTranscripts(){
 let changed=0;
 for(const rec of state.records.filter(r=>r.status==='completed'&&DEFAULT_TITLE.test(r.title||'')&&!autoTitled.has(r.id)).slice(0,5)){
  autoTitled.add(rec.id);
  try{const segments=storageDetails().local?(await transcriptPage(rec.id,{offset:0,limit:12})).segments:(await getRecording(rec.id))?.transcript?.segments;
   const title=suggestTitle(segments);if(!title)continue;
   await getRecording(rec.id);await patchRecording(rec.id,{title});rec.title=title;changed++;
  }catch{}
 }
 return changed;
}
const lastStatus=new Map();
async function refresh(){
  state.records=(await listRecordings()).sort((a,b)=>new Date(b.createdAt)-new Date(a.createdAt));
  // Local archive: a transcript finishing in the background is announced once.
  if(storageDetails().local)for(const r of state.records){const before=lastStatus.get(r.id);lastStatus.set(r.id,r.status);
   if(before&&['queued','processing','uploading'].includes(before)&&r.status==='completed'){notify(`Расшифровка «${r.title}» готова`,'info',{text:'Открыть',run:()=>go('editor',r.id)});if(document.hidden)markDoneWhileAway()}}
  void nameFromTranscripts().then(changed=>{if(changed){renderDashboard();if(state.view==='library')renderLibrary()}}).catch(()=>{});
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
    <span class="item-main"><strong>${h(r.title)}</strong><span>${fmtDate(r.createdAt)} · ${durationText(recordedSeconds(r))} · ${sizeText(r.size||0)}</span></span>
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
    if(filter==='trash'&&r.title==='Проверка звука')return false; // setup sound checks are not the person's recordings
    if(filter==='completed'&&r.status!=='completed')return false;
    if(filter==='saved'&&['completed','recording','requesting','paused','damaged','importing','migrating'].includes(r.status))return false;
    const texts=(r.transcript?.segments||[]).map(s=>s.text).join(' ');
    return local||!q||`${r.title} ${texts}`.toLowerCase().includes(q);
  });
  if(sort==='oldest')records=records.sort((a,b)=>new Date(a.createdAt)-new Date(b.createdAt));
  if(sort==='name')records=records.sort((a,b)=>a.title.localeCompare(b.title,'ru'));
  if(sort==='longest')records=records.sort((a,b)=>(b.duration||0)-(a.duration||0));
  const totalSeconds=records.reduce((sum,r)=>sum+(r.duration||0),0);
  $('#library-count').textContent=`${records.length} ${({one:'ЗАПИСЬ',few:'ЗАПИСИ'})[new Intl.PluralRules('ru-RU').select(records.length)]||'ЗАПИСЕЙ'}`+(totalSeconds>0?` · ${durationText(totalSeconds)}`:'');
  const signature=JSON.stringify([q,filter,sort,settings.rate,records.map(r=>[r.id,r.version,r.status,r.title,r.trashed])]);
  if(signature===state.librarySignature&&$('#library-list').childElementCount)return; // identical list: no DOM rebuild
  state.librarySignature=signature;
  $('#library-list').innerHTML=records.length?records.map(r=>`
   <article class="record-card glass"><div class="record-card-head"><span class="item-icon">${icon('file')}</span><span class="record-status">${statusLabel(r)}</span></div>
   <h3 title="${h(r.title)}">${h(r.title)}</h3><p class="record-sub">${fmtDate(r.createdAt)} · ${h(r.source||'Импорт')}</p>
   <div class="record-card-meta"><div><span>ДЛИТЕЛЬНОСТЬ</span><strong title="${pausedSeconds(r)?'С паузами: '+durationText(r.duration):''}">${durationText(recordedSeconds(r))}</strong></div><div><span>РАЗМЕР</span><strong>${sizeText(r.size||0)}</strong></div><div><span>СТОИМОСТЬ · ОЦЕНКА</span><strong>${money((r.estimatedUSD||0)*settings.rate)} ₽</strong></div></div>
   <div class="record-card-actions">${r.trashed?`<button class="btn btn-outline btn-small" data-restore="${h(r.id)}" data-version="${r.version}">Восстановить ${icon('refresh')}</button>`:`<button class="btn ${r.status==='completed'?'btn-primary':'btn-outline'} btn-small" data-open="${h(r.id)}">${r.status==='completed'?'Открыть текст':'Открыть запись'} ${icon('arrow')}</button>
   <div class="card-icon-actions"><button class="icon-btn" data-rename="${h(r.id)}" title="Переименовать" aria-label="Переименовать запись">${icon('file')}</button><button class="icon-btn" data-delete="${h(r.id)}" title="Удалить запись" aria-label="Удалить запись">${icon('trash')}</button></div>`}</div></article>`).join(''):
   `<div class="glass" style="grid-column:1/-1;border-radius:18px"><div class="empty-state">${icon('library')}<strong>${filter==='trash'?'Корзина пуста':($('#library-search').value.trim()?'Ничего не найдено':'Записей пока нет')}</strong><p>${filter==='trash'?'Здесь можно восстановить удалённые записи.':$('#library-search').value.trim()?`По запросу «${h($('#library-search').value.trim())}» ничего нет. Очистите поиск или измените фильтр.`:state.records.length?'Измените фильтр.':'Создайте запись или импортируйте аудио.'}</p>${filter==='trash'?'':`<button class="btn btn-outline btn-small" data-go="record">Студия записи ${icon('arrow')}</button>`}</div></div>`;
}
/** «~3 мин» from the pace so far (segments done since this job started on this screen). */
const jobPace=new Map();
function jobEta(r){
 const done=r.job?.completed||0,total=r.job?.total||0;if(!['processing','uploading'].includes(r.status)||!total||done>=total)return '';
 const now=Date.now();let pace=jobPace.get(r.id);if(!pace||done<pace.done)jobPace.set(r.id,pace={at:now,done});
 if(done<=pace.done||now-pace.at<5000)return '';const perSegment=(now-pace.at)/(done-pace.done),minutes=Math.max(1,Math.round(perSegment*(total-done)/60000));
 return `Осталось ~${minutes} мин · `;
}
function renderJobs(){
 const items=state.records.filter(r=>r.jobId||r.status==='uploading').sort((a,b)=>new Date(b.createdAt)-new Date(a.createdAt));
 $('#jobs-list').innerHTML=items.length?items.map(r=>{
  const progress=r.job?.total?Math.min(100,Math.round(r.job.completed/r.job.total*100)):0;
  const failed=r.status==='failed',active=['queued','processing'].includes(r.status);
  return `<article class="job-card glass"><div class="job-top"><div><h3>${h(r.title)}</h3><p>${h(r.job?.stage||statusLabel(r))}${r.job?.error?' · '+h(r.job.error):''}</p></div><span class="record-status">${statusLabel(r)}</span></div>
  <div class="job-progress-track" role="progressbar" aria-valuenow="${progress}" aria-valuemin="0" aria-valuemax="100"><div class="job-progress-fill" style="width:${progress}%"></div></div>
  <div class="job-bottom"><span>${jobEta(r)}${r.job?.total?`Обработано ${r.job.completed||0} из ${r.job.total} фрагментов`:'Ожидание информации от сервера'}</span>
  <div>${failed?`<button class="btn btn-outline btn-small" data-retry="${h(r.id)}">${icon('refresh')} Повторить</button>`:''}${active?`<button class="btn btn-outline btn-small" data-cancel="${h(r.id)}">Отменить</button>`:''}${r.status==='completed'?`<button class="btn btn-primary btn-small" data-open="${h(r.id)}">Открыть текст ${icon('arrow')}</button>`:''}</div></div></article>`;
 }).join(''):`<div class="glass" style="border-radius:18px"><div class="empty-state">${icon('activity')}<strong>Сейчас ничего не расшифровывается</strong><p>${state.records.some(r=>r.size&&!r.transcriptSummary&&!r.transcript&&r.status==='saved')?'Есть записи без расшифровки — откройте запись и нажмите «Расшифровать».':'Запишите встречу или импортируйте аудио, затем нажмите «Расшифровать».'}</p><button class="btn btn-outline btn-small" data-go="library">Открыть библиотеку ${icon('arrow')}</button></div></div>`;
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
 const video=Boolean(file)&&(file.type.startsWith('video/')||/\.(m4v|mov|mkv|avi|wmv|flv|ts|mts|m2ts|3gp|mpg|mpeg|ogv)$/i.test(file.name)||/\.mp4$/i.test(file.name)&&!file.type.startsWith('audio/'));
 if(!file||!(video||/\.(wav|mp3|m4a|ogg|opus|webm|flac|aac|wma|aiff?|amr)$/i.test(file.name)||file.type.startsWith('audio/'))){notify('Выберите аудио- или видеофайл.','error');return}
 const importLimit=storageDetails().local?32*1024**3:1024**3;
 if(file.size>importLimit){notify(`Файл больше ${storageDetails().local?'32':'1'} ГБ. Разбейте его перед импортом.`,'error');return}
 const id=crypto.randomUUID(),duration=video?0:await fileDuration(file);
 const rec={id,title:file.name.replace(/\.[^.]+$/,'').slice(0,130),createdAt:new Date().toISOString(),
  duration,mime:video?(file.type||'video/mp4'):(file.type||mimeForName(file.name)),size:file.size,source:video?'Видео':'Импорт файла',chunkCount:0,status:'saved',...(video?{video:true}:{})};
 if(video&&!storageDetails().local){notify('Видео обрабатывается только в приложении MONO на компьютере.','error');return}
 if(video)notify(`Извлекаем звук из видео «${rec.title}»… Длинное видео может занять несколько минут; окно можно не держать открытым на этом разделе.`,'info');
 try{await saveImportedRecording(rec,file);await refresh();notify(video?'Звук из видео сохранён — его можно расшифровать.':'Аудиофайл сохранён.');go('library')}
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
 if(storageDetails().local&&!storageDetails().libraryConfigured&&!await ensureArchive('record'))return;
 if(storageDetails().local){try{if(!nativeController)throw new Error('Подключите папку архива перед записью.');if(!nativeController.snapshot.connected){try{await nativeController.connect()}catch(error){notify(`Модуль записи не отвечает${error?.code?' ('+error.code+')':''}. Откройте «Настройки → Предполётная проверка».`,'error');void preflight?.run({force:true}).catch(()=>{});return}}const blocked=await preflight?.gate();if(blocked){notify(`${blocked.title}. ${blocked.action||blocked.detail||''}`.trim(),'error');void preflight.run({force:true}).catch(()=>{});return}await startWithAutopilot(await autopilotBeforeStart(await captureSources.selection()))}catch(error){if(error?.name!=='AbortError')void notifyCaptureError(error.message||'Не удалось начать запись.',error.code)}return}
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
   $('#start-record').hidden=true;$('#pause-record').hidden=false;$('#stop-record').hidden=false;$('#mark-record').hidden=false;$('.studio-buttons').classList.add('is-recording');
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
/** The timer runs like a clock (smooth seconds) between archive confirmations, which arrive in
 * ~2 s chunks; it never runs more than 3 s ahead of what is confirmed and freezes on pause. */
const recordClock={session:null,base:0,at:0,shown:0};
function smoothSeconds(value){
 // Shows recorded time (pauses excluded) on both engines. The browser engine's confirmed duration
 // includes pauses (they stay on the timeline as gaps), so it only bounds the clock, never jumps it.
 const now=performance.now(),confirmed=Number(value.duration)||0,session=value.sessionId||value.recordId,browser=value.engine==='browser';
 if(recordClock.session!==session){Object.assign(recordClock,{session,at:now,shown:browser?0:confirmed})}
 const dt=Math.max(0,(now-recordClock.at)/1000);recordClock.at=now;
 if(value.state==='recording')recordClock.shown=Math.min(recordClock.shown+dt,confirmed+3);
 if(!browser)recordClock.shown=Math.max(recordClock.shown,Math.min(confirmed,recordClock.shown+3)); // module: catch up to confirmed
 return recordClock.shown;
}
/** Pauses stay on the timeline as «paused» gaps; the studio timer and the library show recorded time. */
function pausedSeconds(r){return (r?.gapMarkers||[]).filter(g=>g.reason==='paused').reduce((n,g)=>n+Math.max(0,Number(g.end)-Number(g.start)),0)}
function recordedSeconds(r){return Math.max(0,(Number(r?.duration)||0)-pausedSeconds(r))}
function currentRecordingSeconds(){
 const r=state.capture;if(!r)return 0;
 if(r.native)return smoothSeconds(r.snapshot);
 return Math.max(0,((r.paused?r.pauseStart:performance.now())-r.start-r.pauseMs)/1000);
}
function updateRecordUI(){
 const r=state.capture;
 if(r?.native){const value=r.snapshot,labels={requesting:'Подключаем звук',recording:'Идёт запись',paused:'Пауза',stopping:'Сохраняем'};$('#record-state').classList.toggle('recording',value.state==='recording'&&value.connected);setText('#record-state',value.connected?labels[value.state]:'Нет связи');setText('#record-caption',value.state==='paused'?'ПАУЗА СОХРАНЯЕТСЯ НА ШКАЛЕ ВРЕМЕНИ':value.state==='recording'?'ОКНО МОЖНО СВЕРНУТЬ — ЗАПИСЬ ПРОДОЛЖИТСЯ':'ОЖИДАЕМ ПОДТВЕРЖДЕНИЕ');setText('#record-timer',durationText(smoothSeconds(value)));return}
 $('#record-state').classList.toggle('recording',Boolean(r&&!r.paused));
 $('#record-state').innerHTML=r?(r.paused?'Пауза':`<span class="tiny-dot"></span> Идёт запись`):`<span class="tiny-dot"></span> Ожидание`;
 $('#record-caption').textContent=r?(r.paused?'ЗАПИСЬ ПРИОСТАНОВЛЕНА':'ЗАПИСЬ В ПРОЦЕССЕ'):levelPreview.active?'МИКРОФОН ПРОСЛУШИВАЕТСЯ · НЕ ЗАПИСЫВАЕТСЯ':'ГОТОВО К ЗАПИСИ';
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
  await patchRecording(r.id,{duration:r.finalSeconds||0,status,peaks:r.peaks.slice(-500),...(takeMarks.id===r.id&&takeMarks.marks.length?{bookmarks:takeMarks.marks}:{})});if(takeMarks.id===r.id)Object.assign(takeMarks,{id:null,marks:[]});
  notify(status==='saved'?'Запись сохранена.':'Запись прервана; доступные фрагменты сохранены.',status==='saved'?'info':'error');
 }catch(e){notify('Ошибка завершения записи: '+e.message,'error')}
 if(state.capture===r){state.capture=null;state.recordingId=null}
 $('#audio-source').disabled=false;$('#start-record').hidden=false;$('#pause-record').hidden=true;$('#stop-record').hidden=true;$('#mark-record').hidden=true;$('.studio-buttons').classList.remove('is-recording');
 $('#pause-record').disabled=false;$('#stop-record').disabled=false;$('#pause-record').innerHTML=`${icon('pause')} Пауза`;
 $('#record-saved').textContent='Данные сохраняются на этом устройстве';
 updateRecordUI();await refresh();go('library');
 const finished=state.records.find(x=>x.id===r.id);
 if(finished?.status==='saved'&&state.health?.groq&&state.health?.ffmpeg&&state.health?.ffprobe){
   void startTranscription(finished);
 }
}
/** Studio rendering budget (weak laptops): the wave is drawn at ≤30 fps and only when it
 * changes; the meter moves with transform (no layout); the dB figure updates ≤5×/s.
 * Before: ~20 layouts and ~180 ms of main thread per second at 4× CPU throttling. */
/** On battery below 30 %, glass turns solid and the wave runs at 15 fps (restored on charge). */
const batterySaver={on:false};
void globalThis.navigator?.getBattery?.().then(b=>{const update=()=>{const on=!b.charging&&b.level<.3;if(on===batterySaver.on)return;batterySaver.on=on;document.documentElement.classList.toggle('lite-glass',on||localStorage.getItem('mono-lite-glass')==='1')};update();b.addEventListener('chargingchange',update);b.addEventListener('levelchange',update)}).catch(()=>{});
const meter={scale:-1,text:'',at:0};let waveDrawnAt=0,waveSignature='';
function setMeter(rms,now){
 const db=rms>0?20*Math.log10(rms):-90,scale=rms>0?Math.max(0,Math.min(1,(db+65)/65)):0;
 if(Math.abs(scale-meter.scale)>.004){$('#level-fill').style.transform=`scaleX(${scale.toFixed(3)})`;meter.scale=scale}
 if(now-meter.at>200){meter.at=now;const text=rms>0?`${Math.round(db)} dB`:'−∞ dB';if(text!==meter.text){meter.text=text;setText('#level-num',text)}}
}
function drawWave(now=performance.now()){
 nativeFrame=0;
 const r=state.capture,keepGoing=Boolean(state.capture)||levelPreview.active&&state.view==='record';
 if(r?.native&&now-(recordClock.paintedAt||0)>250){recordClock.paintedAt=now;setText('#record-timer',durationText(smoothSeconds(r.snapshot)))}
 if(now-waveDrawnAt<(batterySaver.on?66:32)){if(keepGoing)nativeFrame=requestAnimationFrame(drawWave);return}
 const step=Math.min(4,Math.max(1,Math.round((now-waveDrawnAt)/33)));waveDrawnAt=now;
 const canvas=$('#record-wave'),c=canvas.getContext('2d');
 const values=[];
 if(r&&!r.paused){
   let rms=0;
   if(r.native){rms=r.snapshot.connected&&r.snapshot.state==='recording'?Math.max(0,...Object.values(r.snapshot.levels||{}).map(level=>level.rms||0)):0}
   else{const a=new Uint8Array(r.capture.analyser.fftSize);r.capture.analyser.getByteTimeDomainData(a);for(const v of a){const f=(v-128)/128;rms+=f*f}rms=Math.sqrt(rms/a.length)}
   setMeter(rms,now);
   for(let k=0;k<step;k++)r.peaks.push(Math.min(1,rms*5));if(r.peaks.length>500)r.peaks.splice(0,r.peaks.length-500);
   values.push(...r.peaks.slice(-90));
 }else{
   const rms=!r&&levelPreview.active?levelPreview.rms():0;setMeter(rms,now);
   if(rms>0){const peaks=state.previewPeaks||(state.previewPeaks=[]);for(let k=0;k<step;k++)peaks.push(Math.min(1,rms*5));if(peaks.length>90)peaks.splice(0,peaks.length-90);values.push(...peaks)}
   else for(let i=0;i<90;i++)values.push(storageDetails().local||r?.paused?0:.045+Math.sin(i*1.71)**2*.07);
 }
 const dark=document.body.dataset.theme==='dark',signature=dark+values.map(v=>Math.round(v*60)).join(',');
 if(signature!==waveSignature){
  waveSignature=signature;const width=canvas.width,height=canvas.height;c.clearRect(0,0,width,height);
  const count=90,gap=width/count,bar=3.8;c.fillStyle=dark?'rgba(237,237,238,.85)':'rgba(38,39,43,.82)';
  for(let i=0;i<count;i++){const v=values[Math.max(0,values.length-count+i)]??.035,bh=Math.max(3,v*(height*.83));c.globalAlpha=i<count-20?.35+(i/count)*.5:1;c.fillRect(i*gap+gap/2-bar/2,(height-bh)/2,bar,bh)}
  c.globalAlpha=1;
 }
 if(state.capture&&!r?.native)updateRecordUI();
 if(keepGoing)nativeFrame=requestAnimationFrame(drawWave);
}
/** Connect Groq in place (sheet), then continue what the person was doing. */
function connectGroq(onConnected){
 modal('Подключите Groq','<p class="field-hint">Расшифровка работает через ваш аккаунт Groq. Ключ хранится в защищённом хранилище системы и не покидает этот компьютер.</p><div class="groq-sheet"></div>');
 const host=$('#modal .groq-sheet');let done=false;
 void localLibraryClient().then(local=>{
  mountCredentials(host,{client:new CredentialsClient(local),onChange:value=>{
   if(!value.configured||done)return;done=true;closeModal();void credentialForm?.refresh();void checkHealth().finally(()=>{notify('Groq подключён.');void Promise.resolve().then(onConnected).catch(error=>notify(error.message,'error'))});
  }});
  host.querySelector('input')?.focus();
 }).catch(error=>notify(error.message,'error'));
}
async function startTranscription(rec){
 if(archiveOperation){notify('Дождитесь завершения операции с архивом.','error');return}
 if(!rec||rec.status==='recording'||!rec.size){notify('Нет доступного аудиофайла.','error');return}
 if(['queued','processing','uploading'].includes(rec.status)){go('jobs');return}
 const selection=captureSelection(rec.id,audioReview?.selected,{...settings,prompt:promptWithTerms(settings.prompt,learnedTerms())});
 if(rec.status==='completed'){
  modal('Повторная транскрибация',`Вариант: ${selection.title}.\n\nЭто создаст новый платный запрос и заменит текущую расшифровку. Исходный звук останется на устройстве. Продолжить?`,
   [{text:'Повторить',primary:true,run:()=>uploadTranscription(rec,true,selection)}]);return;
 }
 if(!state.health?.ffmpeg||!state.health?.ffprobe){
  // Tool detection may still be running (first FFmpeg launch under antivirus): wait for it.
  try{state.health=await (await fetch('/api/health?wait=tools',{cache:'no-store',signal:AbortSignal.timeout(70000)})).json()}catch{}
 }
 if(storageDetails().local&&!state.health?.groq){connectGroq(()=>startTranscription(rec));return}
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
       start:s.start,end:s.end,text:s.text,original:s.text,id:i,...(Number.isFinite(s.confidence)?{confidence:s.confidence}:{})
     }));
     await patchRecording(r.id,{status:'completed',duration:data.duration||r.duration,
       completedAt:new Date().toISOString(),estimatedUSD:job.estimatedUSD||0,
       transcript:{segments,rawText:data.text,model:data.model},job:{stage:'Завершено',completed:job.total,total:job.total}});
     // Client has durably persisted transcript, so delete the server copy.
     const ack=await jobFetch(`/api/jobs/${r.jobId}/ack`,{method:'POST'}).catch(()=>null);
     if(ack?.ok||ack?.status===404)await patchRecording(r.id,{serverAcked:true});
     notifyLater(`Расшифровка «${r.title}» готова`);changed=true;if(document.hidden)markDoneWhileAway();
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
 // Enter saves (the primary action); the old title is pre-selected for typing over it.
 const input=$('#rename-input');input.focus();input.select();
 input.addEventListener('keydown',e=>{if(e.key==='Enter'&&!e.isComposing){e.preventDefault();$('#modal-actions .btn-primary')?.click()}});
}
function deleteRecord(rec){
 if(storageDetails().local){
  // Reversible, so no confirmation dialog: move to trash and offer «Вернуть» (HIG: prefer undo over confirm).
  void (async()=>{try{const result=await removeRecording(rec.id);await refresh();
   notify(`«${rec.title.length>40?rec.title.slice(0,39)+'…':rec.title}» в корзине`,'info',{text:'Вернуть',run:async()=>{await restoreRecording(rec.id,result.version);await refresh();notify('Запись восстановлена.')}});
  }catch(e){notify(e.message,'error')}})();return;
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
 $('#editor-duration').textContent=durationText(recordedSeconds(rec))+(pausedSeconds(rec)>=1?` · с паузами ${durationText(rec.duration)}`:'');
 const hasTranscript=Boolean(rec.transcriptSummary||rec.transcript);$('#editor-segments-count').textContent=(rec.transcriptSummary?.segmentCount??rec.transcript?.segments?.length??0).toLocaleString('ru-RU');
 $('#editor-status').textContent=statusLabel(rec);
 let marks=$('#editor-marks');if(!marks){marks=document.createElement('div');marks.id='editor-marks';marks.className='editor-marks';$('.editor-source-actions').before(marks)}
 marks.innerHTML=(rec.bookmarks||[]).length?'<span class="marks-label">Отметки</span>'+rec.bookmarks.map(m=>`<button type="button" class="mark-chip" data-seek="${Number(m.at)||0}" title="Перейти к отметке">★ ${shortTime(m.at)}${m.label&&m.label!=='Важно'?' · '+h(m.label):''}</button>`).join(''):'';
 $('#editor-heading').textContent=rec.title;
 $('#editor-helper').textContent=hasTranscript?'Правки сохраняются сами.':'Расшифровки пока нет.';
 $('#copy-transcript').hidden=!hasTranscript;$('#export-transcript').hidden=!hasTranscript;$('#editor-transcribe').textContent=hasTranscript?'Расшифровать заново':'Расшифровать';$('#editor-transcribe').disabled=['recording','requesting','processing','queued','uploading'].includes(rec.status)||!rec.size;$('#editor-download').disabled=!rec.size;
 renderSummary(rec);void renderEditorSegments(rec);
 if(state.playerURL)URL.revokeObjectURL(state.playerURL);
 state.playerURL=null;
 const audio=$('#audio-element');audio.pause();audio.removeAttribute('src');
 if(storageDetails().local){
  if(!audioReview){const tools=document.createElement('section');tools.className='audio-tools';tools.id='audio-tools';tools.innerHTML='<h2 class="audio-tools-title">Улучшить звук перед расшифровкой</h2>';const host=document.createElement('section');host.setAttribute('aria-label','Подготовка и сравнение аудио');tools.append(host);$('#editor-pagination').after(tools);audioReview=new AudioReview({library:await localLibraryClient(),host,original:audio,play:media=>{if(!canAudition()||!mediaInterlock)return Promise.reject(new Error('Завершите запись перед прослушиванием.'));return mediaInterlock.play(media)},onError:error=>notify(error.message,'error'),onPlayer:value=>{followPlayback(value.time);setText('#player-now',shortTime(value.time));setText('#player-total',shortTime(value.duration));$('#player-seek').value=String(value.duration?Math.floor(1000*value.time/value.duration):0);const button=$('#player-toggle'),playing=String(value.playing);if(button.dataset.playing!==playing){button.dataset.playing=playing;button.innerHTML=icon(value.playing?'pause':'play');button.setAttribute('aria-label',value.playing?'Приостановить воспроизведение':'Воспроизвести запись')}}})}
  audioReview.captureState(nativeController?.snapshot||{connected:false});audioReview.open(rec,audioURL(rec));void loadWave(rec);return;
 }
 try{const url=audioURL(rec);if(url){audio.src=url}else{const blob=await getBlob(rec);if(state.editorId!==id)return;state.playerURL=URL.createObjectURL(blob);audio.src=state.playerURL}audio.load();
 }catch(e){notify('Оригинальное аудио недоступно: '+e.message,'error')}
 $('#player-total').textContent=shortTime(rec.duration);
 $('#player-now').textContent='00:00';$('#player-seek').value='0';$('#player-toggle').innerHTML=icon('play');
}
let playerWave=null;
/** The spectral waveform of the record that is open (computed once on the computer, then cached). */
async function loadWave(rec){
 playerWave??=new PlayerWave($('#player-wave'),$('#player-seek'));playerWave.clear();
 if(!storageDetails().local||!rec?.size||['recording','requesting','paused','importing','migrating'].includes(rec.status))return;
 try{const local=await localLibraryClient(),data=await local.json(`/records/${rec.id}/peaks`,{signal:AbortSignal.timeout(120000)});if(state.editorId===rec.id)playerWave.load(data)}catch{/* the plain seek bar stays */}
}
// ---- Transcript intelligence: on-device analysis + the meeting summary (on request) ----
const TERMS_KEY='mono-learned-terms',SMART_KEY='mono-smart-speed';
function learnedTerms(){try{const v=JSON.parse(localStorage.getItem(TERMS_KEY)||'{}');return v&&typeof v==='object'&&!Array.isArray(v)?v:{}}catch{return {}}}
function saveTerms(book){try{localStorage.setItem(TERMS_KEY,JSON.stringify(book))}catch{}renderLearnedTerms()}
function renderLearnedTerms(){
 const host=$('#learned-terms');if(!host)return;const terms=Object.keys(learnedTerms());host.hidden=!terms.length;
 host.innerHTML=terms.length?`<div class="field-label">Выучено из ваших исправлений</div><p class="field-hint">MONO добавляет эти слова к подсказке при следующих расшифровках, пока хватает места. Нажмите на слово, чтобы забыть его.</p><div class="term-list">${terms.map(t=>`<button type="button" class="term-chip" data-forget="${h(t)}" aria-label="Забыть «${h(t)}»">${h(t)}<span aria-hidden="true"> ×</span></button>`).join('')}</div>`:'';
}
/** Called when the person leaves an edited fragment: names and terms they typed are learned. */
function learnFromEdit(el){
 const s=state.visibleSegments.get(Number(el.dataset.segment));if(!s||typeof s.original!=='string'||s.original===el.value)return;
 const terms=learnTerms(s.original,el.value);if(!terms.length)return;
 const book=learnedTerms(),fresh=terms.filter(t=>!book[t]);saveTerms(rememberTerms(book,terms));
 if(fresh.length)notifyLater(`MONO запомнил: ${fresh.slice(0,3).join(', ')}${fresh.length>3?'…':''}. Учтём при следующей расшифровке.`);
}

let insight=null,insightPending=null;
let smartSpeed=(()=>{try{return localStorage.getItem(SMART_KEY)==='1'}catch{return false}})(),skipping=0;
/** Paragraph starts, doubtful places, pauses to skip and statistics for the open record. */
async function insightFor(rec,profile){
 const count=rec.transcriptSummary?.segmentCount??rec.transcript?.segments?.length??0;
 if(!count){insight=null;renderInsight(rec);return null}
 const key=`${rec.id}:${count}:${profile?1:0}`;if(insight?.key===key)return insight;
 if(insightPending?.key!==key)insightPending={key,promise:(async()=>{
  const full=rec.transcript?.segments?.length===count?rec:await getRecording(rec.id);const segments=full?.transcript?.segments||[];
  const speakerOf=s=>speakerFor(s,profile);const groups=paragraphs(segments,{speakerOf});
  return {key,id:rec.id,segments,starts:new Set(groups.map(g=>g.indices[0])),doubts:segments.reduce((n,s)=>n+(isDoubtful(s)?1:0),0),skips:silenceSkips(segments,{duration:Number(rec.duration)||Infinity}),stats:transcriptStats(segments,{speakerOf,duration:Number(rec.duration)||0}),last:-1};
 })().catch(()=>null)};
 const pending=insightPending,value=await pending.promise;if(insightPending===pending)insightPending=null;
 if(value&&state.editorId===rec.id){insight=value;renderInsight(rec)}
 return value;
}
function renderInsight(rec){
 const view=insight?.id===rec?.id?insight:null,stats=view?.stats;
 $('#editor-pace-row').hidden=!stats?.wordsPerMinute;if(stats?.wordsPerMinute)setText('#editor-pace',`${stats.wordsPerMinute} слов/мин`);
 const people=Object.entries(stats?.speakers||{}).filter(([,p])=>p.seconds>0);
 $('#editor-share-row').hidden=people.length<2;if(people.length>=2)setText('#editor-share',people.map(([who,p])=>`${SPEAKER_NAMES[who]} ${Math.round(p.share*100)} %`).join(' · '));
 const chip=$('#next-doubt');chip.hidden=!view?.doubts;if(view?.doubts)chip.textContent=`Проверить на слух: ${view.doubts} ${plural(view.doubts,'место','места','мест')} →`;
 const smart=$('#smart-speed'),saved=savedSeconds(view?.skips);smart.hidden=saved<5;
 smart.setAttribute('aria-pressed',String(smartSpeed));smart.textContent=smartSpeed?`Без пауз · −${shortTime(saved)}`:'Без пауз';
}
function plural(n,one,few,many){const a=n%10,b=n%100;return a===1&&b!==11?one:a>=2&&a<=4&&(b<12||b>14)?few:many}
/** Smart Speed: while playing, a long pause between phrases is jumped over (keeps 0.45 s of air). */
function smartSkip(time){
 if(!smartSpeed||!insight?.skips?.length||insight.id!==state.editorId)return;
 const playing=audioReview?audioReview.player.snapshot.playing:!$('#audio-element').paused;if(!playing||performance.now()<skipping)return;
 const to=skipTarget(insight.skips,time);if(to===null)return;skipping=performance.now()+600;
 if(audioReview)void audioReview.player.seek(to).catch(()=>{});else $('#audio-element').currentTime=to;
}
async function gotoDoubt(){
 if(!insight?.doubts)return;const index=nextDoubtful(insight.segments,insight.last);if(index<0)return;insight.last=index;
 if($('#editor-search').value){$('#editor-search').value=''}
 const page=Math.floor(index/65),rec=state.records.find(r=>r.id===state.editorId);
 if(page!==state.editorPage&&rec){state.editorPage=page;await renderEditorSegments(rec)}
 const el=$(`#editor-content [data-segment="${index}"]`);if(!el)return;
 el.closest('.transcript-paragraph')?.scrollIntoView({block:'center',behavior:matchMedia('(prefers-reduced-motion: reduce)').matches?'auto':'smooth'});el.focus({preventScroll:true});
 const start=Number(insight.segments[index]?.start);if(Number.isFinite(start)&&canAudition()){if(audioReview)void audioReview.player.seek(start).catch(()=>{});else $('#audio-element').currentTime=start}
}

const SUMMARY_SECTIONS=[['decisions','Решения'],['actions','Задачи'],['questions','Открытые вопросы']];
const actionText=a=>`${a.text}${a.owner?` — ${a.owner}`:''}${a.due?` (срок: ${a.due})`:''}`;
function summaryLines(s){
 const lines=['Конспект'];if(s.overview)lines.push(s.overview);
 for(const [key,title] of SUMMARY_SECTIONS)if(s[key]?.length){lines.push(title);for(const row of s[key])lines.push('• '+(key==='actions'?actionText(row):row.text))}
 if(s.topics?.length){lines.push('Темы');for(const t of s.topics)lines.push('• '+t.title+(t.points?.length?': '+t.points.join('; '):''))}
 return lines;
}
function summaryMarkdown(s){
 const out=['## Конспект'];if(s.overview)out.push('',s.overview);
 for(const [key,title] of SUMMARY_SECTIONS)if(s[key]?.length)out.push('',`### ${title}`,...s[key].map(row=>(key==='actions'?'- [ ] ':'- ')+(key==='actions'?actionText(row):row.text)+(Number.isFinite(row.at)?` _(${shortTime(row.at)})_`:'')));
 if(s.topics?.length)out.push('','### Темы',...s.topics.map(t=>`- **${t.title}**${t.points?.length?': '+t.points.join('; '):''}`));
 return out.join('\n');
}
const summaryTasks=new Map();
function renderSummary(rec){
 const panel=$('#summary-panel'),button=$('#summary-open'),s=rec.summary,has=Boolean(rec.transcript||rec.transcriptSummary),task=summaryTasks.get(rec.id);
 button.hidden=!has||!storageDetails().local;button.disabled=Boolean(task);
 button.innerHTML=icon('sparkle')+' '+(task?`Конспект · ${task.done||0}/${task.total||1}`:s?'Конспект':'Составить конспект');
 if(!s||!has){panel.hidden=true;panel.replaceChildren();return}
 const header=$('.editor-document-header');if(header.nextElementSibling!==panel)header.after(panel); // the summary reads first, above audio tools
 const at=t=>Number.isFinite(t)?` <button type="button" class="summary-at" data-seek="${t}" title="Прослушать это место">${shortTime(t)}</button>`:'';
 const list=(title,rows,fmt)=>rows?.length?`<h3>${title}</h3><ul>${rows.map(r=>`<li>${fmt(r)}${at(r.at)}</li>`).join('')}</ul>`:'';
 const count=rec.transcriptSummary?.segmentCount??rec.transcript?.segments?.length;const stale=s.sourceSegments&&count&&count!==s.sourceSegments;
 const empty=!s.overview&&!s.decisions?.length&&!s.actions?.length&&!s.questions?.length&&!s.topics?.length;
 panel.innerHTML=`<header class="summary-head"><h2 class="summary-title">Конспект</h2><div class="summary-tools"><button class="btn btn-subtle btn-small" type="button" data-summary="copy">Копировать</button><button class="btn btn-subtle btn-small" type="button" data-summary="redo">Обновить</button><button class="btn btn-subtle btn-small" type="button" data-summary="hide" aria-expanded="true">Свернуть</button></div></header>`+
  (empty?'<p class="summary-overview">В расшифровке не нашлось решений, задач или тем.</p>':'')+
  (s.overview?`<p class="summary-overview">${h(s.overview)}</p>`:'')+
  list('Решения',s.decisions,r=>h(r.text))+
  list('Задачи',s.actions,r=>`${h(r.text)}${r.owner?` <span class="summary-tag">${h(r.owner)}</span>`:''}${r.due?` <span class="summary-tag summary-due">${h(r.due)}</span>`:''}`)+
  list('Открытые вопросы',s.questions,r=>h(r.text))+
  list('Темы',s.topics,r=>`<strong>${h(r.title)}</strong>${r.points?.length?`<span class="summary-points">${r.points.map(h).join(' · ')}</span>`:''}`)+
  `<p class="field-hint">${stale?'<strong>Расшифровка изменилась после конспекта — нажмите «Обновить».</strong> ':''}Составлено языковой моделью${s.model?' '+h(s.model):''} по тексту расшифровки. Проверяйте важное по ссылкам на время.</p>`;
 panel.hidden=state.summaryHidden===rec.id;
}
function requestSummary(rec){
 if(!state.health?.groq){connectGroq(()=>requestSummary(rec));return}
 modal('Составить конспект встречи?','В Groq будет отправлен <strong>только текст расшифровки</strong> — аудио остаётся на компьютере. Модель выделит решения, задачи с ответственными, открытые вопросы и темы со ссылками на время.\n\nСтоимость — по тарифу Groq за токены; на бесплатном тарифе действуют дневные лимиты. Подтвердите, если участники встречи согласны на обработку текста.',
  [{text:'Составить конспект',primary:true,run:()=>runSummary(rec.id)}]);
}
async function runSummary(id){
 const local=await localLibraryClient();if(!local)return;state.summaryHidden=null;
 summaryTasks.set(id,{done:0,total:1});const refreshButton=()=>{const rec=state.records.find(r=>r.id===id);if(rec&&state.editorId===id)renderSummary(rec)};refreshButton();
 try{
  let task=await local.json(`/records/${id}/summary`,{method:'POST',body:{consent:true}});
  // A short network hiccup or a core restart must not leave the window waiting silently.
  for(let misses=0;task.status==='running';){summaryTasks.set(id,task);refreshButton();await new Promise(r=>setTimeout(r,1500));
   try{task=await local.json(`/records/${id}/summary`);misses=0}catch(error){if(++misses>=20)throw error}}
  if(task.status==='idle'){const rec=await getRecording(id,{transcript:false}).catch(()=>null);if(rec?.summary&&rec.summary.createdAt!==state.records.find(r=>r.id===id)?.summary?.createdAt){state.records=state.records.map(r=>r.id===id?{...r,...rec}:r);notify('Конспект готов');return}
   throw new Error('составление прервалось — MONO перезапускался. Нажмите «Составить конспект» ещё раз.')}
  if(task.status==='failed')throw new Error(task.error||'Не удалось составить конспект');
  if(task.status==='done'){const rec=await getRecording(id,{transcript:false});state.records=state.records.map(r=>r.id===id?{...r,...rec}:r);notifyLater('Конспект готов');}
 }catch(error){notify('Конспект: '+(error.message||'не удалось составить'),'error')}
 finally{summaryTasks.delete(id);refreshButton()}
}
async function copySummary(){
 const rec=state.records.find(r=>r.id===state.editorId);if(!rec?.summary)return;
 try{await navigator.clipboard.writeText(summaryMarkdown(rec.summary).replace(/^#+ /gm,''));notify('Конспект скопирован')}catch(e){notify('Не удалось скопировать: '+e.message,'error')}
}
function mountIntelligence(){
 renderLearnedTerms();
 $('#learned-terms').addEventListener('click',e=>{const chip=e.target.closest('[data-forget]');if(!chip)return;const book=learnedTerms();delete book[chip.dataset.forget];saveTerms(book)});
 $('#editor-content').addEventListener('focusout',e=>{if(e.target.matches?.('.segment-edit'))learnFromEdit(e.target)});
 $('#next-doubt').onclick=()=>void gotoDoubt();
 $('#smart-speed').onclick=()=>{smartSpeed=!smartSpeed;try{localStorage.setItem(SMART_KEY,smartSpeed?'1':'0')}catch{}renderInsight(state.records.find(r=>r.id===state.editorId));notify(smartSpeed?'Паузы между фразами будут пропускаться':'Паузы снова слышны')};
 $('#summary-open').onclick=()=>{const rec=state.records.find(r=>r.id===state.editorId);if(!rec)return;if(rec.summary&&state.summaryHidden===rec.id){state.summaryHidden=null;renderSummary(rec);$('#summary-panel').scrollIntoView({block:'nearest'});return}if(rec.summary){$('#summary-panel').scrollIntoView({block:'nearest',behavior:'smooth'});return}requestSummary(rec)};
 $('#summary-panel').addEventListener('click',e=>{const action=e.target.closest('[data-summary]')?.dataset.summary;const rec=state.records.find(r=>r.id===state.editorId);if(!action||!rec)return;
  if(action==='copy')void copySummary();else if(action==='redo')requestSummary(rec);else if(action==='hide'){state.summaryHidden=rec.id;renderSummary(rec)}});
 document.addEventListener('keydown',e=>{if(state.view!=='editor'||e.code!=='KeyN'||e.ctrlKey||e.metaKey||e.altKey||e.repeat||!$('#modal').hidden||e.target?.closest?.('input,textarea,select,[contenteditable]:not([contenteditable="false"])'))return;e.preventDefault();void gotoDoubt()});
}
/** While audio plays, the spoken paragraph is highlighted and kept in view (never while the
 * person is typing in the transcript, and never fighting a manual scroll for 4 s). */
let followed=null,manualScrollAt=0;
function followPlayback(time){
 if(state.view!=='editor'||!Number.isFinite(time))return;
 smartSkip(time);
 const rows=[...document.querySelectorAll('#editor-content .transcript-paragraph')];let current=null;
 for(const row of rows){const start=Number(row.querySelector('.segment-time')?.dataset.seek);if(Number.isFinite(start)&&start<=time+.05)current=row;else if(Number.isFinite(start))break}
 if(current===followed)return;followed?.classList.remove('is-playing');followed=current;current?.classList.add('is-playing');
 if(current&&!document.activeElement?.closest?.('#editor-content')&&performance.now()-manualScrollAt>4000)current.scrollIntoView({block:'center',behavior:matchMedia('(prefers-reduced-motion: reduce)').matches?'auto':'smooth'});
}
document.addEventListener('wheel',()=>{if(state.view==='editor')manualScrollAt=performance.now()},{passive:true});
let pageGeneration=0;
/** Meeting takes (microphone + computer): loudness profile for «Я / Собеседники» labels. */
const speakerProfiles=new Map();
async function speakerProfile(rec){
 const ids=(rec.tracks||[]).map(t=>t?.id||t);if(!storageDetails().local||!ids.includes('mic')||!ids.includes('system'))return null;
 if(!speakerProfiles.has(rec.id))speakerProfiles.set(rec.id,(async()=>{try{const local=await localLibraryClient();return (await local.json('/records/'+encodeURIComponent(rec.id)+'/speakers')).profile}catch{speakerProfiles.delete(rec.id);return null}})());
 return speakerProfiles.get(rec.id);
}
const speakerBadge=(s,profile)=>{const who=speakerFor(s,profile);return who?`<span class="speaker-badge speaker-${who}">${SPEAKER_NAMES[who]}</span>`:''};
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
 const profile=await speakerProfile(rec);const view=await insightFor(rec,profile);if(generation!==pageGeneration||state.editorId!==rec.id)return;
 const pageCount=Math.max(1,Math.ceil(total/pageSize));
 state.editorPage=Math.min(state.editorPage,pageCount-1);
 visible??=filtered.slice(state.editorPage*pageSize,(state.editorPage+1)*pageSize);
 state.visibleSegments=new Map(visible.map(({s,i})=>[i,s]));
 $('#editor-content').innerHTML=visible.length?visible.map(({s,i})=>
 `<div class="transcript-paragraph${view?.starts.has(i)&&i>0?' paragraph-start':''}"><button class="segment-time" data-seek="${Number(s.start)||0}" title="Прослушать с этого места">${shortTime(s.start)}</button>${speakerBadge(s,profile)}<textarea class="segment-edit ${search?'match':''}${isDoubtful(view?.segments[i]??s)?' is-doubtful':''}"${isDoubtful(view?.segments[i]??s)?' title="Модель не уверена в этом месте — проверьте на слух"':''} rows="${Math.min(5,Math.max(1,Math.ceil(s.text.length/85)))}" data-segment="${i}" aria-label="Фрагмент текста ${i+1}">${h(s.text)}</textarea></div>`).join(''):`<div class="empty-state"><strong>${!rec.transcript&&!rec.transcriptSummary?'Запись готова к прослушиванию':'Нет совпадений'}</strong><p>${!rec.transcript&&!rec.transcriptSummary?'Запустите плеер, затем при необходимости создайте расшифровку.':'Попробуйте другой поисковый запрос.'}</p></div>`;
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
async function copyText(event){
 try{await flushEdits();const r=await getRecording(state.editorId);if(!r?.transcript)return;const stamps=event?.shiftKey||event?.altKey;const profile=await speakerProfile(r);await navigator.clipboard.writeText(paragraphs(r.transcript.segments,{speakerOf:s=>speakerFor(s,profile)}).map(p=>`${stamps?`[${shortTime(p.start)}] `:''}${p.speaker?SPEAKER_NAMES[p.speaker]+': ':''}${p.text}`).join('\n\n'));notify('Текст скопирован')}
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
 modal('Экспорт расшифровки',`<label class="field-label" for="export-format">Формат файла</label><select class="select" id="export-format"><option value="txt">TXT — обычный текст</option><option value="md">Markdown</option><option value="docx">DOCX — документ Word</option><option value="json">JSON — данные и метки</option><option value="srt">SRT — субтитры</option><option value="vtt">VTT — субтитры</option><option value="pdf">PDF — через печать браузера</option></select><label class="field-label" for="export-version" style="margin-top:18px">Версия текста</label><select class="select" id="export-version"><option value="edited">Отредактированный</option><option value="clean">Чистый — без «э-э», «м-м» и запинок</option><option value="original">Исходный результат модели</option></select><label class="field-label" for="export-layout" style="margin-top:18px">Разбивка текста</label><select class="select" id="export-layout"><option value="paragraphs">Абзацы — по паузам и говорящим</option><option value="segments">Фрагменты, как у модели</option></select>${rec.summary?'<label class="check-row" style="margin-top:18px"><input type="checkbox" id="export-summary" checked> Добавить конспект в начало</label>':''}`,
 [{text:'Экспортировать',primary:true,run:async()=>{const format=$('#export-format').value,version=$('#export-version').value,layout=$('#export-layout').value,withSummary=Boolean($('#export-summary')?.checked);await doExport(rec,format,version,{layout,withSummary})}}]);
}
async function doExport(rec,format,version,{layout='segments',withSummary=false}={}){
 // Open the print window synchronously in the originating click gesture.
 const printWindow=format==='pdf'?window.open('','_blank'):null;
 if(format==='pdf'&&!printWindow){notify('Разрешите всплывающие окна для печати PDF.','error');return}
 await flushEdits();
 const latest=await getRecording(rec.id);
 if(!latest?.transcript){printWindow?.close();notify('Транскрипт недоступен','error');return}
 const profile=await speakerProfile(latest);
 const base=latest.transcript.segments.map(s=>{const who=speakerFor(s,profile),raw=version==='original'?s.original??s.text:s.text;return {...s,text:version==='clean'?cleanText(raw):raw,...(who?{speaker:who}:{})}}).filter(s=>s.text);
 const label=s=>s.speaker?`${SPEAKER_NAMES[s.speaker]}: ${s.text}`:s.text;
 const segments=base.map(s=>({...s,text:label(s)}));
 // Reading formats get paragraphs; subtitle and data formats keep the model's timing.
 const blocks=layout==='paragraphs'?paragraphs(base,{speakerOf:s=>s.speaker||null}).map(p=>label(p)):segments.map(s=>s.text);
 const summary=withSummary&&latest.summary?summaryLines(latest.summary):[];
 const text=[...(summary.length?[...summary,'']:[]),...blocks].join('\n\n');
 let blob;
 if(format==='txt')blob=new Blob([text],{type:'text/plain;charset=utf-8'});
 else if(format==='md')blob=new Blob([`# ${rec.title}\n\n${summary.length?summaryMarkdown(latest.summary)+'\n\n## Расшифровка\n\n'+blocks.join('\n\n'):text}\n`],{type:'text/markdown;charset=utf-8'});
 else if(format==='json')blob=new Blob([JSON.stringify({title:rec.title,model:latest.transcript.model,duration:rec.duration,...(latest.summary?{summary:latest.summary}:{}),segments},null,2)],{type:'application/json;charset=utf-8'});
 else if(format==='srt'||format==='vtt'){
  const rows=segments.map((s,i)=>`${format==='srt'?i+1+'\n':''}${srtTime(s.start,format==='vtt'?'.':',')} --> ${srtTime(Math.max(s.end,s.start+.1),format==='vtt'?'.':',')}\n${s.text}\n`).join('\n');
  blob=new Blob([format==='vtt'?'WEBVTT\n\n'+rows:rows],{type:'text/plain;charset=utf-8'});
 }else if(format==='docx')blob=docxBlob([rec.title,...summary,...blocks]);
 else if(format==='pdf'){
  const win=printWindow;
  win.document.write(`<html lang="ru"><head><meta charset="utf-8"><title>${h(rec.title)}</title><style>body{max-width:800px;margin:60px auto;padding:0 24px;font:16px/1.8 Arial;color:#111}h1{font-size:30px}p{margin:0 0 18px}@media print{body{margin:0}}</style></head><body><h1>${h(rec.title)}</h1>${summary.map(line=>`<p>${h(line)}</p>`).join('')}${blocks.map(line=>`<p>${h(line)}</p>`).join('')}</body></html>`);
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
   version:state.health?.version||'unknown',records:[]};
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
  state.health=await res.json();applyAccent(state.health.accent);offerUpdate(state.health.update);if(state.health.version)setText('#sidebar-version',state.health.version);
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
 $('#theme-toggle').onclick=()=>{settings.theme=document.body.dataset.theme==='dark'?'light':'dark';saveSettings();applyTheme();$('#setting-theme').value=settings.theme;syncControls();syncSegmented()};
 for(const id of ['hero-import','record-import','library-import'])$('#'+id).onclick=()=>withInput(importFile);
 $('#start-record').onclick=()=>{stopLevelCheck();return beginRecord()};$('#mark-record').onclick=markMoment;
 document.addEventListener('visibilitychange',syncLevelPreview);
 $('#level-check').onclick=()=>{if(state.previewUntil>Date.now()||levelPreview.wanted){stopLevelCheck();return}state.previewRequested=true;state.previewDone=null;syncLevelPreview()};
 document.addEventListener('keydown',e=>{if(e.key!=='?'||e.ctrlKey||e.metaKey||!$('#modal').hidden||e.target?.closest?.('input,textarea,select,[contenteditable]:not([contenteditable="false"])'))return;e.preventDefault();showShortcuts()});
 document.addEventListener('keydown',e=>{if(e.defaultPrevented||e.ctrlKey||e.metaKey||e.altKey||e.repeat||e.code!=='KeyB'||!state.capture)return;if(e.target?.closest?.('input,textarea,select,[contenteditable]:not([contenteditable="false"])'))return;e.preventDefault();markMoment()});$('#pause-record').onclick=pauseRecord;$('#stop-record').onclick=endRecord;
 let searchTimer=0;$('#library-search').addEventListener('input',()=>{clearTimeout(searchTimer);searchTimer=setTimeout(renderLibrary,220)}); // one query per pause in typing
 for(const id of ['library-filter','library-sort'])$('#'+id).addEventListener('change',renderLibrary);
 $('#editor-search').addEventListener('input',()=>{state.editorPage=0;const rec=state.records.find(r=>r.id===state.editorId);if(rec)renderEditorSegments(rec)});
 $('#editor-content').addEventListener('input',e=>{if(e.target.matches('.segment-edit'))editSegment(e.target)});
 $('#copy-transcript').onclick=copyText;$('#export-transcript').onclick=exportRecord;
 mountIntelligence();
 $('#editor-transcribe').onclick=()=>{const rec=state.records.find(r=>r.id===state.editorId);if(rec)void startTranscription(rec)};
 $('#editor-download').onclick=()=>{const rec=state.records.find(r=>r.id===state.editorId);if(rec)void downloadAudio(rec)};
 $('#player-toggle').onclick=async()=>{if(audioReview){if(audioReview.player.snapshot.playing)audioReview.player.pause();else if(canAudition())await audioReview.player.play().catch(error=>{if(error.name!=='AbortError')notify(error.message,'error')});return}const a=$('#audio-element');if(!a.src)return notify('Аудиофайл недоступен','error');if(a.paused)await playAudition(a);else a.pause()};
 const a=$('#audio-element');
 a.addEventListener('play',()=>{if(audioReview)return;if(!canAudition()){a.pause();return}$('#player-toggle').innerHTML=icon('pause');$('#player-toggle').setAttribute('aria-label','Приостановить воспроизведение')});
 a.addEventListener('pause',()=>{if(audioReview)return;$('#player-toggle').innerHTML=icon('play');$('#player-toggle').setAttribute('aria-label','Воспроизвести запись')});
 a.addEventListener('timeupdate',()=>{followPlayback(a.currentTime);if(audioReview)return;$('#player-now').textContent=shortTime(a.currentTime);$('#player-seek').value=String(a.duration&&Number.isFinite(a.duration)?Math.floor(1000*a.currentTime/a.duration):0)});
 a.addEventListener('loadedmetadata',()=>{if(!audioReview)$('#player-total').textContent=shortTime(a.duration)});
 $('#player-seek').oninput=e=>{if(audioReview){void audioReview.player.seek(audioReview.player.snapshot.duration*Number(e.target.value)/1000).catch(error=>{if(error.name!=='AbortError')notify(error.message,'error')})}else if(Number.isFinite(a.duration))a.currentTime=a.duration*Number(e.target.value)/1000};
 $('#player-speed').onchange=e=>{if(audioReview)audioReview.player.setRate(Number(e.target.value));else a.playbackRate=Number(e.target.value)};
 $('#setting-theme').value=settings.theme;$('#setting-theme').onchange=e=>{settings.theme=e.target.value;saveSettings();applyTheme();syncSegmented()};mountSegmented();
 {const prompt=$('#setting-prompt'),count=$('#setting-prompt-count'),update=()=>{count.textContent=`${prompt.value.length} / ${prompt.maxLength}`};prompt.addEventListener('input',update);update()}
 $('#setting-profile').value=settings.profile;$('#setting-profile').onchange=e=>{settings.profile=e.target.value;saveSettings()};
 $('#setting-prompt').value=settings.prompt;$('#setting-prompt').dispatchEvent(new Event('input'));$('#setting-prompt').oninput=e=>{settings.prompt=e.target.value;saveSettings()};
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
 document.addEventListener('keydown',e=>{
  if((e.ctrlKey||e.metaKey)&&e.code==='KeyS'){e.preventDefault();if(state.view==='editor')void flushEdits().then(()=>notify('Исправления сохранены.')).catch(error=>notify(error.message,'error'));return}
  if(e.key==='Escape'&&$('#modal').hidden&&!document.querySelector('.select-popup,.setup-backdrop')&&!e.target?.matches?.('input,textarea')){document.querySelectorAll('#toast-area .toast').forEach(t=>t.remove())}
  if((e.ctrlKey||e.metaKey)&&e.code==='KeyF'&&['editor','library'].includes(state.view)&&$('#modal').hidden){e.preventDefault();const field=$(state.view==='editor'?'#editor-search':'#library-search');field.focus();field.select()}
  if(e.key==='Escape'&&e.target?.matches?.('#library-search,#editor-search')&&e.target.value){e.preventDefault();e.target.value='';e.target.dispatchEvent(new Event('input',{bubbles:true}))}
 });
 let hiddenAt=0;document.addEventListener('visibilitychange',()=>{if(document.hidden){hiddenAt=Date.now();return}if(hiddenAt&&Date.now()-hiddenAt>60000)void refresh().catch(()=>{})});
 window.addEventListener('hashchange',renderRoute);
 window.addEventListener('beforeunload',e=>{if(state.capture||state.pendingEdits.size||state.failedEdits.size||state.records.some(r=>r.status==='uploading')){e.preventDefault();e.returnValue=''}});
 window.addEventListener('online',()=>{void checkHealth();void pollJobs();
  // Transcriptions that failed because the network dropped resume by themselves.
  for(const rec of state.records.filter(r=>r.status==='failed'&&/сет|network|fetch|timeout|тайм-аут|503|502|504|429/i.test(r.job?.error||'')).slice(0,3))void retryJob(rec)});
 window.addEventListener('offline',()=>{void checkHealth();notify('Нет интернета. Запись работает как обычно; расшифровка продолжится сама, когда сеть вернётся.')});
 let dragDepth=0;
 document.addEventListener('dragenter',e=>{if(e.dataTransfer?.types.includes('Files')){dragDepth++;document.body.classList.add('drag-over')}});
 document.addEventListener('dragleave',()=>{dragDepth=Math.max(0,dragDepth-1);if(!dragDepth)document.body.classList.remove('drag-over')});
 document.addEventListener('dragover',e=>{if(e.dataTransfer?.types.includes('Files'))e.preventDefault()});
 document.addEventListener('drop',e=>{e.preventDefault();dragDepth=0;document.body.classList.remove('drag-over');if(e.dataTransfer?.files?.length)void importFile(e.dataTransfer.files[0])});
 matchMedia('(prefers-color-scheme: dark)').addEventListener('change',()=>{if(settings.theme==='system')applyTheme()});
}
async function init(){
 guardSingleWindow({onFocus:()=>{try{window.focus()}catch{}document.body.classList.add('window-called');setTimeout(()=>document.body.classList.remove('window-called'),900)},onDuplicate:showDuplicateWindow});
 applyTheme();wire();enhanceUI();await openDB();
 const local=await localLibraryClient();if(local)credentialForm=mountCredentials($('#groq-credentials'),{client:new CredentialsClient(local),onChange:value=>{$('#resume-transcription').hidden=!value.configured||!pendingTranscriptionId;void checkHealth()}});else $('#groq-settings-card').hidden=true;
 $('#resume-transcription').onclick=async()=>{const id=pendingTranscriptionId;if(!id)return;await checkHealth();const rec=state.records.find(r=>r.id===id);if(rec){pendingTranscriptionId=null;$('#resume-transcription').hidden=true;go('editor',id);void startTranscription(rec)}};
 const storage=storageDetails(),available=!storage.local||storage.libraryAvailable;
 const orphaned=available?await listRecordings():[];
 for(const r of orphaned.filter(r=>!storage.local&&r.status==='recording')){
  await patchRecording(r.id,{status:'interrupted',duration:r.duration||Math.max(0,((r.lastChunkAt||Date.parse(r.createdAt))-Date.parse(r.createdAt))/1000)});
 }
 if(available)await refresh();
 // A fresh launch has no hash: reopen the record the person was working on, as they left it.
 const resume=!location.hash?session.resumable(state.records):null;if(resume)history.replaceState(null,'','#'+resume.hash);
 renderRoute({preserveDrawer:true});if(resume)void session.restore(resume);session.watch();await checkHealth();
 updateStorageSettings();
 if(local&&available)await initializeNative(local).catch(error=>notify(error.message,'error'));
 if(local)startAudioCare();
 if(local)await showSetup();
 if(local&&!setupWindow&&storageDetails().libraryAvailable)void offerLegacyImport();
 announceRecovered();
 if(storage.transfer?.state==='running')void runLibraryTransfer(null,storage.transfer);
 else if(state.view!=='settings'&&(storage.transfer||storage.transferRecoveryError)){
  const notice=document.createElement('div');notice.className='toast archive-progress archive-recovery-notice';notice.setAttribute('role','status');
  const text=document.createElement('span');text.textContent=storage.transferRecoveryError?'Не удалось прочитать журнал копирования. Исходный архив сохранён.':'Копирование не завершено. Его можно продолжить в настройках.';
  const button=document.createElement('button');button.className='btn btn-outline btn-small';button.textContent='Открыть настройки';button.onclick=()=>{go('settings');$('#transfer-recovery')?.scrollIntoView({block:'center'});notice.remove()};notice.append(text,button);$('#toast-area').append(notice);
 }
 listenForLauncherEvents();watchConnection();
 try{const version=state.health?.version,seen=localStorage.getItem('mono-version');if(version&&seen&&seen!==version)notify(`MONO обновлён до версии ${version}. Записи и настройки на месте.`);if(version)localStorage.setItem('mono-version',version)}catch{}
 // Poll fast only while something is being transcribed or the queue is on screen.
 void pollJobs();let lastPoll=0;setInterval(()=>{if(document.hidden)return;const busy=state.view==='jobs'||state.records.some(r=>['uploading','queued','processing'].includes(r.status));if(busy||performance.now()-lastPoll>15000){lastPoll=performance.now();void pollJobs()}},3500);document.addEventListener('visibilitychange',()=>{if(!document.hidden)void pollJobs()});
 if('serviceWorker' in navigator){navigator.serviceWorker.register('/sw.js').catch(()=>{})}
}
function markRecoveredSeen(id){try{const seen=JSON.parse(localStorage.getItem('mono-recovered-seen')||'[]');if(!seen.includes(id)){seen.push(id);localStorage.setItem('mono-recovered-seen',JSON.stringify(seen.slice(-200)))}}catch{}}
/** After a crash or power loss: say which take was recovered and how much of it is safe. */
function announceRecovered(){
 let seen;try{seen=new Set(JSON.parse(localStorage.getItem('mono-recovered-seen')||'[]'))}catch{seen=new Set()}
 const week=Date.now()-7*86400000;
 const recovered=state.records.filter(r=>r.status==='interrupted'&&(r.size>0||r.duration>0)&&Date.parse(r.createdAt)>week&&!seen.has(r.id));
 if(!recovered.length)return;
 for(const r of recovered)seen.add(r.id);try{localStorage.setItem('mono-recovered-seen',JSON.stringify([...seen].slice(-200)))}catch{}
 const first=recovered[0];
 notify(recovered.length===1?`Запись восстановлена: «${first.title}», сохранено ${durationText(first.duration)}.`:`Восстановлено записей после сбоя: ${recovered.length}.`,'info',{text:recovered.length===1?'Открыть':'В библиотеку',run:()=>recovered.length===1?go('editor',first.id):go('library')});
}
/** The archive must always exist. First run asks (Documents is the proposed default); if the
 * person closes the assistant or presses Record without choosing, MONO uses Documents itself
 * and says where — never a dead end. An archive that exists but is unreachable is not
 * replaced silently: that could split someone's recordings across two folders. */
async function ensureArchive(reason){
 const storage=storageDetails();if(!storage.local||storage.libraryConfigured)return true;
 try{await configureLibrary({useDefault:true});updateStorageSettings();await refresh();
  const full=storageDetails().libraryPath||'',parts=full.split(/[\\/]/).filter(Boolean),where=parts.length?'«'+parts.slice(-2).join(' › ')+'»':'«Документы»';
  notify(`Записи сохраняются в ${where}.`+(reason==='setup'?' Папку можно изменить в настройках.':''),'info',{text:'Изменить',run:()=>{go('settings');showLibrarySetup()}});
  await initializeNative(await localLibraryClient()).catch(()=>{});void backgroundAudioCare('device');
  return true}
 catch(error){notify('Не удалось создать папку для записей в «Документах»: '+error.message,'error',fixFor('LIBRARY_NOT_CONFIGURED'));return false}
}
/** One-button import of the pre-desktop browser library, offered once after setup. */
async function offerLegacyImport(){
 try{if(localStorage.getItem('mono-legacy-offered')==='1'||!await hasLegacyRecords())return;localStorage.setItem('mono-legacy-offered','1')}catch{return}
 notify('Найдены записи из прежней версии MONO в этом браузере.','info',{text:'Перенести в архив',run:runLegacyMigration});
}
function updateStorageSettings(){
 const storage=storageDetails();if(!storage.local)return;
 if(!$('#library-filter option[value="trash"]')){const option=document.createElement('option');option.value='trash';option.textContent='Корзина';$('#library-filter').append(option);syncControls()}
 const persist=$('[data-row="persist"]');persist.querySelector('.set-row-title').textContent=storage.libraryConfigured?'Другая папка архива':'Папка для записей';persist.querySelector('.set-row-hint').textContent=storage.libraryConfigured?'Подключить существующую папку с записями MONO.':'Выберите, где хранить аудио и расшифровки.';
 $('#request-persistence').textContent=storage.libraryConfigured?'Подключить…':'Выбрать…';
 $('[data-row="move"] .set-row-title').textContent='Перенести архив';
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
