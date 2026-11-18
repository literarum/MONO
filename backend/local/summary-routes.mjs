// POST /api/local/records/:id/summary  → starts a summary (202), the transcript text goes to Groq
// GET  /api/local/records/:id/summary  → progress {status,stage,done,total,error}
// DELETE                               → cancels
// The result is written into the record (`summary`), so it survives restarts and backups.
import {readFile} from 'node:fs/promises';
import {readJSON} from './library-routes.mjs';
import {Summarizer} from '../groq/summary.mjs';
import {speakerFor} from '../../public/speakers.js';

const send=(res,status,body)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});res.end(JSON.stringify(body))};
const tasks=new Map();
const view=task=>task?{status:task.status,stage:task.stage,done:task.done,total:task.total,error:task.error,code:task.code}:{status:'idle'};

async function transcriptOf(worker,id){
 const segments=[];
 for(let offset=0;offset!==null&&segments.length<200000;){
  const file=await worker.call('records.transcript.file',{id,offset,limit:100});
  try{const page=JSON.parse(await readFile(file.path,'utf8'));segments.push(...page.segments);offset=page.nextOffset}
  finally{await worker.call('stage.discard',{id:file.id}).catch(()=>{})}
 }
 return segments;
}
async function save(worker,id,summary){
 for(let attempt=0;attempt<4;attempt++){
  const record=await worker.call('records.get',{id});
  try{return await worker.call('records.patch',{id,expectedVersion:record.version,patch:{summary}})}
  catch(error){if(error.code!=='VERSION_CONFLICT'||attempt===3)throw error}
 }
}

export async function summaryRoute(req,res,url,worker,{keyManager,summarizer,speakers}={}){
 const match=url.pathname.match(/^\/api\/local\/records\/([a-f0-9-]{36})\/summary$/);if(!match)return false;
 const id=match[1];
 if(req.method==='GET'){req.resume();send(res,200,view(tasks.get(id)));return true}
 if(req.method==='DELETE'){req.resume();const task=tasks.get(id);task?.controller.abort();send(res,200,view(task));return true}
 if(req.method!=='POST')return false;
 const body=await readJSON(req,1000);
 if(Object.keys(body).some(key=>key!=='consent')||body.consent!==true){send(res,400,{code:'CONSENT_REQUIRED',error:'Нужно согласие на отправку текста в Groq'});return true}
 if(tasks.get(id)?.status==='running'){send(res,202,view(tasks.get(id)));return true}
 const record=await worker.call('records.get',{id});
 if(!record.transcriptSummary?.segmentCount){send(res,409,{code:'NO_TRANSCRIPT',error:'Сначала расшифруйте запись'});return true}
 const status=keyManager?await keyManager.status():{configured:false};
 if(!status.configured){send(res,409,{code:'KEY_NOT_CONFIGURED',error:'Подключите Groq в настройках'});return true}
 const task={status:'running',stage:'Готовим текст',done:0,total:1,error:null,code:null,controller:new AbortController()};tasks.set(id,task);
 send(res,202,view(task));
 void (async()=>{
  try{
   const segments=await transcriptOf(worker,id);let profile=null;
   try{profile=speakers?await speakers(id):null}catch{}
   const who=s=>speakerFor(s,profile)||undefined;
   const engine=summarizer||new Summarizer({getKey:()=>keyManager.getKey()});
   const result=await engine.summarize({segments:segments.map(s=>({start:s.start,text:s.text,speaker:who(s)})),title:record.title,duration:record.duration||Infinity,signal:task.controller.signal,onProgress:p=>Object.assign(task,p)});
   await save(worker,id,{...result,createdAt:new Date().toISOString(),sourceSegments:segments.length});
   Object.assign(task,{status:'done',stage:'Готово',done:task.total});
  }catch(error){Object.assign(task,{status:error.code==='CANCELLED'||task.controller.signal.aborted?'cancelled':'failed',error:error.code==='CANCELLED'?null:error.message||'Не удалось составить конспект',code:error.code||'SUMMARY_FAILED'})}
  setTimeout(()=>{if(tasks.get(id)===task&&task.status!=='running')tasks.delete(id)},10*60e3).unref?.();
 })();
 return true;
}
