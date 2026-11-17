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
 /** Before recording: null when it may proceed, otherwise the blocking warning. */
 async gate(){
  try{const result=await this.run();return result.checks.find(item=>item.level==='warning')||null}
  catch{return null}// Diagnostics failing must never be the reason a recording cannot start.
 }
}

const SUMMARY={ok:'Все системы в норме',advisory:'Готово к записи · есть сведения',caution:'Запись возможна · есть ограничения',warning:'Запись недоступна · нужно действие'};
export function mountPreflight(host,{model,onError=()=>{},compact=false}){
 host.classList.add('preflight');
 host.innerHTML=`<div class="preflight-head"><span class="preflight-light" aria-hidden="true"></span><strong class="preflight-summary" role="status" aria-live="polite">Проверяем системы…</strong></div><ul class="preflight-list"></ul><button type="button" class="btn btn-outline btn-small preflight-run">Проверить снова</button>`;
 const list=host.querySelector('.preflight-list'),summary=host.querySelector('.preflight-summary'),button=host.querySelector('.preflight-run');
 const render=result=>{
  host.dataset.level=result.level;summary.textContent=SUMMARY[result.level];
  const visible=compact?result.checks.filter(item=>item.level!=='ok'):result.checks;
  list.replaceChildren(...visible.map(item=>{const row=document.createElement('li');row.className='preflight-item';row.dataset.level=item.level;const title=document.createElement('strong');title.textContent=item.title;const detail=document.createElement('span');detail.textContent=[item.detail,item.action].filter(Boolean).join(' ');row.append(title,detail);return row}));
  list.hidden=!visible.length;
 };
 const unsubscribe=model.subscribe(render);
 button.onclick=async()=>{button.disabled=true;try{await model.run({force:true})}catch(error){onError(error)}finally{button.disabled=false}};
 void model.run().catch(onError);
 return {destroy(){unsubscribe();host.replaceChildren()}};
}
