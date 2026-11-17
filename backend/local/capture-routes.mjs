import {readJSON,receive} from './library-routes.mjs';
import {validCaptureDiagnostic} from '../../public/capture-diagnostic.js';
const send=(res,status,body)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});res.end(JSON.stringify(body))};
export async function captureRoute(req,res,url,worker){
 if(!url.pathname.startsWith('/api/local/capture/'))return false;
 const operation=url.pathname.slice('/api/local/capture/'.length),read=['capabilities','devices','status','check_access'].includes(operation),write=['start','test','discard_test','pause','resume','stop','browser_start','browser_heartbeat','browser_pause','browser_resume','browser_finish','browser_abort'].includes(operation);
 if(operation==='browser_diagnostic'&&req.method==='POST'){
  let value;try{value=await readJSON(req,1024)}catch{send(res,400,{code:'INVALID_CAPTURE_DIAGNOSTIC',error:'Проверьте диагностические данные'});return true}
  if(!validCaptureDiagnostic(value)){send(res,400,{code:'INVALID_CAPTURE_DIAGNOSTIC',error:'Проверьте диагностические данные'});return true}
  console.warn(JSON.stringify({event:'browser_capture_failure',operation:value.operation,stage:value.stage,code:value.code,errorName:value.errorName}));send(res,200,{received:true});return true;
 }
 if(operation==='browser_segment'&&req.method==='PUT'){
  const sessionId=req.headers['x-mono-session'],index=req.headers['x-mono-index'];
  if(typeof sessionId!=='string'||!/^[a-f0-9-]{36}$/.test(sessionId)||typeof index!=='string'||!/^\d{1,6}$/.test(index)){send(res,400,{error:'Проверьте параметры аудиофрагмента',code:'INVALID_CAPTURE'});return true}
  let uploaded;
  try{await worker.call('capture.browser_heartbeat',{sessionId});uploaded=await receive(req,worker,1024*1024);send(res,200,await worker.call('capture.browser_segment',{sessionId,index:Number(index),...uploaded}))}
  catch(error){send(res,error.code?.startsWith('INVALID')?400:error.code==='SEGMENT_CONFLICT'?409:503,{error:'Не удалось сохранить аудиофрагмент',code:error.code||'CAPTURE_UNAVAILABLE'})}
  finally{if(uploaded)await worker.call('stage.discard',{id:uploaded.stagingId}).catch(()=>{})}
  return true;
 }
 if(!(read&&req.method==='GET'||write&&req.method==='POST')){send(res,404,{error:'Операция не найдена'});return true}
 try{
  const params=write?await readJSON(req):{};
  if(operation.startsWith('browser_')){
   const fields=operation==='browser_start'?['sampleRate','inputId','test']:['browser_pause','browser_resume','browser_finish'].includes(operation)?['sessionId','frames']:['sessionId'];
   if(Object.keys(params).some(key=>!fields.includes(key))){send(res,400,{error:'Проверьте параметры записи',code:'INVALID_CAPTURE'});return true}
  }
  if(['start','test'].includes(operation)&&Object.keys(params).some(key=>!['mode','inputId','outputId'].includes(key))){send(res,400,{error:'Проверьте параметры записи',code:'INVALID_CAPTURE'});return true}
  send(res,['start','test','browser_start'].includes(operation)?202:200,await worker.call('capture.'+operation,params));
 }catch(error){send(res,['CAPTURE_BUSY','LIBRARY_BUSY','DEVICE_LOST'].includes(error.code)?409:error.code?.startsWith('INVALID')?400:503,{error:'Не удалось выполнить операцию со звуком',code:error.code||'CAPTURE_UNAVAILABLE'})}
 return true;
}
