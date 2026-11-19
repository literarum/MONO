/** Pre-flight check: server systems + this window's audio capabilities.
 * Levels mirror crew alerting: warning blocks recording, caution degrades it,
 * advisory informs. A failing check never blocks by itself (fail-operational). */
const LEVELS=['ok','advisory','caution','warning'];
const worst=items=>items.reduce((level,item)=>LEVELS.indexOf(item.level)>LEVELS.indexOf(level)?item.level:level,'ok');
const check=(id,level,title,detail,action=null)=>({id,level,title,detail,...(action?{action}:{})});

export async function windowChecks({nav=globalThis.navigator,scope=globalThis}={}){
 const checks=[];
 const capture=Boolean(nav?.mediaDevices?.getUserMedia&&scope.AudioContext&&scope.AudioWorkletNode);
 checks.push(capture?check('window-audio','ok','Звук в этом окне','Запись микрофона через окно поддерживается.')
  :check('window-audio','caution','Окно не умеет записывать звук','Откройте MONO через ярлык на рабочем столе (Chrome или Edge).'));
 try{
  const state=(await nav?.permissions?.query({name:'microphone'}))?.state;
  if(state==='denied')checks.push(check('mic-permission','caution','Доступ к микрофону запрещён','Окно MONO не получит звук микрофона.','Меню окна (⋮) → «Сведения о сайте» → Микрофон: «Разрешить», затем обновите окно.'));
  else if(state==='prompt')checks.push(check('mic-permission','advisory','Доступ к микрофону ещё не выдан','При первой записи появится запрос — нажмите «Разрешить».'));
  else if(state==='granted')checks.push(check('mic-permission','ok','Доступ к микрофону','Разрешён.'));
 }catch{/* Permissions API is optional. */}
 try{
  const inputs=(await nav?.mediaDevices?.enumerateDevices?.()||[]).filter(device=>device.kind==='audioinput');
  if(capture&&!inputs.length)checks.push(check('mic-device','caution','Микрофон не найден','Система не видит ни одного входа звука.','Подключите микрофон и нажмите «Проверить снова».'));
 }catch{}
 if(!nav?.locks?.request)checks.push(check('window-locks','advisory','Согласование окон недоступно','Не открывайте MONO в нескольких окнах одновременно.'));
 return checks;
}

export class Preflight{
 constructor(library,{maxAgeMs=15000,timeoutMs=12000}={}){this.library=library;this.maxAgeMs=maxAgeMs;this.timeoutMs=timeoutMs;this.result=null;this.at=0;this.running=null;this.listeners=new Set()}
 subscribe(fn){this.listeners.add(fn);if(this.result)fn(this.result);return()=>this.listeners.delete(fn)}
 run({force=false}={}){
  if(!force&&this.result&&performance.now()-this.at<this.maxAgeMs)return Promise.resolve(this.result);
  if(this.running)return this.running;
  this.running=(async()=>{
   const [server,local]=await Promise.all([this.library.json('/preflight',{signal:AbortSignal.timeout(this.timeoutMs)}),windowChecks()]);
   const checks=[...server.checks,...local],level=worst(checks);
   this.result={checkedAt:server.checkedAt,level,canRecord:!checks.some(item=>item.level==='warning'),checks};this.at=performance.now();
   for(const fn of this.listeners)fn(this.result);return this.result;
  })().finally(()=>{this.running=null});
  return this.running;
 }
 /** Apply a repair offered by a check (unmute / raise input level), then re-check. */
 async fix(repair){await this.library.json('/capture/repair',{method:'POST',body:repair});return this.run({force:true})}
 /** Before recording: null when it may proceed, otherwise the blocking warning. */
 async gate(){
  try{const result=await this.run();return result.checks.find(item=>item.level==='warning')||null}
  catch{return null}// Diagnostics failing must never be the reason a recording cannot start.
 }
}

/** Black box: the last client-side errors, for «Скопировать диагностику». Messages only:
 * never record titles, transcripts, file paths or keys. */
const blackBox=[];
export const recentErrors=()=>blackBox.slice(-20);
export function remember(kind,message){blackBox.push({at:new Date().toISOString(),kind,message:String(message||'').replace(/[A-Za-z]:\\[^\s]+|\/(?:home|Users)\/[^\s]+/g,'(путь)').slice(0,240)});if(blackBox.length>30)blackBox.shift()}
if(typeof addEventListener==='function'){addEventListener('error',event=>remember('error',event.message));addEventListener('unhandledrejection',event=>remember('rejection',event.reason?.code||event.reason?.message||event.reason))}
const SUMMARY={ok:'Всё готово к записи',advisory:'Готово к записи · есть подсказки',caution:'Записывать можно · есть ограничения',warning:'Запись недоступна · нужно действие'};
export function mountPreflight(host,{model,onError=()=>{},compact=false,onDeep=null}){
 host.classList.add('preflight');
 host.innerHTML=`<div class="preflight-head"><span class="preflight-light" aria-hidden="true"></span><strong class="preflight-summary" role="status" aria-live="polite">Проверяем системы…</strong></div><ul class="preflight-list"></ul><div class="inline-actions"><button type="button" class="btn btn-outline btn-small preflight-run">Проверить снова</button>${compact?'':'<button type="button" class="btn btn-outline btn-small preflight-copy">Скопировать диагностику</button>'}${!compact&&onDeep?'<button type="button" class="btn btn-primary btn-small preflight-deep">Глубокая диагностика</button>':''}</div>`;
 const list=host.querySelector('.preflight-list'),summary=host.querySelector('.preflight-summary'),button=host.querySelector('.preflight-run');
 const render=result=>{
  host.dataset.level=result.level;summary.textContent=SUMMARY[result.level];
  const visible=compact?result.checks.filter(item=>item.level!=='ok'):result.checks;
  list.replaceChildren(...visible.map(item=>{const row=document.createElement('li');row.className='preflight-item';row.dataset.level=item.level;const title=document.createElement('strong');title.textContent=item.title;const detail=document.createElement('span');detail.textContent=[item.detail,item.action].filter(Boolean).join(' ');row.append(title,detail);
   if(item.fix&&model.fix){const fix=document.createElement('button');fix.type='button';fix.className='btn btn-primary btn-small preflight-fix';fix.textContent='Исправить';fix.onclick=async()=>{fix.disabled=true;try{await model.fix(item.fix)}catch(error){onError(error)}finally{fix.disabled=false}};row.append(fix)}
   return row}));
  list.hidden=!visible.length;
 };
 const unsubscribe=model.subscribe(render);
 button.onclick=async()=>{button.disabled=true;try{await model.run({force:true})}catch(error){onError(error)}finally{button.disabled=false}};
 // Shareable state of every system — never recordings, transcripts or keys.
 const copy=host.querySelector('.preflight-copy');
 if(copy)copy.onclick=async()=>{try{const result=await model.run({force:true});const report={app:'MONO Transcribe',checkedAt:result.checkedAt,level:result.level,checks:result.checks.map(({id,level,title,detail})=>({id,level,title,detail:id==='library'?'(путь скрыт)':detail})),recentErrors:blackBox.slice(-20),capture:await model.library?.json?.('/capture/capabilities').then(c=>({ready:c.ready,supported:c.supported,modes:c.modes,state:c.state,reason:c.reason,inputs:(c.inputDevices||[]).length,outputs:(c.outputDevices||[]).length})).catch(()=>null)??null,userAgent:navigator.userAgent,platform:navigator.userAgentData?.platform||navigator.platform};await navigator.clipboard.writeText(JSON.stringify(report,null,2));copy.textContent='Скопировано';setTimeout(()=>{copy.textContent='Скопировать диагностику'},2500)}catch(error){onError(error)}};
 const deep=host.querySelector('.preflight-deep');if(deep)deep.onclick=onDeep;
 void model.run().catch(onError);
 return {destroy(){unsubscribe();host.replaceChildren()}};
}
