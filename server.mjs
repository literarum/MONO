import http from 'node:http';
import {createReadStream, createWriteStream, existsSync, readFileSync} from 'node:fs';
import {mkdir, readFile, writeFile, rename, readdir, stat, unlink, statfs} from 'node:fs/promises';
import {pipeline} from 'node:stream/promises';
import {Transform,Readable} from 'node:stream';
import {spawn} from 'node:child_process';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomUUID, timingSafeEqual,createHash} from 'node:crypto';
import {planSegments,normalizeSegments,estimateCostSeconds,alignToSilence,parseSilences,contextPrompt,isHallucination,rateLimitWait} from './core.mjs';
import {localRoute,localWorker,authorizeLocalRequest} from './backend/local/routes.mjs';
import {systemAccent} from './backend/local/appearance.mjs';
import {checkUpdate} from './backend/local/updates.mjs';
import {KeyManager} from './backend/groq/key-manager.mjs';
import {Summarizer} from './backend/groq/summary.mjs';
import {Journal,collect as collectDiagnostics} from './backend/local/diagnostics.mjs';
import {OriginalMedia} from './backend/audio/original-media.mjs';
import {AudioPreparation} from './backend/audio/preparation-service.mjs';

const startupEpoch=performance.now();
function startupPhase(phase){
  if(process.env.MONO_STARTUP_TRACE==='1')console.error(JSON.stringify({event:'startup_phase',phase,ms:Math.round(performance.now()-startupEpoch)}));
}
startupPhase('imports.ready');
const base=path.dirname(fileURLToPath(import.meta.url));
const pub=path.join(base,'public');
const storage=path.resolve(process.env.MONO_DATA_DIR||path.join(base,'local-data'));
// Core black box for «Глубокая диагностика»: every warning/error and each start, kept across restarts.
const journal=new Journal({file:path.join(storage,'diagnostics-journal.json')});journal.capture();journal.note('start','MONO запущен');
const folders={jobs:path.join(storage,'jobs'),audio:path.join(storage,'audio'),segments:path.join(storage,'segments')};
const DEPLOY_MODE=process.env.MONO_DEPLOY_MODE||'local';
const HOST=process.env.MONO_HOST||(DEPLOY_MODE==='proxy'?'0.0.0.0':'127.0.0.1');
const PORT=Number(process.env.PORT||4173);
// A stray rejected promise (a closed socket, an aborted probe) is logged, never fatal: one
// background hiccup must not take recording and the archive down with it.
process.on('unhandledRejection',error=>{console.error(JSON.stringify({event:'unhandled_rejection',message:String(error?.code||error?.message||error).slice(0,200)}))});
const MAX_BYTES=Number(process.env.MONO_MAX_UPLOAD_BYTES||1024*1024*1024);
const MIN_FREE_BYTES=256*1024*1024;
const JOB_TTL_HOURS=Number(process.env.MONO_JOB_TTL_HOURS||168);
const PUBLIC_ORIGIN=process.env.MONO_PUBLIC_ORIGIN||'';
const secretFrom=(env,file)=>file?readFileSync(file,'utf8').trim():(env||'');
const PROXY_SECRET=secretFrom(process.env.MONO_PROXY_SECRET,process.env.MONO_PROXY_SECRET_FILE);
const GROQ_KEY=secretFrom(process.env.GROQ_API_KEY,process.env.GROQ_API_KEY_FILE);
const GROQ_ENDPOINT=process.env.MONO_GROQ_ENDPOINT||'https://api.groq.com/openai/v1/audio/transcriptions';
if(!Number.isInteger(PORT)||PORT<1||PORT>65535)throw new Error('PORT должен быть 1..65535');
if(!Number.isSafeInteger(MAX_BYTES)||MAX_BYTES<1024||MAX_BYTES>2*1024**3)throw new Error('Некорректный MONO_MAX_UPLOAD_BYTES');
if(!Number.isFinite(JOB_TTL_HOURS)||JOB_TTL_HOURS<24||JOB_TTL_HOURS>720)throw new Error('MONO_JOB_TTL_HOURS должен быть 24..720');
if(DEPLOY_MODE==='local'){
  if(!['127.0.0.1','localhost'].includes(HOST))throw new Error('Локальный режим разрешает только loopback bind');
}else if(DEPLOY_MODE==='proxy'){
  let url;
  try{url=new URL(PUBLIC_ORIGIN)}catch{throw new Error('Требуется MONO_PUBLIC_ORIGIN=https://домен')}
  if(url.protocol!=='https:'||url.username||url.password||url.pathname!=='/'||url.search||url.hash)
    throw new Error('В proxy режиме нужен HTTPS origin без пути');
  if(PROXY_SECRET.length<32)throw new Error('MONO_PROXY_SECRET должен содержать >=32 символов');
  if(!GROQ_KEY)throw new Error('В proxy режиме требуется GROQ_API_KEY');
}else throw new Error('MONO_DEPLOY_MODE: local или proxy');
const jobs=new Map();
const activeControllers=new Map();
const activeChildren=new Map();
const saving=new Map();
const uploadingKeys=new Set();
const MAX_CONCURRENT_UPLOADS=2;
let uploadsInFlight=0;
const config={ffmpeg:false,ffprobe:false,groq:!!GROQ_KEY};
// One source of the version: package.json ships with the server in every build.
const VERSION=JSON.parse(readFileSync(new URL('./package.json',import.meta.url),'utf8')).version;
// Absolute paths from the launcher; plain names rely on PATH (Docker, dev).
const TOOLS={ffmpeg:process.env.MONO_FFMPEG||'ffmpeg',ffprobe:process.env.MONO_FFPROBE||'ffprobe'};
// Detection is asynchronous and patient: the first launch of a ~100 MB ffmpeg.exe
// under antivirus scanning can take many seconds. A 2 s synchronous probe used to
// mark FFmpeg "missing" for the whole session.
function probeTool(name){
  startupPhase('runtime.'+name+'.begin');
  return new Promise(resolve=>{
    let child;try{child=spawn(TOOLS[name],['-version'],{stdio:'ignore',windowsHide:true})}catch{resolve(false);return}
    const timer=setTimeout(()=>{child.kill('SIGKILL');resolve(false)},60000);
    child.on('error',()=>{clearTimeout(timer);resolve(false)});
    child.on('close',code=>{clearTimeout(timer);resolve(code===0)});
  }).then(ok=>{config[name]=ok;startupPhase('runtime.'+name+'.end');return ok});
}
let toolsChecking=null;
function detectTools({force=false}={}){
  if(toolsChecking)return toolsChecking;
  if(!force&&config.ffmpeg&&config.ffprobe)return Promise.resolve(true);
  toolsChecking=Promise.all([probeTool('ffmpeg'),probeTool('ffprobe')]).then(([a,b])=>a&&b).finally(()=>{toolsChecking=null});
  return toolsChecking;
}
const toolsReady=detectTools();
const eventClients=new Set();
function broadcast(event,data){for(const client of eventClients)client.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)}
let accent=null,availableUpdate=null;void systemAccent().then(value=>{accent=value});
if(process.env.MONO_LAUNCHER==='1'&&!process.env.NODE_TEST_CONTEXT)setTimeout(()=>void checkUpdate({current:VERSION}).then(value=>{availableUpdate=value}),20000).unref();
const originalMedia=new OriginalMedia(localWorker);
const preparation=new AudioPreparation(localWorker,originalMedia);
const keyManager=new KeyManager({worker:localWorker,externalKey:GROQ_KEY,endpoint:new URL('/openai/v1/models',GROQ_ENDPOINT).href,onChange:status=>{
  const changed=config.groq!==status.configured;config.groq=status.configured;
  if(changed){if(status.configured)void pump();else activeControllers.forEach(controller=>controller.abort())}
}});
let workerBusy=false;
const knownTypes={
  '.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8',
  '.svg':'image/svg+xml','.json':'application/json; charset=utf-8','.webmanifest':'application/manifest+json',
  '.png':'image/png','.ico':'image/x-icon'
};
const json=(res,status,body)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});res.end(JSON.stringify(body))};
function errorText(e){return (e instanceof Error?e.message:String(e)).slice(0,300)}
function fail(res,status,message){json(res,status,{error:message})}
function secureEqual(a,b){
  if(typeof a!=='string'||!b)return false;
  const x=Buffer.from(a),y=Buffer.from(b);
  return x.length===y.length&&timingSafeEqual(x,y);
}
function acceptableOrigin(req){
  const host=req.headers.host||'';
  const origin=req.headers.origin;
  if(DEPLOY_MODE==='proxy'){
    if(!secureEqual(req.headers['x-mono-proxy-secret'],PROXY_SECRET))return false;
    const expected=new URL(PUBLIC_ORIGIN);
    if(host!==expected.host)return false;
    return !origin||origin===expected.origin;
  }
  const expected=new Set([`${HOST}:${PORT}`,`127.0.0.1:${PORT}`,`localhost:${PORT}`]);
  if(!expected.has(host))return false;
  if(!origin)return true;
  try{
    const u=new URL(origin);
    return u.host===host && (u.protocol==='http:'||u.protocol==='https:');
  }catch{return false}
}
const counters={requests:0,errors:0,uploadRejected:0,workCompleted:0,workFailed:0};
let stopping=false;
const startedAt=Date.now();
function publicHealth(){
  const pending=[...jobs.values()].filter(j=>j.status==='queued').length;
  return {...config,accent,update:availableUpdate,toolsChecking:Boolean(toolsChecking),version:VERSION,mode:DEPLOY_MODE,maxUploadBytes:MAX_BYTES,
    retentionHours:JOB_TTL_HOURS,instanceId:process.env.MONO_LAUNCHER_INSTANCE_ID||null,queue:pending,processing:[...jobs.values()].filter(j=>j.status==='processing').length,
    uploadsInFlight,uptimeSeconds:Math.floor((Date.now()-startedAt)/1000),stopping};
}
async function writeAtomic(file,content){
  const tmp=`${file}.${randomUUID()}.tmp`;
  try{await writeFile(tmp,content);await rename(tmp,file)}
  catch(e){await unlink(tmp).catch(()=>{});throw e}
}
async function save(job) {
  const {rawResult,...persisted}=job;
  const file=path.join(folders.jobs,job.id+'.json');
  // Serialize immutable snapshots: status updates and HTTP cancel can race.
  const snapshot=JSON.stringify(persisted);
  const previous=saving.get(job.id)||Promise.resolve();
  const next=previous.catch(()=>{}).then(()=>writeAtomic(file,snapshot));
  saving.set(job.id,next);
  try{await next}finally{if(saving.get(job.id)===next)saving.delete(job.id)}
}
async function update(job,patch){Object.assign(job,patch,{updatedAt:new Date().toISOString()});await save(job)}
async function run(binary,args,timeout=600000,jobId=null) {
  return await new Promise((resolve,reject)=>{
    const child=spawn(binary,args,{stdio:['ignore','pipe','pipe']});
    if(jobId)activeChildren.set(jobId,child);
    let out='',err='';
    const timer=setTimeout(()=>child.kill('SIGKILL'),timeout);
    const clear=()=>{clearTimeout(timer);if(jobId&&activeChildren.get(jobId)===child)activeChildren.delete(jobId)};
    child.stdout.on('data',b=>{out+=b.toString().slice(0,20000);if(out.length>30000)out=out.slice(-30000)});
    child.stderr.on('data',b=>{err+=b.toString();if(err.length>16000)err=err.slice(-16000)});
    child.on('error',e=>{clear();reject(e)});
    child.on('close',code=>{clear();code===0?resolve(out):reject(new Error(`${binary} завершился с кодом ${code}: ${err.slice(-350)}`))});
  });
}
async function probe(filename){
  const raw=await run('ffprobe',['-v','error','-select_streams','a:0','-show_entries','format=duration:stream=codec_type','-of','json',filename]);
  const parsed=JSON.parse(raw);
  const duration=Number(parsed.format?.duration);
  if(!parsed.streams?.some(s=>s.codec_type==='audio')||!Number.isFinite(duration)||duration<=0)throw new Error('Аудиодорожка не обнаружена');
  return duration;
}
async function encodeSegment(job,plan) {
  const output=path.join(folders.segments,`${job.id}-${plan.index}.flac`);
  if(existsSync(output)){
    // A crash may leave a truncated FLAC; never reuse it without probing.
    try{if((await stat(output)).size>100 && await probe(output)>0)return output}catch{}
    await unlink(output).catch(()=>{});
  }
  const filter={cautious:'highpass=f=70',standard:'highpass=f=75,loudnorm=I=-19:TP=-2:LRA=11',enhanced:'highpass=f=90,afftdn=nf=-28,loudnorm=I=-19:TP=-2:LRA=11'}[job.profile]||'highpass=f=70';
  // Local selections are already whole-track versions. Preserve their PCM and
  // channels; a second per-chunk DSP pass would change what the user heard.
  const conversion=job.selectionPipeline==='local-selected-1'?[]:['-af',filter,'-ar','16000','-ac','1'];
  await run('ffmpeg',['-hide_banner','-loglevel','error','-y','-ss',String(plan.mediaStart),'-i',job.audioPath,'-t',String(plan.mediaEnd-plan.mediaStart),'-map','0:a:0',...conversion,'-c:a','flac',output],900000,job.id);
  const size=(await stat(output)).size;
  if(size>24*1024*1024)throw new Error('Сегмент превысил безопасный лимит загрузки Groq (24 МиБ)');
  return output;
}
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
/** Last confident words of a segment response: context for the next request (never a hallucination). */
function tailOf(data){const kept=(data?.segments||[]).filter(s=>!isHallucination(s)).map(s=>String(s.text||'')).join(' ').trim();return kept.slice(-300)}
// A window whose loudest sample stays below this cannot contain usable speech.
// Sending it costs the 10 s billing minimum and invites Whisper's silence
// hallucinations, so it is transcribed locally as empty.
const SILENCE_PEAK_DB=-60;
async function peakDecibels(job,plan){
  return await new Promise(resolve=>{
    const child=spawn('ffmpeg',['-hide_banner','-nostats','-ss',String(plan.mediaStart),'-i',job.audioPath,'-t',String(plan.mediaEnd-plan.mediaStart),'-map','0:a:0','-af','volumedetect','-f','null','-'],{stdio:['ignore','ignore','pipe'],windowsHide:true});
    if(job.id)activeChildren.set(job.id,child);
    let err='';const timer=setTimeout(()=>child.kill('SIGKILL'),300000);
    child.stderr.on('data',b=>{err=(err+b.toString()).slice(-8000)});
    const done=value=>{clearTimeout(timer);if(activeChildren.get(job.id)===child)activeChildren.delete(job.id);resolve(value)};
    // Any measurement failure means "not proven silent": the segment is sent.
    child.on('error',()=>done(null));
    child.on('close',code=>{const match=/max_volume:\s*(-?inf|-?[\d.]+)\s*dB/.exec(err);done(code===0&&match?(match[1].endsWith('inf')?-Infinity:Number(match[1])):null)});
  });
}
/** Pauses of ≥0.4 s below −35 dBFS across the whole file, for cutting segments in silence.
 * Any failure means "no map" and the fixed plan is used. */
async function silenceMap(job,duration){
  return await new Promise(resolve=>{
    const child=spawn('ffmpeg',['-hide_banner','-nostats','-i',job.audioPath,'-map','0:a:0','-af','silencedetect=noise=-35dB:d=0.4','-f','null','-'],{stdio:['ignore','ignore','pipe'],windowsHide:true});
    if(job.id)activeChildren.set(job.id,child);
    let err='';const timer=setTimeout(()=>child.kill('SIGKILL'),Math.max(60000,Math.min(900000,duration*1000)));
    child.stderr.on('data',b=>{err+=b.toString();if(err.length>4_000_000)err=err.slice(-4_000_000)});
    const done=value=>{clearTimeout(timer);if(activeChildren.get(job.id)===child)activeChildren.delete(job.id);resolve(value)};
    child.on('error',()=>done([]));child.on('close',code=>done(code===0?parseSilences(err):[]));
  });
}
function retryDelay(header,attempt){
  const num=Number(header);
  const fromHeader=Number.isFinite(num)&&num>=0?num*1000:
    Math.max(0,Date.parse(header||'')-Date.now())||0;
  return Math.min(120000,Math.max(fromHeader,1000*2**attempt)*(0.85+Math.random()*.3));
}
async function transcribe(segmentFile,job) {
  const bytes=await readFile(segmentFile);
  const form=new FormData();
  form.append('file',new Blob([bytes],{type:'audio/flac'}),'segment.flac');
  form.append('model','whisper-large-v3-turbo');
  form.append('language','ru');
  form.append('response_format','verbose_json');
  form.append('temperature','0');
  form.append('timestamp_granularities[]','segment');
  const prompt=contextPrompt(job.prompt,job.contextTail);if(prompt)form.append('prompt',prompt);
  const controller=new AbortController();activeControllers.set(job.id,controller);
  try{
    const response=await fetch(GROQ_ENDPOINT,{
      method:'POST',headers:{Authorization:`Bearer ${await keyManager.getKey()}`},body:form,
      signal:AbortSignal.any([controller.signal,AbortSignal.timeout(180000)])
    });
    if(!response.ok){
      const e=new Error(response.status===429?'Превышен лимит запросов Groq':`Groq вернул HTTP ${response.status}`);
      e.retryable=[408,425,429].includes(response.status)||response.status>=500;
      e.retryAfter=response.headers.get('retry-after');throw e;
    }
    const data=await response.json();
    if(typeof data.text!=='string')throw new Error('Groq вернул ответ без текста');
    job.rateWait=rateLimitWait(response.headers);
    return data;
  }finally{activeControllers.delete(job.id)}
}
async function cleanupAudio(job){
  if(job.audioPath&&path.resolve(job.audioPath).startsWith(folders.audio+path.sep))await unlink(job.audioPath).catch(()=>{});
  for(let i=0;i<(job.total||0);i++){
    await unlink(path.join(folders.segments,`${job.id}-${i}.json`)).catch(()=>{});
    await unlink(path.join(folders.segments,`${job.id}-${i}.flac`)).catch(()=>{});
  }
}
async function purge(job){
  activeControllers.get(job.id)?.abort();
  activeChildren.get(job.id)?.kill('SIGKILL');
  await (saving.get(job.id)||Promise.resolve()).catch(()=>{});
  const files=[path.join(folders.jobs,`${job.id}.json`),path.join(folders.jobs,`${job.id}.result.json`)];
  if(job.audioPath&&path.resolve(job.audioPath).startsWith(folders.audio+path.sep))files.push(job.audioPath);
  for(let i=0;i<Math.max(1,job.total||0);i++){
    files.push(path.join(folders.segments,`${job.id}-${i}.json`));
    files.push(path.join(folders.segments,`${job.id}-${i}.flac`));
  }
  for(const filename of files)await unlink(filename).catch(()=>{});
  jobs.delete(job.id);
}
async function reapExpiredJobs(){
  const expireBefore=Date.now()-JOB_TTL_HOURS*3600*1000;
  for(const job of jobs.values()){
    if(!['completed','failed','cancelled'].includes(job.status))continue;
    const when=Date.parse(job.updatedAt||job.createdAt);
    if(Number.isFinite(when)&&when<expireBefore){
      await purge(job);
      console.log(JSON.stringify({event:'expired_job_purged'}));
    }
  }
}
async function doWork(job){
  await toolsReady;if(!config.ffmpeg||!config.ffprobe)await detectTools({force:true});
  if(!config.ffmpeg||!config.ffprobe||!config.groq){
    await update(job,{status:'failed',stage:'Ошибка конфигурации',error:'Для обработки нужны FFmpeg, FFprobe и GROQ_API_KEY'});return;
  }
  try{
    await update(job,{status:'processing',stage:'Анализ записи',error:null});
    if(job.selectionPipeline==='local-selected-1'){
      if(job.preparedVersionId)await preparation.resolve(job.recordId,job.preparedVersionId);
      else await originalMedia.sources(job.recordId);
      const digest=createHash('sha256');for await(const bytes of createReadStream(job.audioPath))digest.update(bytes);
      if(digest.digest('hex')!==job.audioSha256)throw Object.assign(new Error('AUDIO_DAMAGED'),{code:'AUDIO_DAMAGED'});
    }
    const duration=await probe(job.audioPath);
    // Cut in pauses, not mid-word; the plan is stored so a resumed job reuses its cached segments.
    let plans=Array.isArray(job.plans)&&job.plans.length&&Math.abs(job.plans.at(-1).end-duration)<0.01?job.plans:null;
    if(!plans){const fixed=planSegments(duration,job.segmentSeconds||240);plans=fixed.length>1?alignToSilence(fixed,await silenceMap(job,duration)):fixed;await update(job,{plans})}
    await update(job,{duration,total:plans.length,stage:'Подготовка и распознавание'});
    const done=[];
    // Keep the computer awake while this job runs (lease renewed each segment, 3 min).
    const holdAwake=()=>localWorker.call('power.busy',{seconds:180}).catch(()=>{});
    if(DEPLOY_MODE==='local')void holdAwake();
    for(const plan of plans){
      if(DEPLOY_MODE==='local')void holdAwake();
      if(job.cancelRequested||stopping){await update(job,{status:stopping?'queued':'cancelled',stage:stopping?'Ожидает перезапуска':'Отменено пользователем'});return}
      const cached=path.join(folders.segments,`${job.id}-${plan.index}.json`);
      if(existsSync(cached)){
        try{
          const data=JSON.parse(await readFile(cached,'utf-8'));
          if(typeof data.text!=='string')throw new Error('Invalid cached segment');
          done.push({plan,data});job.contextTail=tailOf(data);await update(job,{completed:done.length});continue;
        }catch{await unlink(cached).catch(()=>{})}
      }
      await update(job,{stage:`Подготовка сегмента ${plan.index+1}/${plans.length}`});
      const peak=await peakDecibels(job,plan);
      if(peak!==null&&peak<=SILENCE_PEAK_DB){
        const silent={text:'',segments:[],skipped:'silence'};job.contextTail='';
        await writeAtomic(cached,JSON.stringify(silent));done.push({plan,data:silent});
        await update(job,{completed:done.length,skippedSilent:(job.skippedSilent||0)+1});continue;
      }
      const audioFile=await encodeSegment(job,plan);
      let data;
      for(let attempt=0;attempt<4;attempt++){
        if(job.cancelRequested||stopping){await update(job,{status:stopping?'queued':'cancelled',stage:stopping?'Ожидает перезапуска':'Отменено пользователем'});return}
        // Potential charge per outbound attempt, even if timeout hides a successful inference.
        await update(job,{stage:`Groq · сегмент ${plan.index+1}/${plans.length}`,
          attempts:(job.attempts||0)+1,
          estimatedUSD:(job.estimatedUSD||0)+estimateCostSeconds(plan.mediaEnd-plan.mediaStart)});
        if(job.rateWait){await update(job,{stage:'Пауза по лимиту Groq'});await sleep(job.rateWait);job.rateWait=0}
        try{data=await transcribe(audioFile,job);break}
        catch(e){
          if(job.cancelRequested||stopping||(!(e.retryable??['TimeoutError','TypeError','AbortError'].includes(e.name)))||attempt===3)throw e;
          await update(job,{stage:'Повторный запрос после временной ошибки'});
          await sleep(retryDelay(e.retryAfter,attempt));
        }
      }
      if(job.cancelRequested||stopping){await update(job,{status:stopping?'queued':'cancelled',stage:stopping?'Ожидает перезапуска':'Отменено пользователем'});return}
      await writeAtomic(cached,JSON.stringify(data));
      done.push({plan,data});job.contextTail=tailOf(data);
      await update(job,{completed:done.length});
      await unlink(audioFile).catch(()=>{});
    }
    if(job.cancelRequested||stopping){await update(job,{status:stopping?'queued':'cancelled'});return}
    const segments=normalizeSegments(done);
    const transcript={segments,text:segments.map(s=>s.text).join(' ').trim(),
      duration,model:'whisper-large-v3-turbo'};
    // Store result independent of UI lifetime. Never log transcript text.
    const resultPath=path.join(folders.jobs,`${job.id}.result.json`);
    await writeAtomic(resultPath,JSON.stringify(transcript));
    await update(job,{status:'completed',stage:'Завершено',completed:plans.length,resultReady:true});
    counters.workCompleted++;
  }catch(e){
    if(stopping)await update(job,{status:'queued',stage:'Ожидает перезапуска',error:null});
    else if(job.cancelRequested)await update(job,{status:'cancelled',stage:'Отменено пользователем',error:null});
    else if(DEPLOY_MODE==='local'&&(!config.groq||['KEY_NOT_CONFIGURED','VAULT_UNAVAILABLE','VAULT_LOCKED'].includes(e.code)))await update(job,{status:'queued',stage:'Подключите Groq в настройках',error:null});
    else{counters.workFailed++;await update(job,{status:'failed',stage:'Не удалось обработать',error:errorText(e)})}
  }
}
async function pump(){
  if(workerBusy)return;
  workerBusy=true;
  try{
    while(!stopping){
      const next=[...jobs.values()].find(j=>j.status==='queued');
      if(!next)break;
      if(next.purgeRequested){await purge(next);continue}
      if(!config.groq){await update(next,{stage:'Подключите Groq в настройках',error:null});break}
      await doWork(next);
      if(next.purgeRequested)await purge(next);
      else if(next.status==='completed')await cleanupAudio(next);
    }
  }finally{workerBusy=false}
}
async function upload(req,res,url){
  if(stopping){fail(res,503,'Сервер завершает работу');return}
  if(!config.groq){fail(res,503,'Groq не настроен. Укажите GROQ_API_KEY на сервере.');return}
  const clientKey=req.headers['x-client-task-key'];
  if(typeof clientKey!=='string'||!/^[a-zA-Z0-9_-]{8,100}$/.test(clientKey)){fail(res,400,'Недопустимый ключ задания');return}
  const previous=[...jobs.values()].find(j=>j.clientKey===clientKey);
  if(previous){json(res,200,{id:previous.id,status:previous.status,reused:true});return}
  if(uploadingKeys.has(clientKey)){fail(res,409,'Файл с этим ключом уже загружается');return}
  if(uploadsInFlight>=MAX_CONCURRENT_UPLOADS){
    counters.uploadRejected++;res.setHeader('Retry-After','5');fail(res,429,'Слишком много одновременных загрузок');return;
  }
  const declared=Number(req.headers['content-length']);
  if(Number.isFinite(declared)&&declared>MAX_BYTES){fail(res,413,'Файл превышает лимит загрузки');return}
  try{
    const fsinfo=await statfs(storage);
    const available=fsinfo.bavail*fsinfo.bsize;
    const declaredLength=Number(req.headers['content-length']);
    if(available<Math.max(MIN_FREE_BYTES,Number.isFinite(declaredLength)&&declaredLength>0?declaredLength+MIN_FREE_BYTES:MIN_FREE_BYTES)){
      fail(res,507,'На сервере недостаточно свободного места для сохранения аудио');return;
    }
  }catch(e){fail(res,503,'Невозможно проверить свободное место на диске');return}
  const profile=url.searchParams.get('profile')||'standard';
  if(!['cautious','standard','enhanced'].includes(profile)){fail(res,400,'Неизвестный профиль');return}
  let prompt;
  try{prompt=decodeURIComponent(String(req.headers['x-transcription-prompt']||''))}
  catch{fail(res,400,'Некорректная кодировка подсказки');return}
  if(prompt.length>350){fail(res,400,'Подсказка слишком длинная (не более 350 символов)');return}
  const type=String(req.headers['content-type']||'');
  const ext=type.includes('ogg')?'ogg':/mp4|m4a|aac/.test(type)?'m4a':type.includes('mpeg')?'mp3':type.includes('wav')?'wav':type.includes('flac')?'flac':'webm';
  const id=randomUUID(),filename=path.join(folders.audio,`${id}.${ext}`),tmp=filename+'.part';
  let received=0,saved=false;
  uploadingKeys.add(clientKey);uploadsInFlight++;
  try{
    const guard=new Transform({
      transform(chunk,enc,callback){
        received+=chunk.length;
        callback(received>MAX_BYTES?new Error('Файл превышает допустимый размер'):null,chunk);
      }
    });
    await pipeline(req,guard,createWriteStream(tmp,{flags:'wx'}));
    if(received<100){throw new Error('Пустой или слишком маленький файл')}
    await rename(tmp,filename);
    const job={id,clientKey,createdAt:new Date().toISOString(),updatedAt:new Date().toISOString(),
      profile,prompt,audioPath:filename,status:'queued',stage:'Ожидает обработки',completed:0,total:0,attempts:0,
      estimatedUSD:0,received,resultReady:false,cancelRequested:false,error:null};
    jobs.set(id,job);await save(job);saved=true;json(res,202,{id,status:'queued'});void pump();
  }catch(e){
    await unlink(tmp).catch(()=>{});
    if(!saved){jobs.delete(id);await unlink(filename).catch(()=>{})}
    if(!res.headersSent)fail(res,received>MAX_BYTES?413:400,errorText(e));
  }finally{uploadingKeys.delete(clientKey);uploadsInFlight--}
}
async function submitLibraryJob(record,source,options){
  const reject=code=>{const e=new Error(code);e.code=code;throw e};
  if(stopping)reject('SERVER_STOPPING');if(!config.groq)reject('KEY_NOT_CONFIGURED');
  if(['recording','importing','damaged'].includes(record.status))reject('INVALID_SOURCE');
  const {clientKey,profile='standard',prompt='',preparedVersionId=null}=options;
  if(typeof clientKey!=='string'||!/^[a-zA-Z0-9_-]{8,100}$/.test(clientKey)||!['cautious','standard','enhanced'].includes(profile)||typeof prompt!=='string'||prompt.length>350)reject('INVALID_JOB');
  const previous=[...jobs.values()].find(j=>j.clientKey===clientKey);
  if(previous){if(previous.recordId!==record.id||previous.profile!==profile||previous.prompt!==prompt||(previous.preparedVersionId||null)!==preparedVersionId)reject('VERSION_CONFLICT');return {id:previous.id,status:previous.status,reused:true}}
  if(uploadingKeys.has(clientKey))reject('LIBRARY_BUSY');
  if(uploadsInFlight>=MAX_CONCURRENT_UPLOADS)reject('LIBRARY_BUSY');
  uploadingKeys.add(clientKey);uploadsInFlight++;
  const id=randomUUID();let ownedSource=null,saved=false;
  try{
    const completeHash=createHash('sha256');for(const file of source.files){const hash=createHash('sha256');for await(const part of createReadStream(file.path)){hash.update(part);completeHash.update(part)}if(hash.digest('hex')!==file.sha256)reject('AUDIO_DAMAGED')}
    let audioPath=source.files[0].path;
    if(source.files.length>1){
      // MediaRecorder WebM packets form one container when joined. Independent
      // PCM/WAV tracks are prepared by the native audio preparation pipeline.
      if(!source.mime.startsWith('audio/webm')&&!source.mime.startsWith('audio/ogg'))reject('PREPARATION_REQUIRED');
      const space=await statfs(storage);if(Number(space.bavail)*Number(space.bsize)<source.size+MIN_FREE_BYTES)reject('DISK_FULL');
      ownedSource=path.join(folders.audio,id+'.webm');const temp=ownedSource+'.part';
      async function* pieces(){for(const file of source.files)yield* createReadStream(file.path)}
      try{await pipeline(Readable.from(pieces()),createWriteStream(temp,{flags:'wx'}));await rename(temp,ownedSource)}catch(e){await unlink(temp).catch(()=>{});throw e}
      audioPath=ownedSource;
    }
    const format=JSON.parse(await run('ffprobe',['-v','error','-select_streams','a:0','-show_entries','stream=sample_rate,channels','-of','json',audioPath])).streams?.[0];
    const bytesPerSecond=Number(format?.sample_rate)*Number(format?.channels)*4;
    if(!Number.isFinite(bytesPerSecond)||bytesPerSecond<=0)reject('INVALID_SOURCE');
    // Bound even incompressible multichannel FLAC below the 24 MiB request cap.
    const segmentSeconds=Math.min(240,Math.floor(20*1024**2/bytesPerSecond)-2);
    if(segmentSeconds<=.8)reject('INVALID_SOURCE');
    const job={id,clientKey,recordId:record.id,sourceVersion:record.version,preparedVersionId,selectionPipeline:'local-selected-1',selectedProfile:preparedVersionId?source.profile:'original',audioSha256:completeHash.digest('hex'),segmentSeconds,createdAt:new Date().toISOString(),updatedAt:new Date().toISOString(),profile,prompt,audioPath,status:'queued',stage:'Ожидает обработки',completed:0,total:0,attempts:0,estimatedUSD:0,received:source.size,resultReady:false,cancelRequested:false,error:null};
    jobs.set(id,job);await save(job);saved=true;void pump();return {id,status:'queued'};
  }finally{if(!saved){jobs.delete(id);if(ownedSource)await unlink(ownedSource).catch(()=>{})}uploadingKeys.delete(clientKey);uploadsInFlight--}
}
// Chat API base follows the transcription endpoint (tests point both at a local fake).
const summarizer=new Summarizer({getKey:()=>keyManager.getKey(),base:process.env.MONO_GROQ_CHAT_BASE||GROQ_ENDPOINT.replace(/\/audio\/transcriptions\/?$/,'')});
async function route(req,res){
  let url;
  try{url=new URL(req.url,'http://local.invalid')}catch{fail(res,400,'Неверный URL');return}
  if(!acceptableOrigin(req)){fail(res,403,'Запрос отклонён: неверный Origin/Host');return}
  // Global recording hotkey (launcher → window). Token is per launch and never leaves the machine.
  if(url.pathname==='/api/launcher/hotkey'&&req.method==='POST'){
    const token=process.env.MONO_LAUNCHER_TOKEN||'',given=String(req.headers['x-mono-launcher-token']||'');req.resume();
    if(!token||Buffer.byteLength(given)!==Buffer.byteLength(token)||!timingSafeEqual(Buffer.from(given),Buffer.from(token))){res.writeHead(403).end();return}
    broadcast('hotkey',{action:'toggle-recording'});res.writeHead(204).end();return;
  }
  // Browser mode: the launcher keeps MONO running while a page is open (each page holds one event stream).
  if(url.pathname==='/api/launcher/clients'&&req.method==='GET'){
    const token=process.env.MONO_LAUNCHER_TOKEN||'',given=String(req.headers['x-mono-launcher-token']||'');
    if(!token||Buffer.byteLength(given)!==Buffer.byteLength(token)||!timingSafeEqual(Buffer.from(given),Buffer.from(token))){res.writeHead(403).end();return}
    res.writeHead(200,{'Content-Type':'application/json','Cache-Control':'no-store'}).end(JSON.stringify({pages:eventClients.size,busy:activeControllers.size+saving.size}));return; // busy: transcriptions in flight, results being saved
  }
  if(url.pathname==='/api/local/events'&&req.method==='GET'){
    const denied=authorizeLocalRequest(req);if(denied){fail(res,denied,'Доступ отклонён');return}
    if(eventClients.size>=16){fail(res,429,'Слишком много окон');return}
    res.writeHead(200,{'Content-Type':'text/event-stream','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});res.write(': ok\n\n');
    eventClients.add(res);const ping=setInterval(()=>res.write(': ping\n\n'),25000);req.on('close',()=>{clearInterval(ping);eventClients.delete(res)});return;
  }
  if(await localRoute(req,res,url,DEPLOY_MODE,{version:VERSION,runtime:async()=>{await toolsReady;if(!config.ffmpeg||!config.ffprobe)await detectTools({force:true});return {ffmpeg:config.ffmpeg,ffprobe:config.ffprobe}},preparation,keyManager,summarizer,journal,diagnostics:()=>collectDiagnostics({worker:localWorker,keyManager,journal,groqBase:process.env.MONO_GROQ_CHAT_BASE||GROQ_ENDPOINT.replace(/\/audio\/transcriptions\/?$/,''),health:publicHealth,jobs:()=>[...jobs.values()],
    runtime:async()=>{await toolsReady;return {ffmpeg:config.ffmpeg,ffprobe:config.ffprobe}},toolVersion:async()=>config.ffmpeg?(await run('ffmpeg',['-version'],5000)).split('\n')[0].slice(0,80):null}),resolveOriginal:(id,options)=>originalMedia.ensure(id,options),resolveSpeakers:async id=>{await toolsReady;return config.ffmpeg?originalMedia.speakers(id):null},submitLibraryJob,isLibraryBusy:()=>uploadsInFlight>0||[...jobs.values()].some(job=>['queued','processing'].includes(job.status))}))return;
  let pathname;
  try{pathname=decodeURIComponent(url.pathname)}catch{fail(res,400,'Некорректное кодирование URL');return}
  if(DEPLOY_MODE==='local'&&(/^\/api\/jobs(?:\/|$)/.test(pathname)||pathname==='/api/metrics')){
    const denied=authorizeLocalRequest(req);if(denied){req.resume();fail(res,denied,'Доступ отклонён');return}
  }
  if(pathname.startsWith('/api/')){
    if(req.method==='GET'&&pathname==='/api/health'){
      // ?wait=tools: answer only after FFmpeg/FFprobe detection (re-run if missing).
      if(url.searchParams.get('wait')==='tools'){await toolsReady;if(!config.ffmpeg||!config.ffprobe)await detectTools({force:true})}
      json(res,200,publicHealth());return;
    }
    if(req.method==='GET'&&pathname==='/api/ready'){
      await toolsReady;
      const ready=config.ffmpeg&&config.ffprobe&&config.groq&&!stopping;
      json(res,ready?200:503,{ready,...publicHealth()});return;
    }
    if(req.method==='GET'&&pathname==='/api/metrics'){
      json(res,200,{...counters,uptimeSeconds:Math.floor((Date.now()-startedAt)/1000),pending:publicHealth().queue,processing:publicHealth().processing});return;
    }
    if(req.method==='POST'&&pathname==='/api/jobs'){await upload(req,res,url);return}
    const byKey=pathname.match(/^\/api\/jobs\/by-key\/([a-zA-Z0-9_-]{8,100})$/);
    if(req.method==='GET'&&byKey){
      const job=[...jobs.values()].find(j=>j.clientKey===byKey[1]);
      if(!job){fail(res,404,'Задание по ключу не найдено');return}
      json(res,200,{id:job.id,status:job.status});return;
    }
    const match=pathname.match(/^\/api\/jobs\/([a-f0-9-]{36})(\/result|\/retry|\/cancel|\/ack)?$/);
    if(match){
      const job=jobs.get(match[1]);if(!job){fail(res,404,'Задание не найдено');return}
      if(req.method==='DELETE'&&!match[2]){
        if(job.status==='processing'){
          await update(job,{cancelRequested:true,purgeRequested:true,stage:'Удаление запрошено'});
          activeControllers.get(job.id)?.abort();
          activeChildren.get(job.id)?.kill('SIGKILL');
          json(res,202,{status:'deleting'});return;
        }
        await purge(job);json(res,200,{status:'deleted'});return;
      }
      if(req.method==='GET'&&!match[2]){
        const {audioPath,clientKey,prompt,contextTail,rateWait,plans,...safe}=job;json(res,200,safe);return;
      }
      if(req.method==='POST'&&match[2]==='/ack'){
        if(job.status!=='completed'){fail(res,409,'Нельзя подтвердить незавершённое задание');return}
        await purge(job);json(res,200,{status:'acknowledged'});return;
      }
      if(req.method==='GET'&&match[2]==='/result'){
        if(job.status!=='completed'){fail(res,409,'Результат пока недоступен');return}
        const text=await readFile(path.join(folders.jobs,job.id+'.result.json'));res.writeHead(200,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(text);return;
      }
      if(req.method==='POST'&&match[2]==='/cancel'){
        if(!['queued','processing'].includes(job.status)){fail(res,409,'Задание уже завершено');return}
        await update(job,{cancelRequested:true,stage:'Запрошена отмена'});
        activeControllers.get(job.id)?.abort();
        activeChildren.get(job.id)?.kill('SIGKILL');
        if(job.status==='queued')await update(job,{status:'cancelled',stage:'Отменено'});
        json(res,200,{status:job.status});return;
      }
      if(req.method==='POST'&&match[2]==='/retry'){
        if(!['failed','cancelled'].includes(job.status)){fail(res,409,'Повтор возможен только после ошибки/отмены');return}
        await update(job,{status:'queued',cancelRequested:false,error:null,stage:'Возобновление'});
        json(res,202,{status:'queued'});void pump();return;
      }
    }
    fail(res,404,'Маршрут API не найден');return;
  }
  if(req.method!=='GET'&&req.method!=='HEAD'){fail(res,405,'Метод не разрешён');return}
  let file=pathname==='/'?'index.html':pathname.replace(/^\/+/,'');
  if(!/\.[a-zA-Z0-9]+$/.test(file))file='index.html'; // SPA navigation
  const full=path.resolve(pub,file);
  if(!full.startsWith(pub+path.sep)){fail(res,403,'Запрещено');return}
  try {
    const f=await stat(full);
    if(!f.isFile()){fail(res,404,'Файл не найден');return}
    res.writeHead(200,{'Content-Type':knownTypes[path.extname(full)]||'application/octet-stream',
      'Cache-Control':/\.(?:html|m?js|css)$/.test(file)?'no-cache':'public, max-age=3600',
      'X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer',
      'Content-Security-Policy':"default-src 'self'; img-src 'self' blob: data:; media-src 'self' blob:; connect-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'"});
    if(req.method==='HEAD')return res.end();
    const stream=createReadStream(full);
    stream.on('error',()=>{if(!res.headersSent)fail(res,500,'Не удалось прочитать ресурс');else res.destroy()});
    stream.pipe(res);
  }catch{fail(res,404,'Файл не найден')}
}
async function main(){
  startupPhase('directories.begin');
  for(const folder of Object.values(folders))await mkdir(folder,{recursive:true});
  startupPhase('directories.end');
  if(DEPLOY_MODE==='local'){startupPhase('worker.begin');await localWorker.start().catch(()=>{});startupPhase('worker.end');startupPhase('vault.begin');await keyManager.status();startupPhase('vault.end')}
  startupPhase('recovery.begin');
  for(const file of await readdir(folders.jobs)){
    if(!file.endsWith('.json')||file.endsWith('.result.json'))continue;
    try{
      const j=JSON.parse(await readFile(path.join(folders.jobs,file)));
      if(['processing','queued'].includes(j.status))j.status='queued';
      if(j.status==='queued'&&!existsSync(j.audioPath))j.status='failed',j.error='Аудиофайл не найден';
      jobs.set(j.id,j);
      if(j.purgeRequested){await purge(j)}
      else if(j.status==='completed')await cleanupAudio(j)
    }catch(e){console.warn(JSON.stringify({event:'job_recovery_error',file:path.basename(file),message:errorText(e)}))}
  }
  await reapExpiredJobs();
  startupPhase('recovery.end');
  const reaper=setInterval(()=>{reapExpiredJobs().catch(e=>console.error(JSON.stringify({event:'reaper_error',message:errorText(e)})))},3600000);
  reaper.unref();
  const server=http.createServer((req,res)=>{
    counters.requests++;
    const start=performance.now();
    res.on('finish',()=>{
      if(res.statusCode>=500)counters.errors++;
      // No raw URLs: job IDs, transcript prompts and credentials never enter logs.
      if(req.url?.startsWith('/api/'))console.log(JSON.stringify({
        event:'http',method:req.method,route:req.url.startsWith('/api/jobs')?'/api/jobs/*':req.url.split('?')[0],
        status:res.statusCode,ms:Math.round(performance.now()-start)
      }));
    });
    route(req,res).catch(e=>{
      console.error(JSON.stringify({event:'request_error',message:errorText(e)}));
      if(!res.headersSent)fail(res,500,'Внутренняя ошибка сервера');else res.destroy();
    });
  });
  // Local imports may be tens of GiB on slow disks; remote uploads stay bounded.
  server.requestTimeout=DEPLOY_MODE==='local'?6*3600*1000:15*60*1000;
  server.headersTimeout=20000;
  server.keepAliveTimeout=5000;
  server.maxConnections=64;
  const shutdown=async(signal)=>{
    if(stopping)return;stopping=true;
    const coreStopped=Promise.allSettled([preparation.close().then(()=>originalMedia.close()).then(()=>originalMedia.queue.close()).then(()=>localWorker.close())]);
    console.log(JSON.stringify({event:'shutdown',signal}));
    activeControllers.forEach(controller=>controller.abort());
    activeChildren.forEach(child=>child.kill('SIGTERM'));
    clearInterval(reaper);
    const timeout=setTimeout(()=>{console.error('Завершение по тайм-ауту');process.exit(1)},20000);
    timeout.unref();
    for(const client of eventClients)client.end();eventClients.clear();
    await new Promise(resolve=>server.close(resolve));
    await Promise.allSettled([...saving.values()]);
    const [coreResult]=await coreStopped;
    if(coreResult.status==='rejected')console.error(JSON.stringify({event:'core_shutdown_error',message:'Локальное ядро не подтвердило завершение'}));
    clearTimeout(timeout);
    process.exit(signal==='listen_error'||coreResult.status==='rejected'?1:0);
  };
  process.on('SIGTERM',()=>{void shutdown('SIGTERM')});
  process.on('SIGINT',()=>{void shutdown('SIGINT')});
  // Launcher supervises backend through a pipe. Orphan processes must not retain
  // port 4173 after the parent crashes; do not enable for regular server mode.
  if(process.env.MONO_LAUNCHER==='1'){
    process.stdin.resume();
    process.stdin.on('end',()=>{void shutdown('launcher_pipe_closed')});
  }
  server.on('error',e=>{console.error(JSON.stringify({event:'listen_error',code:e.code}));process.exitCode=1;void shutdown('listen_error')});
  server.listen(PORT,HOST,()=>{
    startupPhase('listening');
    console.log(JSON.stringify({event:'listening',host:HOST,port:server.address().port,pid:process.pid}));
    void toolsReady.then(()=>console.log(`Groq: ${config.groq?'configured':'not configured'}; FFmpeg: ${config.ffmpeg&&config.ffprobe?'ready':'unavailable ('+TOOLS.ffmpeg+')'}`));
    void pump();
  });
}
main().catch(e=>{console.error(e);process.exitCode=1});
