import {summaryRoute} from './summary-routes.mjs';
import {LocalSessions} from './session.mjs';import {WorkerClient} from './worker-client.mjs';
import {libraryRoute,readJSON} from './library-routes.mjs';
import {captureRoute} from './capture-routes.mjs';
import {credentialsRoute} from './credentials-routes.mjs';
import {audioRoute} from './audio-routes.mjs';
import {preflight,BYTES_PER_HOUR} from './preflight.mjs';import {statfs} from 'node:fs/promises';import {microphoneUsers} from './privacy.mjs';
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
  if(url.pathname==='/api/local/preflight'&&req.method==='GET'){send(res,200,await preflight({worker:localWorker,runtime:services.runtime||(()=>({})),keyManager:services.keyManager}));return true}
  if(url.pathname==='/api/local/diagnostics'&&req.method==='GET'&&services.diagnostics){send(res,200,await services.diagnostics());return true}
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
