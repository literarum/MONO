import {summaryRoute} from './summary-routes.mjs';
import {EVENT_CODES,scrub} from './diagnostics.mjs';
import {LocalSessions} from './session.mjs';import {WorkerClient} from './worker-client.mjs';
import {libraryRoute,readJSON} from './library-routes.mjs';
import {captureRoute} from './capture-routes.mjs';
import {credentialsRoute} from './credentials-routes.mjs';
import {audioRoute} from './audio-routes.mjs';
import {preflight,BYTES_PER_HOUR} from './preflight.mjs';import {statfs,readFile,writeFile,rename,mkdir,open as openFile,rm} from 'node:fs/promises';import path from 'node:path';import {stageUpdate,updateStatus} from './update-package.mjs';import {fileURLToPath} from 'node:url';import {microphoneUsers} from './privacy.mjs';
const sessions=new LocalSessions();export const localWorker=new WorkerClient();
export const authorizeLocalRequest=req=>sessions.authorize(req);
const send=(res,status,body)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});res.end(JSON.stringify(body))};
export async function localRoute(req,res,url,mode,services={}){
 if(!url.pathname.startsWith('/api/local/'))return false;
 if(mode!=='local'){send(res,404,{error:'Операция не поддерживается'});return true}
 if(url.pathname==='/api/local/session'&&req.method==='GET'){
  const s=sessions.bootstrap(req,res);send(res,s?200:403,s?{csrf:s.csrf}:{error:'Доступ отклонён'});return true;
 }
 const denied=sessions.authorize(req);if(denied){send(res,denied,{error:'Доступ отклонён'});return true}
 try{
  if(url.pathname==='/api/local/preferences'&&['GET','PATCH'].includes(req.method)){
   try{send(res,200,await localWorker.call(req.method==='GET'?'preferences.get':'preferences.update',req.method==='GET'?{}:await readJSON(req,32000)))}catch(error){send(res,error.code==='CAPTURE_BUSY'?409:error.code==='INVALID_PREFERENCES'?400:503,{error:'Настройки не сохранены',code:error.code||'PREFERENCES_UNAVAILABLE'})}return true;
  }
  if(await credentialsRoute(req,res,url,services.keyManager))return true;
  if(await captureRoute(req,res,url,localWorker))return true;
  if(await audioRoute(req,res,url,services.preparation))return true;
  if(await summaryRoute(req,res,url,localWorker,{keyManager:services.keyManager,summarizer:services.summarizer,speakers:services.resolveSpeakers}))return true;
  if(await libraryRoute(req,res,url,localWorker,services))return true;
  // Offline update from a signed .monoupdate file (see update-package.mjs).
  if(url.pathname==='/api/local/update'&&['GET','POST'].includes(req.method)){
   const home=process.env.MONO_LAUNCHER_HOME,keyFile=process.env.MONO_UPDATE_KEY_FILE||fileURLToPath(new URL('./update-key.pem',import.meta.url));let publicKeyPem=null;try{publicKeyPem=await readFile(keyFile,'utf8')}catch{}
   const current=services.version||null;
   if(req.method==='GET'){send(res,200,{version:current,supported:Boolean(home),signed:Boolean(publicKeyPem),...(home?await updateStatus(home):{pending:null,applied:null})});return true}
   if(!home){req.resume();send(res,409,{code:'NO_LAUNCHER',error:'Обновление из файла доступно в приложении MONO на компьютере'});return true}
   const dir=path.join(home,'updates');await mkdir(dir,{recursive:true});const incoming=path.join(dir,'incoming.part');
   const out=await openFile(incoming,'w');let size=0;
   try{for await(const part of req){size+=part.length;if(size>4*1024**3+64*1024**2){const e=new Error('Файл обновления слишком большой');e.code='TOO_LARGE';throw e}let at=0;while(at<part.length){const {bytesWritten}=await out.write(part,at,part.length-at);at+=bytesWritten}}await out.sync()}finally{await out.close()}
   let reply;
   try{reply=[200,{...await stageUpdate(incoming,{home,publicKeyPem,current}),restartNeeded:true}]}
   catch(error){reply=[error.code==='UPDATE_NOT_NEWER'?409:error.code==='UPDATE_KEY_MISSING'?501:400,{code:error.code||'UPDATE_INVALID',error:error.message}]}
   await rm(incoming,{force:true}); // removed before answering: nothing of the upload outlives the request
   send(res,...reply);return true;
  }
  // Which window MONO opens: its own (Chromium --app, started by MONO) or the person's browser.
  if(url.pathname==='/api/local/window'&&['GET','POST'].includes(req.method)){
   const home=process.env.MONO_LAUNCHER_HOME,file=home?path.join(home,'ui-engine.json'):null;
   const current=async()=>{try{return JSON.parse(await readFile(file,'utf8')).engine||null}catch{return null}};
   if(req.method==='GET'){send(res,200,{launcher:Boolean(file),engine:file?await current():null});return true}
   const body=await readJSON(req,200);if(!file){send(res,409,{code:'NO_LAUNCHER',error:'MONO запущен без лаунчера'});return true}
   if(!['browser','chromium'].includes(body.engine)){send(res,400,{code:'INVALID_ENGINE',error:'Неизвестный режим окна'});return true}
   if(await current()==='native'){send(res,409,{code:'NATIVE_WINDOW',error:'Это окно нельзя сменить на браузер'});return true}
   const temp=file+'.tmp';await writeFile(temp,JSON.stringify({engine:body.engine}),'utf8');await rename(temp,file);
   send(res,200,{launcher:true,engine:body.engine,restartNeeded:true});return true}
  if(url.pathname==='/api/local/preflight'&&req.method==='GET'){send(res,200,await preflight({worker:localWorker,runtime:services.runtime||(()=>({})),keyManager:services.keyManager}));return true}
  if(url.pathname==='/api/local/diagnostics'&&req.method==='GET'&&services.diagnostics){send(res,200,await services.diagnostics());return true}
  if(url.pathname==='/api/local/diagnostics/event'&&req.method==='POST'&&services.journal){
   const body=await readJSON(req,1000);if(!EVENT_CODES.has(body.code)||(body.device!==undefined&&(typeof body.device!=='string'||body.device.length>120))){send(res,400,{code:'INVALID_EVENT',error:'Неизвестное событие'});return true}
   services.journal.note('event',[body.code,body.device&&scrub(body.device).replace(/ · /g,' ')].filter(Boolean).join(' · '));send(res,200,{ok:true});return true}
  if(url.pathname==='/api/local/diagnostics/scrub'&&req.method==='POST'){
   const body=await readJSON(req,1000);if(body.cursor!==undefined&&body.cursor!==null&&(typeof body.cursor!=='string'||!/^[a-f0-9-]{36}$/.test(body.cursor))){send(res,400,{code:'INVALID_SCRUB',error:'Неверный курсор'});return true}
   const result=await localWorker.call('library.scrub',{cursor:body.cursor||null,budgetSeconds:5},{timeoutMs:30000});
   (result.damaged||[]).forEach(()=>services.journal?.note('event','SCRUB_DAMAGED'));
   if(result.complete)services.journal?.note('scrub',`Проверено записей: ${result.checked}, повреждено: ${result.damaged.length}, недоступно: ${result.unreadable.length}`);
   send(res,200,result);return true}
  if(url.pathname==='/api/local/status'&&req.method==='GET'){send(res,200,await localWorker.call('status'));return true}
  if(url.pathname==='/api/local/microphone-users'&&req.method==='GET'){send(res,200,{apps:await microphoneUsers()});return true}
  if(url.pathname==='/api/local/storage'&&req.method==='GET'){
   const status=await localWorker.call('status');if(!status.libraryAvailable){send(res,409,{error:'Папка архива недоступна',code:'LIBRARY_MISSING'});return true}
   const space=await statfs(status.libraryPath);send(res,200,{freeBytes:Number(space.bavail)*Number(space.bsize),bytesPerMinute:BYTES_PER_HOUR/60});return true}
  if(url.pathname==='/api/local/ping'&&req.method==='POST'){req.resume();send(res,200,await localWorker.call('ping'));return true}
  send(res,404,{error:'Операция не найдена'});
 }catch(error){send(res,error.code==='UNKNOWN_METHOD'?400:503,{error:'Локальное ядро недоступно',code:error.code||'CORE_UNAVAILABLE'})}
 return true;
}
