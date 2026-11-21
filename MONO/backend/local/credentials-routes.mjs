import {readJSON} from './library-routes.mjs';
const send=(res,status,body)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});res.end(JSON.stringify(body))};
export async function credentialsRoute(req,res,url,manager){
 if(!url.pathname.startsWith('/api/local/credentials/'))return false;
 const operation=url.pathname.slice('/api/local/credentials/'.length);
 if(!(operation==='status'&&req.method==='GET'||['configure','delete'].includes(operation)&&req.method==='POST')){send(res,404,{error:'Операция не найдена'});return true}
 if(!manager){send(res,503,{error:'Подключение временно недоступно',code:'KEY_UNAVAILABLE'});return true}
 const controller=new AbortController();const closed=()=>{if(!res.writableEnded)controller.abort()};res.on('close',closed);
 try{
  if(operation==='status'){send(res,200,await manager.status());return true}
  const body=await readJSON(req,2048);
  if(operation==='configure'){
   if(Object.keys(body).some(key=>key!=='key')||typeof body.key!=='string'){send(res,400,{error:'Проверьте ключ Groq',code:'INVALID_KEY'});return true}
   const key=body.key;delete body.key;send(res,200,await manager.configure(key,{signal:controller.signal}));
  }else{if(Object.keys(body).length){send(res,400,{error:'Проверьте запрос',code:'INVALID_REQUEST'});return true}send(res,200,await manager.delete())}
 }catch(error){const code=error.code||'KEY_UNAVAILABLE';const status=['KEY_BUSY','KEY_MANAGED'].includes(code)?409:code==='RATE_LIMITED'?429:['INVALID_KEY','KEY_FORBIDDEN','MODEL_UNAVAILABLE','BILLING_LIMIT','INVALID_JSON'].includes(code)?400:code==='TOO_LARGE'?413:503;if(!res.destroyed)send(res,status,{error:error.message&&error.name==='KeyError'?error.message:'Не удалось подключить Groq',code})}
 finally{res.off('close',closed)}
 return true;
}
