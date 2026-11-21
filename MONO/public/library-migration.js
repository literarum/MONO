import {LibraryClient,LibraryError} from './library-client.js';
const NAME='mono-transcribe-v1';
const request=req=>new Promise((resolve,reject)=>{req.onsuccess=()=>resolve(req.result);req.onerror=()=>reject(req.error)});
async function legacyConnection(){
 if(!globalThis.indexedDB)throw new Error('Хранилище этого браузера недоступно. Откройте прежний профиль и экспортируйте библиотеку.');
 if(indexedDB.databases&&!(await indexedDB.databases()).some(db=>db.name===NAME))return null;
 return new Promise((resolve,reject)=>{
  const open=indexedDB.open(NAME);let absent=false,created;
  open.onupgradeneeded=()=>{absent=true;created=open.result;open.transaction.abort()};
  open.onerror=()=>{created?.close();absent?resolve(null):reject(open.error)};
  open.onsuccess=()=>{
   const db=open.result;
   if(db.version!==1||!['recordings','files','chunks'].every(name=>db.objectStoreNames.contains(name))){db.close();reject(new Error('Версия браузерной библиотеки не поддерживается. Экспортируйте её из прежней версии MONO.'));return}
   db.onversionchange=()=>db.close();resolve(db);
  };
 });
}
const get=(db,store,key)=>request(db.transaction(store,'readonly').objectStore(store).get(key));
async function nextRecord(db,after){const cursor=await request(db.transaction('recordings','readonly').objectStore('recordings').openCursor(after===undefined?undefined:IDBKeyRange.lowerBound(after,true)));return cursor?{key:cursor.key,record:cursor.value}:null}
/** True when the old in-browser library (before the desktop archive) has records. */
export async function hasLegacyRecords(){
 try{for await(const item of scanLegacyDB())return Boolean(item);return false}catch{return false}
}
export async function* scanLegacyDB(){
 const db=await legacyConnection();if(!db)return;
 try{
  let key;
  while(true){
   const item=await nextRecord(db,key);if(!item)break;key=item.key;const record=item.record;
   if(record.status==='recording'){yield {record,active:true};continue}
   const saved=await get(db,'files',record.id),parts=saved?.blob?1:Number(record.chunkCount);
   if(!Number.isSafeInteger(parts)||parts<1||parts>200000)throw new Error(`В записи «${record.title}» нет полного аудио. Исходные данные сохранены.`);
   yield {record,expectedParts:parts,size:saved?.blob?.size??record.size,
    async *audio(){
     for(let index=0;index<parts;index++){const blob=saved?.blob||(await get(db,'chunks',[record.id,index]))?.blob;if(!(blob instanceof Blob)||!blob.size)throw new Error(`Не найден аудиофрагмент ${index+1} записи «${record.title}».`);yield {index,blob}}
    },unchanged:async()=>JSON.stringify(await get(db,'recordings',record.id))===JSON.stringify(record)};
  }
 }finally{db.close()}
}
const sha=async text=>[...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(text)))].map(n=>n.toString(16).padStart(2,'0')).join('');
function sourceIdentity(){let value=localStorage.getItem('mono-legacy-source');if(!/^[a-f0-9-]{36}$/.test(value||'')){value=crypto.randomUUID();localStorage.setItem('mono-legacy-source',value)}return value}
export async function migrateLegacy({onProgress=()=>{},signal}={}){
 const client=new LibraryClient();const status=await client.init();if(!status.libraryConfigured||!status.libraryAvailable)throw new Error('Сначала подключите папку для записей.');
 const sourceId=sourceIdentity(),summary={copied:0,verified:0,skipped:0};
 const cancelled=()=>{if(signal?.aborted)throw new DOMException('Перенос отменён. Исходные записи в браузере сохранены.','AbortError')};
 try{
  for await(const item of scanLegacyDB()){
   cancelled();if(item.active){summary.skipped++;continue}
   const r=item.record,keys=['id','title','createdAt','duration','mime','source','status','estimatedUSD','completedAt','chunkCount','peaks','gapMarkers'];
   const meta=Object.fromEntries(keys.filter(k=>r[k]!==undefined).map(k=>[k,r[k]]));meta.size=item.size;meta.mime||='audio/webm';
   const text=r.transcript?JSON.stringify(r.transcript):null;
   const begun=await client.json('/migration/begin',{method:'POST',body:{sourceId,meta,expectedParts:item.expectedParts,transcriptHash:text?await sha(text):null},signal});
   let uploaded=0,lastUpdate=0;onProgress({...summary,title:r.title,bytes:0,totalBytes:item.size});
   for await(const part of item.audio()){
    cancelled();await client.json(`/migration/${r.id}/parts/${part.index}`,{method:'PUT',body:part.blob,signal});uploaded+=part.blob.size;
    if(Date.now()-lastUpdate>=300){lastUpdate=Date.now();onProgress({...summary,title:r.title,bytes:uploaded,totalBytes:item.size})}
   }
   if(!await item.unchanged())throw new LibraryError('SOURCE_CHANGED','Запись изменилась во время переноса. Закройте её в прежнем окне и повторите перенос. Исходные данные сохранены.');
   cancelled();if(text)await client.json(`/migration/${r.id}/transcript`,{method:'PUT',headers:{'Content-Type':'application/json'},body:text,signal});
   await client.json(`/migration/${r.id}/finish`,{method:'POST',body:{},signal});
   if(begun.complete)summary.verified++;else summary.copied++;
  }return summary;
 }catch(error){error.migrationSummary={...summary};throw error}
}
