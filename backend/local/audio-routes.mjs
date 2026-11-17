import {readJSON,streamAudio} from './library-routes.mjs';import {publicProfiles} from '../audio/profiles.mjs';
const send=(res,status,body)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});res.end(JSON.stringify(body))};
const status=code=>['NOT_FOUND','TRASHED','AUDIO_NOT_FOUND'].includes(code)?404:['CAPTURE_BUSY','SOURCE_BUSY','LIBRARY_BUSY','PREPARATION_BUSY','PREPARATION_CONFLICT','STALE_AUDIO_VERSION'].includes(code)?409:code?.startsWith('INVALID')?400:503;
export async function audioRoute(req,res,url,preparation){
 const record=url.pathname.match(/^\/api\/local\/records\/([a-f0-9-]{36})\/(prepare|preview|versions\/([a-f0-9]{64})\/audio)$/),job=url.pathname.match(/^\/api\/local\/preparations\/([a-f0-9-]{36})(\/cancel)?$/);
 if(!record&&!job&&url.pathname!=='/api/local/audio/profiles')return false;
 try{
  if(!preparation){send(res,503,{code:'PREPARATION_UNAVAILABLE',error:'Подготовка звука недоступна'});return true}
  if(url.pathname==='/api/local/audio/profiles'&&req.method==='GET'){send(res,200,{profiles:publicProfiles()});return true}
  if(record&&['prepare','preview'].includes(record[2])&&req.method==='POST'){
   const body=await readJSON(req,4000),preview=record[2]==='preview';if(Object.keys(body).some(key=>!(preview?['profile','start','duration','requestId']:['profile','requestId']).includes(key))){send(res,400,{code:'INVALID_PREPARATION',error:'Проверьте параметры подготовки'});return true}
   send(res,202,await preparation.create(record[1],{...body,preview}));return true;
  }
  if(record&&record[3]&&['GET','HEAD'].includes(req.method)){await streamAudio(req,res,await preparation.resolve(record[1],record[3]));return true}
  if(job&&!job[2]&&req.method==='GET'){send(res,200,await preparation.get(job[1]));return true}
  if(job&&job[2]&&req.method==='POST'){const body=await readJSON(req,1000);if(Object.keys(body).length){send(res,400,{code:'INVALID_PREPARATION',error:'Проверьте параметры отмены'});return true}send(res,200,preparation.cancel(job[1]));return true}
  send(res,404,{code:'NOT_FOUND',error:'Операция не найдена'});
 }catch(error){if(res.headersSent)res.destroy();else send(res,status(error.code),{code:error.code||'PREPARATION_FAILED',error:'Не удалось подготовить звук'})}return true;
}
