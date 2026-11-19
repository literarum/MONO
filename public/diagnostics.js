// Window side of «Глубокая диагностика»: what only this window can measure — the live
// microphone signal, graphics, frame rate, interface freezes, memory and browser devices.

// Interface freezes (main-thread tasks > 50 ms) are counted from the moment MONO opens.
const freezes={count:0,longestMs:0,since:typeof performance!=='undefined'?performance.now():0};
try{new PerformanceObserver(list=>{for(const e of list.getEntries()){freezes.count++;freezes.longestMs=Math.max(freezes.longestMs,Math.round(e.duration))}}).observe({type:'longtask',buffered:true})}catch{}

const dbfs=value=>value>0?Math.round(20*Math.log10(value)*10)/10:-120;
/** Signal statistics of float samples: peak/RMS in dBFS and the share of clipped samples. */
export function signalStats(samples){
 let peak=0,sum=0,clipped=0;for(const v of samples){const a=Math.abs(v);if(a>peak)peak=a;sum+=v*v;if(a>=.999)clipped++}
 const n=samples.length||1;return {peakDb:dbfs(peak),rmsDb:dbfs(Math.sqrt(sum/n)),clippedShare:clipped/n};
}

/** Opens the microphone for `ms` and measures it. Never prompts: runs only when access was already granted. */
export async function microphoneProbe({deviceId=null,ms=1500,nav=globalThis.navigator,contextFactory=()=>new AudioContext()}={}){
 let state=null;try{state=(await nav.permissions?.query({name:'microphone'}))?.state}catch{}
 if(state!=='granted')return {skipped:state==='denied'?'denied':'not-granted'};
 const started=performance.now();let stream,context;
 try{
  stream=await nav.mediaDevices.getUserMedia({audio:{...(deviceId?{deviceId:{exact:deviceId}}:{}),echoCancellation:false,noiseSuppression:false,autoGainControl:false},video:false});
  const openMs=Math.round(performance.now()-started),track=stream.getAudioTracks()[0],settings=track?.getSettings?.()||{};
  context=contextFactory();if(context.state==='suspended')await context.resume().catch(()=>{});
  const analyser=context.createAnalyser();analyser.fftSize=2048;context.createMediaStreamSource(stream).connect(analyser);
  const buffer=new Float32Array(analyser.fftSize),all=[];const until=performance.now()+ms;
  while(performance.now()<until){await new Promise(r=>setTimeout(r,40));analyser.getFloatTimeDomainData(buffer);all.push(...buffer)}
  return {ok:true,openMs,label:track?.label||null,sampleRate:settings.sampleRate||context.sampleRate||null,channels:settings.channelCount||null,contextState:context.state,trackState:track?.readyState,muted:Boolean(track?.muted),...signalStats(all)};
 }catch(error){return {ok:false,error:error?.name||'Error',constraint:error?.constraint||null,ms:Math.round(performance.now()-started)}}
 finally{stream?.getTracks().forEach(t=>t.stop());void context?.close?.().catch(()=>{})}
}

function gpu(){
 try{const canvas=document.createElement('canvas'),gl=canvas.getContext('webgl')||canvas.getContext('experimental-webgl');if(!gl)return {webgl:false};
  const info=gl.getExtension('WEBGL_debug_renderer_info');const renderer=info?gl.getParameter(info.UNMASKED_RENDERER_WEBGL):gl.getParameter(gl.RENDERER);
  gl.getExtension('WEBGL_lose_context')?.loseContext();return {webgl:true,renderer:String(renderer).slice(0,120),software:/SwiftShader|llvmpipe|Software|Basic Render/i.test(renderer)}}catch{return {webgl:false}}
}
/** Frame pacing over ~1 s of requestAnimationFrame: refresh rate and share of slow frames. */
export function frameStats(intervals){
 const sorted=[...intervals].sort((a,b)=>a-b),median=sorted[Math.floor(sorted.length/2)]||0;
 return {fps:median?Math.round(1000/median):null,slowShare:intervals.length?intervals.filter(t=>t>median*1.8&&t>20).length/intervals.length:0,worstMs:Math.round(sorted.at(-1)||0)};
}
const frames=(count=60)=>new Promise(resolve=>{const out=[];let last=0;const step=t=>{if(last)out.push(t-last);last=t;if(out.length>=count)resolve(out);else requestAnimationFrame(step)};requestAnimationFrame(step);setTimeout(()=>resolve(out),3000)});

export async function windowProbe({nav=globalThis.navigator}={}){
 const out={userAgent:nav.userAgent,brands:nav.userAgentData?.brands?.map(b=>`${b.brand} ${b.version}`).join(', ')||null,platform:nav.userAgentData?.platform||nav.platform,language:nav.language,online:nav.onLine,
  cores:nav.hardwareConcurrency||null,deviceMemoryGB:nav.deviceMemory||null,screen:`${screen.width}×${screen.height} @${devicePixelRatio}x`,window:`${innerWidth}×${innerHeight}`,
  liteGlass:document.documentElement.classList.contains('lite-glass'),reducedMotion:matchMedia('(prefers-reduced-motion: reduce)').matches,
  visible:document.visibilityState,serviceWorker:Boolean(nav.serviceWorker?.controller),freezes:{count:freezes.count,longestMs:freezes.longestMs,minutes:+((performance.now()-freezes.since)/60000).toFixed(1)},gpu:gpu()};
 try{const m=performance.memory;if(m)out.memoryMB={used:Math.round(m.usedJSHeapSize/1024**2),limit:Math.round(m.jsHeapSizeLimit/1024**2)}}catch{}
 try{const e=await nav.storage?.estimate?.();if(e)out.storage={usedMB:Math.round((e.usage||0)/1024**2),quotaMB:Math.round((e.quota||0)/1024**2),persisted:await nav.storage.persisted?.()}}catch{}
 try{const b=await nav.getBattery?.();if(b)out.battery={level:Math.round(b.level*100),charging:b.charging}}catch{}
 try{out.devices=(await nav.mediaDevices.enumerateDevices()).filter(d=>d.kind==='audioinput'||d.kind==='audiooutput').map(d=>({kind:d.kind==='audioinput'?'вход':'выход',label:d.label||'(название скрыто до разрешения)',default:d.deviceId==='default'}))}catch{out.devices=null}
 try{const caches_=await caches.keys();out.shellCache=caches_.filter(k=>k.startsWith('mono-shell')).join(', ')||null}catch{}
 if(document.visibilityState==='visible')out.frames=frameStats(await frames());
 return out;
}

const F=(level,title,detail,action=null)=>({level,title,detail,...(action?{action}:{})});
export function windowFindings(w,mic){
 const out=[];
 if(mic?.ok===false){
  const why={NotReadableError:['Окно не может открыть микрофон: он занят или захвачен в монопольном режиме','Закройте программы, которые держат микрофон (Discord, Zoom, Teams, Voicemeeter), или снимите галочки «Монопольный режим»: Панель управления → Звук → Запись → микрофон → Свойства → Дополнительно. MONO при записи сам попробует системный модуль.'],NotAllowedError:['Доступ к микрофону запрещён','Разрешите микрофон для MONO в «Параметры → Конфиденциальность → Микрофон».'],NotFoundError:['Микрофон не найден','Подключите микрофон.'],OverconstrainedError:['Выбранный микрофон больше не существует','Выберите микрофон заново в студии.'],AbortError:['Windows прервала открытие микрофона','Переподключите устройство и повторите.']}[mic.error]||['Микрофон не открылся',''];
  out.push(F('warning',why[0],`Окно получило ${mic.error}${mic.constraint?` (${mic.constraint})`:''}.`,why[1]));
 }else if(mic?.ok){
  if(mic.peakDb<=-90)out.push(F('warning','Микрофон открылся, но передаёт полную тишину',`«${mic.label||'по умолчанию'}»: пик ${mic.peakDb} dBFS.`,'Часто это выключенный аппаратный переключатель, неправильный вход по умолчанию или звук, выключенный в Windows.'));
  else if(mic.peakDb<-50)out.push(F('caution','Очень тихий сигнал микрофона',`Пик ${mic.peakDb} dBFS за 1,5 с (если вы молчали — это нормально).`,'Скажите что-нибудь во время проверки или поднимите громкость входа.'));
  if(mic.clippedShare>.01)out.push(F('caution','Микрофон перегружен',`${(mic.clippedShare*100).toFixed(1)} % отсчётов на пределе.`,'Уменьшите громкость входа в Windows.'));
  if(mic.openMs>2500)out.push(F('advisory','Микрофон открывается медленно',`${mic.openMs} мс.`,'Bluetooth-гарнитуры переключают профиль; первая секунда записи может пропасть.'));
  if(mic.muted)out.push(F('caution','Система приглушила дорожку микрофона','track.muted = true.','Проверьте аппаратную кнопку выключения микрофона.'));
 }else if(mic?.skipped==='denied')out.push(F('caution','Окну запрещён доступ к микрофону','Живую проверку сигнала провести нельзя.','Меню окна → Сведения о сайте → Микрофон: «Разрешить».'));
 if(w?.gpu?.software)out.push(F('caution','Графика работает без видеокарты',`Рендерер: ${w.gpu.renderer}.`,'Обновите драйвер видеокарты: без него интерфейс не будет плавным.'));
 if(w?.frames?.fps&&w.frames.slowShare>.2)out.push(F('advisory','Кадры интерфейса неровные',`${w.frames.fps} Гц, ${Math.round(w.frames.slowShare*100)} % медленных кадров.`,w.liteGlass?'Облегчённое оформление уже включено.':'MONO включит облегчённое оформление сам, если так будет и при работе.'));
 if(w?.freezes?.count>=5&&w.freezes.longestMs>250)out.push(F('advisory','Интерфейс подвисал',`${w.freezes.count} задержек больше 50 мс за ${w.freezes.minutes} мин, самая долгая — ${w.freezes.longestMs} мс.`));
 if(w?.memoryMB&&w.memoryMB.used>w.memoryMB.limit*.8)out.push(F('caution','Окну не хватает памяти',`${w.memoryMB.used} из ${w.memoryMB.limit} МБ.`,'Перезапустите MONO.'));
 if(w&&w.online===false)out.push(F('caution','Нет сети','Записи сохраняются; расшифровка продолжится, когда сеть вернётся.'));
 if(w?.battery&&!w.battery.charging&&w.battery.level<20)out.push(F('advisory','Низкий заряд батареи',`${w.battery.level} %.`,'Подключите зарядку перед долгой записью.'));
 return out;
}

const LEVEL_MARK={warning:'✖',caution:'▲',advisory:'●',ok:'✓'};
const ORDER=['warning','caution','advisory','ok'];
export function sortFindings(list){return [...list].sort((a,b)=>ORDER.indexOf(a.level)-ORDER.indexOf(b.level))}
/** Human-readable text first (what is wrong, what to do), then the full data for support. */
export function formatReport(report){
 const lines=['MONO — глубокая диагностика',`Время: ${report.generatedAt}`,`Версия: ${report.server?.app?.version||'?'} · ${report.window?.brands||report.window?.userAgent||''}`,''];
 const list=sortFindings(report.findings||[]);
 lines.push(list.length?'ЧТО НАЙДЕНО':'ЧТО НАЙДЕНО: проблем не обнаружено');
 for(const f of list)lines.push(`${LEVEL_MARK[f.level]||'•'} ${f.title}${f.detail?' — '+f.detail:''}${f.action?`\n   Что сделать: ${f.action}`:''}`);
 lines.push('','ДАННЫЕ ДЛЯ ПОДДЕРЖКИ (без названий записей, текста, ключей и путей)',JSON.stringify({server:report.server,window:report.window,microphone:report.microphone,recentWindowErrors:report.recentWindowErrors},null,1));
 return lines.join('\n');
}

/** Root-cause consolidation (as a central maintenance computer does): when a cause is known,
 * its consequences are folded into it instead of being listed as separate faults. */
const CAUSES=[
 {cause:/^Windows запрещает доступ к микрофону$|^Доступ к микрофону запрещён$/,effects:/микрофон|Микрофон|Окну запрещён доступ/},
 {cause:/^Ядро архива не отвечает$|^Ядро не ответило на диагностику$/,effects:/архив|Папка|модуль записи|записи/},
 {cause:/^Нет сети$/,effects:/Groq/},
 {cause:/^Папка архива недоступна$/,effects:/Запись на диск|места на диске|блокирует запись/},
];
export function consolidate(list){
 let out=sortFindings(list);
 for(const rule of CAUSES){
  const root=out.find(f=>rule.cause.test(f.title));if(!root)continue;
  const folded=out.filter(f=>f!==root&&rule.effects.test(f.title)&&!rule.cause.test(f.title));
  if(!folded.length)continue;
  out=out.filter(f=>!folded.includes(f));
  const index=out.indexOf(root);out[index]={...root,detail:[root.detail,`Следствия этой причины (${folded.length}): ${folded.map(f=>f.title.toLowerCase()).join('; ')}.`].filter(Boolean).join(' ')};
 }
 return out;
}
