// Deep diagnostics: actively tests every system MONO depends on and explains what it found.
// Privacy: never titles, transcripts, keys or file paths. Device names stay (needed to tell
// "which microphone"); everything else is codes, numbers and states.
import os from 'node:os';import {execFile} from 'node:child_process';import path from 'node:path';import {readFileSync,writeFileSync,renameSync,mkdirSync} from 'node:fs';import {statfs} from 'node:fs/promises';
import {writeProbe,oneDriveRoot,BYTES_PER_HOUR} from './preflight.mjs';import {microphonePrivacy,microphoneUsers} from './privacy.mjs';

/** Paths, keys and e-mail-like strings removed from any text that may end up in a report. */
export function scrub(value){
 return String(value??'').replace(/gsk_[A-Za-z0-9]+/g,'gsk_••••').replace(/Bearer\s+\S+/gi,'Bearer ••••')
  .replace(/[A-Za-z]:\\[^\s"',;)]+/g,'(путь)').replace(/(?:\/(?:home|Users|root|tmp|var|private)\/)[^\s"',;)]+/g,'(путь)')
  .replace(/[\w.+-]+@[\w-]+\.[\w.]+/g,'(почта)').slice(0,300);
}

/** Black box of the core: warnings and errors, plus each start, kept across restarts. */
export class Journal{
 constructor({file=null,limit=80,now=()=>new Date().toISOString()}={}){
  Object.assign(this,{file,limit,now,rows:[],timer:null});
  if(file){try{const saved=JSON.parse(readFileSync(file,'utf8'));if(Array.isArray(saved))this.rows=saved.filter(r=>r&&typeof r.at==='string').slice(-limit)}catch{}}
 }
 note(level,message){
  let text=typeof message==='string'?message:JSON.stringify(message);
  try{const v=JSON.parse(text);if(v?.event==='startup_phase')return;if(v&&typeof v==='object')text=[v.event,v.code,v.phase,v.message,v.operation,v.stage,v.errorName].filter(Boolean).join(' · ')}catch{}
  this.rows.push({at:this.now(),level,message:scrub(text)});if(this.rows.length>this.limit)this.rows.splice(0,this.rows.length-this.limit);this.persist();
 }
 /** Written at once, like a flight recorder: a deferred write was lost when the core exited
  * (or crashed) within 500 ms — exactly the moments the journal exists for. ≤80 short rows. */
 persist(){
  if(!this.file)return;const tmp=this.file+'.tmp';
  try{mkdirSync(path.dirname(this.file),{recursive:true});writeFileSync(tmp,JSON.stringify(this.rows));renameSync(tmp,this.file)}catch{}
 }
 /** Mirror console.warn/error into the journal (all existing server events land here). */
 capture(target=console){for(const level of ['warn','error']){const original=target[level].bind(target);target[level]=(...args)=>{try{this.note(level,args.map(a=>a instanceof Error?a.message:typeof a==='string'?a:JSON.stringify(a)).join(' '))}catch{}original(...args)}}}
 starts(sinceMs,nowMs=Date.now()){return this.rows.filter(r=>r.level==='start'&&nowMs-Date.parse(r.at)<sinceMs).length}
}

async function timed(promise,ms){let timer;try{return await Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Object.assign(new Error('TIMEOUT'),{code:'TIMEOUT'})),ms)})])}finally{clearTimeout(timer)}}
const settle=async(fn,ms)=>{const started=performance.now();try{return {ok:true,value:await timed(fn(),ms),ms:Math.round(performance.now()-started)}}catch(error){return {ok:false,code:error.code||error.name||'ERROR',message:scrub(error.message),ms:Math.round(performance.now()-started)}}};
/** Network failures carry the real reason in `cause` (ENOTFOUND, ECONNRESET, certificate…). */
export function networkCode(error){
 const cause=error?.cause,inner=cause?.errors?.[0]||cause?.cause;
 return cause?.code||inner?.code||(error?.name==='TimeoutError'||cause?.name==='TimeoutError'?'TIMEOUT':null)||error?.code||(cause?.message?scrub(cause.message).slice(0,60):null)||error?.name||'ERROR';
}

export async function probeGroq({keyManager,base='https://api.groq.com/openai/v1',fetch=globalThis.fetch,timeoutMs=10000}){
 let status;try{status=await keyManager.status()}catch{return {configured:false,vault:'unavailable'}}
 if(!status.configured)return {configured:false};
 const started=performance.now();
 try{
  const response=await fetch(base+'/models',{headers:{Authorization:`Bearer ${await keyManager.getKey()}`},signal:AbortSignal.timeout(timeoutMs)});
  const ms=Math.round(performance.now()-started),result={configured:true,managed:Boolean(status.managed),http:response.status,ms};
  const limit=name=>response.headers.get(name);
  for(const [key,header] of [['remainingRequests','x-ratelimit-remaining-requests'],['remainingTokens','x-ratelimit-remaining-tokens']])if(limit(header)!==null)result[key]=Number(limit(header));
  if(response.ok){const ids=((await response.json())?.data||[]).map(m=>m?.id).filter(Boolean);result.models=ids.length;result.whisper=ids.includes('whisper-large-v3-turbo');result.chat=ids.filter(id=>/gpt-oss|llama|qwen/i.test(id)&&!/guard/i.test(id)).slice(0,6)}
  else await response.body?.cancel();
  return result;
 }catch(error){return {configured:true,managed:Boolean(status.managed),error:networkCode(error),ms:Math.round(performance.now()-started)}}
}

/** Health events from the window (device lost, start failure, fallback…), kept in the journal for trend analysis. */
export const EVENT_CODES=new Set(['DEVICE_LOST','START_FAILED','BROWSER_FALLBACK','SILENCE','CAPTURE_ERROR','SAFETY_USED','SAFETY_FAILED','STALE_SAVE','SCRUB_DAMAGED']);
export function trends(rows,{days=7,now=Date.now()}={}){
 const counts={},devices={};
 for(const r of rows||[]){if(r.level!=='event'||now-Date.parse(r.at)>days*86400e3)continue;const [code,device]=String(r.message).split(' · ');counts[code]=(counts[code]||0)+1;if(device){devices[code]??={};devices[code][device]=(devices[code][device]||0)+1}}
 return {days,counts,devices};
}
const run=(file,args,ms)=>new Promise(resolve=>{try{execFile(file,args,{timeout:ms,windowsHide:true,maxBuffer:1024*1024},(error,stdout)=>resolve(error?null:String(stdout)))}catch{resolve(null)}});
/** powercfg output is localized; the two hex indexes (AC, then DC) are what matters. */
export function parsePowercfg(text){const values=[...String(text||'').matchAll(/:\s*0x([0-9a-f]{8})\s*$/gim)].map(m=>parseInt(m[1],16));return values.length>=2?{ac:values.at(-2)===1,dc:values.at(-1)===1}:null}
export async function usbSelectiveSuspend({platform=process.platform,exec=run}={}){
 if(platform!=='win32')return null;
 // Subgroup «USB settings» / «USB selective suspend setting».
 return parsePowercfg(await exec('powercfg',['/query','SCHEME_CURRENT','2a737441-1930-4402-8d77-b2bebba308a3','48e6b7a6-50f5-4782-a5d4-53bb8f07e226'],5000));
}
export async function diskHealth({platform=process.platform,exec=run}={}){
 if(platform!=='win32')return null;
 const out=await exec('powershell.exe',['-NoProfile','-NonInteractive','-Command','Get-PhysicalDisk | Select-Object FriendlyName,MediaType,HealthStatus,OperationalStatus | ConvertTo-Json -Compress'],20000); // a cold PowerShell start took ~10 s in CI
 try{const value=JSON.parse(out);return (Array.isArray(value)?value:[value]).map(d=>({name:scrub(d.FriendlyName),media:String(d.MediaType??''),health:String(d.HealthStatus??''),status:[].concat(d.OperationalStatus??[]).map(String).join(', ')}))}catch{return null}
}
export async function collect({worker,runtime,keyManager,journal,health=()=>({}),jobs=()=>[],toolVersion=async()=>null,groqBase,fetch,env=process.env,privacy=microphonePrivacy,users=microphoneUsers,usb=usbSelectiveSuspend,disks=diskHealth}){
 // Slow OS probes (PowerShell can take ~10 s cold) start first and run alongside the rest.
 const slow={usb:usb().catch(()=>null),disks:disks().catch(()=>null)};
 const report={generatedAt:new Date().toISOString(),app:{},system:{},core:{},archive:{},capture:{},groq:{},jobs:{},journal:[]};
 const h=health();
 report.app={version:h.version,mode:h.mode,uptimeSeconds:h.uptimeSeconds,launcher:Boolean(env.MONO_LAUNCHER),node:process.version,startsLastHour:journal?.starts(3600e3)??null,startsLastDay:journal?.starts(86400e3)??null};
 report.system={os:`${os.type()} ${os.release()}`,arch:os.arch(),cpu:os.cpus()[0]?.model?.trim()||null,cores:os.cpus().length,memoryGB:+(os.totalmem()/1024**3).toFixed(1),freeMemoryGB:+(os.freemem()/1024**3).toFixed(1),processMB:Math.round(process.memoryUsage().rss/1024**2),systemUptimeHours:+(os.uptime()/3600).toFixed(1)};
 const tools=await settle(runtime,15000);
 report.tools={ffmpeg:tools.ok?Boolean(tools.value.ffmpeg):false,ffprobe:tools.ok?Boolean(tools.value.ffprobe):false,ffmpegVersion:await toolVersion().catch(()=>null)};
 const status=await settle(()=>worker.call('status'),5000);
 report.core={responds:status.ok,ms:status.ms,...(status.ok?{}:{code:status.code})};
 if(status.ok){
  const s=status.value,root=s.libraryPath;
  report.archive={configured:Boolean(s.libraryConfigured),available:Boolean(s.libraryAvailable),busy:Boolean(s.libraryBusy),transferPending:Boolean(s.transfer)};
  if(root&&s.libraryAvailable){
   const documents=path.join(os.homedir(),'Documents');
   report.archive.location=oneDriveRoot(root)?'OneDrive':path.resolve(root).toLowerCase().startsWith(documents.toLowerCase())?'Документы':/^\\\\/.test(root)?'сетевая папка':'другая папка';
   const started=performance.now();report.archive.writeProbe=await writeProbe(root);report.archive.writeMs=Math.round(performance.now()-started);
   try{const space=await statfs(root),free=Number(space.bavail)*Number(space.bsize);report.archive.freeGB=+(free/1024**3).toFixed(1);report.archive.hoursLeft=+(free/BYTES_PER_HOUR).toFixed(1)}catch{}
   const list=await settle(()=>worker.call('records.list',{limit:200,query:'',trash:false}),8000);
   if(list.ok){const counts={};for(const r of list.value.items||[])counts[r.status]=(counts[r.status]||0)+1;report.archive.records=counts;report.archive.listMs=list.ms;report.archive.more=Boolean(list.value.nextCursor)}
  }
 }
 const caps=await settle(()=>worker.call('capture.capabilities'),9000);
 const prefs=await settle(()=>worker.call('preferences.get'),4000);report.capture.source=prefs.ok?prefs.value?.capture?.mode||null:null;
 report.capture.module=caps.ok?{ready:Boolean(caps.value.ready),supported:caps.value.supported,reason:caps.value.reason||null,modes:caps.value.modes||[],state:caps.value.state||null,inputs:(caps.value.inputDevices||[]).length,outputs:(caps.value.outputDevices||[]).length}:{error:caps.code};
 const diag=await settle(()=>worker.call('capture.diagnose'),8000);
 report.capture.inputs=diag.ok&&Array.isArray(diag.value?.inputs)?diag.value.inputs.map(d=>({name:scrub(d.name),state:d.state,default:Boolean(d.default),muted:d.muted??null,volume:typeof d.volume==='number'?Math.round(d.volume*100):null})):null;
 if(!diag.ok)report.capture.diagnoseError=diag.code;
 // Built-in test of the real capture path (open → 0.5 s → close), never during a take.
 // A starting module answers at once with STARTING (it never blocks the core): ask again for up to ~10 s.
 let probe=null;for(let i=0;i<8;i++){probe=await settle(()=>worker.call('capture.probe',{},{timeoutMs:15000}),16000);if(!(probe.ok&&probe.value?.reason==='STARTING'))break;await new Promise(r=>setTimeout(r,1250))}
 report.capture.probe=probe.ok?probe.value:{available:false,reason:probe.code};
 const mic=await settle(privacy,4000);report.capture.privacy=mic.ok?{blocked:Boolean(mic.value?.blocked),scope:mic.value?.scope||null}:null;
 const holders=await settle(users,5000);report.capture.heldBy=holders.ok?(holders.value||[]).slice(0,5).map(scrub):null;
 report.groq=await probeGroq({keyManager,base:groqBase,fetch});
 report.power={usbSelectiveSuspend:await slow.usb};report.disks=await slow.disks;
 report.trends=trends(journal?.rows);
 const list=jobs();const by={};for(const j of list)by[j.status]=(by[j.status]||0)+1;
 report.jobs={counts:by,recentErrors:list.filter(j=>j.error).sort((a,b)=>String(b.updatedAt).localeCompare(String(a.updatedAt))).slice(0,5).map(j=>({status:j.status,stage:scrub(j.stage),error:scrub(j.error),attempts:j.attempts||0}))};
 report.journal=(journal?.rows||[]).slice(-40);
 report.findings=findings(report);
 return report;
}

const F=(level,title,detail,action=null)=>({level,title,detail,...(action?{action}:{})});
/** Plain-language conclusions from the raw report: what is wrong and what to do. */
export function findings(r){
 const out=[];
 if(r.core&&!r.core.responds)out.push(F('warning','Ядро архива не отвечает',`Код: ${r.core.code}.`,'Перезапустите MONO. Если повторяется — пришлите этот отчёт.'));
 else if(r.core?.ms>1500)out.push(F('caution','Ядро отвечает медленно',`${r.core.ms} мс.`,'Обычно это антивирус или перегруженный диск.'));
 if(r.app?.startsLastHour>=3)out.push(F('caution','Ядро перезапускалось',`${r.app.startsLastHour} раз за последний час — MONO восстанавливал себя сам.`,'Если записи прерываются, пришлите этот отчёт: в журнале будет причина.'));
 if(r.tools&&(!r.tools.ffmpeg||!r.tools.ffprobe))out.push(F('caution','FFmpeg недоступен','Прослушивание и расшифровка не работают.','Переустановите MONO.'));
 const a=r.archive||{};
 if(a.configured===false)out.push(F('warning','Папка архива не выбрана','','Настройки → Архив.'));
 else if(a.available===false)out.push(F('warning','Папка архива недоступна','Диск отключён или папка удалена.','Подключите диск или выберите папку снова.'));
 if(a.writeProbe==='blocked')out.push(F('warning','Windows блокирует запись в папку архива','Скорее всего «Контролируемый доступ к папкам».','Безопасность Windows → Защита от программ-шантажистов → разрешите MONO.'));
 else if(a.writeMs>1000)out.push(F('caution','Запись на диск медленная',`Пробный файл записан за ${a.writeMs} мс.`,a.location==='сетевая папка'?'Архив в сетевой папке — перенесите его на локальный диск.':'Проверьте антивирус и состояние диска.'));
 if(typeof a.hoursLeft==='number'&&a.hoursLeft<2)out.push(F(a.hoursLeft<.25?'warning':'caution','Мало места на диске',`${a.freeGB} ГБ — около ${a.hoursLeft} ч записи.`,'Освободите место или перенесите архив.'));
 if(a.records?.damaged)out.push(F('caution','Есть повреждённые записи',`${a.records.damaged} шт.`,'Откройте их в библиотеке: MONO предложит восстановление.'));
 if(a.records?.interrupted)out.push(F('advisory','Есть прерванные записи',`${a.records.interrupted} шт. — звук до обрыва сохранён.`));
 const c=r.capture||{};
 if(c.privacy?.blocked)out.push(F('warning','Windows запрещает доступ к микрофону','Ни один способ записи не получит звук микрофона.','Параметры → Конфиденциальность и защита → Микрофон: включите доступ (и для классических приложений).'));
 const inputs=c.inputs||[];const active=inputs.filter(d=>d.state==='active'),main=active.find(d=>d.default)||active[0];
 if(c.inputs&&!active.length)out.push(F('warning','Windows не видит рабочего микрофона',inputs.length?`Устройства есть, но они ${[...new Set(inputs.map(d=>d.state))].join(', ')}.`:'Ни одного входа звука.','Подключите микрофон или включите его: Параметры → Система → Звук.'));
 if(main?.muted)out.push(F('caution','Микрофон выключен в Windows',`«${main.name}».`,'MONO включит его при записи или нажмите «Исправить» в предполётной проверке.'));
 else if(main&&typeof main.volume==='number'&&main.volume<10)out.push(F('caution','Громкость микрофона почти 0',`«${main.name}»: ${main.volume} %.`,'MONO поднимет её при записи.'));
 if(c.source==='browser'&&c.module?.ready&&(c.module.modes||[]).includes('mic'))out.push(F('caution','Источник записи — окно браузера, хотя системный модуль готов','Системный модуль надёжнее: он открывает микрофон в общем режиме Windows с повтором через встроенный конвертер.','Студия → «Что записывать» → «Микрофон (системный модуль)». Если окно не откроет микрофон, MONO переключится сам.'));
 if(inputs.some(d=>/voicemeeter/i.test(d.name||''))&&c.heldBy!==null)out.push(F('advisory','Установлен Voicemeeter','Если ваш микрофон выбран в Voicemeeter аппаратным входом, он может забирать его у остальных программ.','При ошибке «микрофон занят» уберите микрофон из Voicemeeter на время записи.'));
 if(c.heldBy?.length&&!c.probe?.opened)out.push(F('advisory','Микрофон может держать другое приложение',c.heldBy.join(', ')+'.','Если запись не начинается — закройте его.'));
 if(c.module?.error)out.push(F('caution','Системный модуль записи не ответил',`Код: ${c.module.error}.`,'Микрофон пишется через окно; звук компьютера недоступен.'));
 else if(c.module&&!c.module.ready&&['HELPER_UNAVAILABLE','HELPER_MISSING'].includes(c.module.reason))out.push(F('advisory','Системный модуль записи не установлен','Микрофон пишется через окно; звук компьютера недоступен.',/^Windows/.test(r.system?.os||'')?'Переустановите MONO, если нужен звук компьютера.':'Звук компьютера записывается только в версии MONO для Windows.'));
 else if(c.module&&!c.module.ready&&c.module.reason==='NOT_SUPPORTED')out.push(F('caution','Windows не сообщает звуковых устройств','Модуль записи работает, но не видит ни входов, ни выходов.','Подключите микрофон или наушники.'));
 else if(c.module&&!c.module.ready&&c.module.reason)out.push(F('caution','Системный модуль записи не готов',`Код: ${c.module.reason}.`,'MONO перезапустит его сам; при повторе пришлите отчёт.'));
 const g=r.groq||{};
 if(g.configured===false)out.push(F('advisory','Groq не подключён','Записывать можно, расшифровка — после подключения ключа.'));
 else if(g.http===401)out.push(F('warning','Ключ Groq не принят','Groq ответил 401.','Создайте новый ключ на console.groq.com и подключите его снова.'));
 else if(g.http===403)out.push(F('warning','У ключа нет доступа','Groq ответил 403.','Проверьте организацию и разрешения ключа.'));
 else if(g.http===429)out.push(F('caution','Лимит Groq исчерпан','Groq ответил 429.','Расшифровка продолжится сама после сброса лимита.'));
 else if(g.http>=500)out.push(F('caution','Groq временно недоступен',`HTTP ${g.http}.`,'MONO повторит запросы сам.'));
 else if(g.error){const dns=g.error==='ENOTFOUND'||g.error==='EAI_AGAIN',tls=/CERT|SSL|TLS|SELF_SIGNED/i.test(g.error);
  out.push(F('caution','Нет связи с Groq',`Код: ${g.error}.`,dns?'Компьютер не находит api.groq.com: нет интернета или DNS блокирует адрес.':tls?'Защищённое соединение подменяется — обычно это антивирус или корпоративный прокси, проверяющий HTTPS.':g.error==='TIMEOUT'?'Groq не ответил за 10 с: медленная сеть или фильтр трафика.':g.error==='ECONNREFUSED'||g.error==='ECONNRESET'?'Соединение обрывается: обычно это брандмауэр, VPN или прокси.':'Проверьте интернет, VPN и прокси.'))}
 else if(g.http===200&&g.whisper===false)out.push(F('caution','Модель распознавания недоступна ключу','whisper-large-v3-turbo нет в списке моделей.','Проверьте ограничения моделей в организации Groq.'));
 else if(g.ms>3000)out.push(F('advisory','Groq отвечает медленно',`${g.ms} мс на служебный запрос.`));
 if(r.jobs?.recentErrors?.length)out.push(F('advisory','Были ошибки расшифровки',r.jobs.recentErrors.map(e=>e.error).slice(0,2).join(' · ')));
 const t=r.trends?.counts||{},topDevice=code=>Object.entries(r.trends?.devices?.[code]||{}).sort((a,b)=>b[1]-a[1])[0]?.[0];
 if(t.DEVICE_LOST>=2){const usb=r.power?.usbSelectiveSuspend,device=topDevice('DEVICE_LOST');
  out.push(F('caution','Микрофон периодически отключается',`${t.DEVICE_LOST} раз за ${r.trends.days} дн.${device?` Чаще всего — «${device}».`:''}${usb&&(usb.ac||usb.dc)?' В Windows включено временное отключение USB-портов для экономии энергии.':''}`,
   usb&&(usb.ac||usb.dc)?'Панель управления → Электропитание → Изменить параметры схемы → Дополнительные параметры → Параметры USB → «Временное отключение USB-порта»: Запрещено (для батареи и сети). Подключайте микрофон прямо к ноутбуку, без хаба.':'Подключайте микрофон прямо к ноутбуку, без хаба и удлинителя; попробуйте другой порт; отключите энергосбережение устройства в Диспетчере устройств.'))}
 if(t.START_FAILED>=3)out.push(F('caution','Запись часто не начинается с первого раза',`${t.START_FAILED} неудачных стартов за ${r.trends.days} дн. MONO восстанавливал их сам.`,'Пришлите этот отчёт: по журналу будет видно, на каком шаге.'));
 if(t.BROWSER_FALLBACK>=3)out.push(F('advisory','Системный модуль записи часто уступает запасному каналу',`${t.BROWSER_FALLBACK} раз за ${r.trends.days} дн.`,'Звук компьютера в такие моменты не пишется. Пришлите отчёт.'));
 if(t.SAFETY_USED)out.push(F('advisory','Страховочная дорожка уже спасала запись',`${t.SAFETY_USED} раз за ${r.trends.days} дн.`));
 if(t.SCRUB_DAMAGED)out.push(F('warning','Проверка целостности нашла повреждённые записи',`${t.SCRUB_DAMAGED} шт. Повреждение возникло на диске после сохранения.`,'Проверьте диск (свойства диска → Сервис → Проверить) и восстановите записи из резервной копии.'));
 const sick=(r.disks||[]).filter(d=>d.health&&d.health!=='Healthy');
 if(sick.length)out.push(F('warning','Windows сообщает о проблеме с диском',sick.map(d=>`«${d.name}»: ${d.health}${d.status?` (${d.status})`:''}`).join('; ')+'.','Сделайте резервную копию архива как можно скорее и проверьте диск.'));
 if(r.system?.freeMemoryGB!==undefined&&r.system.freeMemoryGB<.5)out.push(F('caution','Почти закончилась оперативная память',`Свободно ${r.system.freeMemoryGB} ГБ из ${r.system.memoryGB}.`,'Закройте лишние программы: интерфейс может тормозить, а запись — прерываться.'));
 return out;
}
