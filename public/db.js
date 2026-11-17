import * as legacy from './legacy-db.js';
import {LibraryClient,LibraryError} from './library-client.js';
let opening,client,mode;
export async function openDB(){
 if(opening)return opening;
 opening=(async()=>{
  const health=await fetch('/api/health',{cache:'no-store',signal:AbortSignal.timeout(10000)});
  if(!health.ok)throw new Error('Не удалось подключиться к приложению. Перезапустите MONO.');
  mode=(await health.json()).mode;
  if(mode==='local'){client=new LibraryClient();await client.init();return client}
  if(mode==='proxy')return legacy.openDB();
  throw new Error('Приложение не сообщило режим хранения. Перезапустите MONO.');
 })().catch(error=>{opening=null;throw error});return opening;
}
export const storageDetails=()=>({mode,local:mode==='local',...client?.status});
export async function localLibraryClient(){await openDB();return client||null}
export async function configureLibrary(options){await openDB();if(!client)throw new Error('Локальный архив недоступен в этом режиме');return client.configure(options)}
export async function chooseLibraryFolder(purpose='create',{signal}={}){
 await openDB();let choice=await client.json('/library/choose',{method:'POST',body:{purpose}});
 while(choice.pending){
  if(signal?.aborted){await client.json('/library/choice/cancel',{method:'POST',body:{id:choice.id}});return {cancelled:true}}
  await new Promise(resolve=>setTimeout(resolve,300));choice=await client.json('/library/choice',{method:'POST',body:{id:choice.id}});
 }return signal?.aborted?{cancelled:true}:choice;
}
const fields=['title','duration','mime','source','status','transcript','jobId','job','clientKey','serverAcked','completedAt','estimatedUSD','transcriptionStartedAt','importKey','gapMarkers','chunkCount','lastChunkAt','peaks'];
const patchOf=value=>Object.fromEntries(fields.filter(k=>k in value).map(k=>[k,value[k]]));
export async function listRecordings(query='',{trash=false}={}){
 await openDB();if(!client)return legacy.listRecordings();if(!client.status.libraryConfigured)return [];
 const items=[];let cursor=null;do{const page=await client.list({cursor,query,trash});items.push(...page.items);cursor=page.nextCursor}while(cursor);return items;
}
export async function getRecording(id,options={transcript:true}){await openDB();return client?client.get(id,options):legacy.getRecording(id)}
export async function putRecording(value){
 await openDB();if(!client)return legacy.putRecording(value);
 let exists=true;try{await client.current(value.id)}catch(error){if(error.code!=='NOT_FOUND')throw error;exists=false}
 if(!exists)await client.create({id:value.id,title:value.title,createdAt:value.createdAt,mime:value.mime,source:value.source,status:value.status});
 return client.patch(value.id,patchOf(value));
}
export async function patchRecording(id,patch){await openDB();return client?client.patch(id,patch):legacy.patchRecording(id,patch)}
export async function addChunk(id,index,blob){await openDB();if(!client)return legacy.addChunk(id,index,blob);await client.segment(id,index,blob);const record=await client.current(id);await client.patch(id,{chunkCount:index+1,lastChunkAt:Date.now()});return record.size}
export async function saveImportedRecording(record,file){await openDB();if(!client)return legacy.saveImportedRecording(record,file);const result=await client.import(record,file);if(record.transcript)await client.patch(result.id,{transcript:record.transcript,status:record.status});return result}
export async function getBlob(record){await openDB();if(client)throw new LibraryError('STREAM_REQUIRED','Локальное аудио воспроизводится и экспортируется потоком.');return legacy.getBlob(record)}
export const audioURL=(record,variant='original')=>client?client.audioURL(typeof record==='string'?record:record.id,variant):null;
export async function streamRecordingAudio(record,writer){await openDB();return client?client.streamAudio(record.id,writer):legacy.streamRecordingAudio(record,writer)}
export async function removeRecording(id){await openDB();return client?client.trash(id):legacy.removeRecording(id)}
export async function restoreRecording(id,version){await openDB();if(!client)throw new Error('Корзина недоступна');return client.restore(id,version)}
export async function transcriptPage(id,options){await openDB();return client?client.transcript(id,options):null}
export async function submitLocalTranscription(id,options){await openDB();return client.submit(id,options)}
export async function startLibraryTransfer(kind,choiceId){await openDB();return client.json('/library/transfer',{method:'POST',body:{kind,choiceId}})}
export async function libraryTransferStatus(id){await openDB();return client.json('/library/transfer/status',{method:'POST',body:{id}})}
export async function cancelLibraryTransfer(id){await openDB();return client.json('/library/transfer/cancel',{method:'POST',body:{id}})}
export async function resumeLibraryTransfer(id){await openDB();return client.json('/library/transfer/resume',{method:'POST',body:{id}})}
export async function recoverLibraryTransfer(){await openDB();return client.json('/library/transfer/recover',{method:'POST',body:{}})}
export async function refreshStorageStatus(){await openDB();if(client){client.status=await client.json('/status');client.records.clear()}return storageDetails()}
export async function saveSegmentEdit(id,index,text){await openDB();if(client)return client.edit(id,index,text);const r=await legacy.getRecording(id);if(!r?.transcript?.segments[index])throw new Error('Фрагмент не найден');r.transcript.segments[index].text=text;return legacy.putRecording(r)}
