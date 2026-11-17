const NAME='mono-transcribe-v1';
const VERSION=1;
let connection;
export function openDB(){
  if(connection)return connection;
  connection=new Promise((resolve,reject)=>{
    const req=indexedDB.open(NAME,VERSION);
    req.onupgradeneeded=()=>{
      const db=req.result;
      if(!db.objectStoreNames.contains('recordings'))db.createObjectStore('recordings',{keyPath:'id'});
      if(!db.objectStoreNames.contains('chunks')){
        const chunks=db.createObjectStore('chunks',{keyPath:['recordingId','index']});
        chunks.createIndex('recordingId','recordingId');
      }
      if(!db.objectStoreNames.contains('files'))db.createObjectStore('files',{keyPath:'recordingId'});
    };
    req.onsuccess=()=>{req.result.onversionchange=()=>{req.result.close();connection=null};resolve(req.result)};
    req.onerror=()=>reject(req.error);
    req.onblocked=()=>reject(new Error('База данных занята другой вкладкой'));
  });
  connection=connection.catch(e=>{connection=null;throw e});
  return connection;
}
const request=req=>new Promise((resolve,reject)=>{req.onsuccess=()=>resolve(req.result);req.onerror=()=>reject(req.error)});
async function txPromise(tx){return new Promise((resolve,reject)=>{tx.oncomplete=()=>resolve();tx.onabort=()=>reject(tx.error||new Error('Транзакция отменена'));tx.onerror=()=>reject(tx.error||new Error('Ошибка IndexedDB'))})}
export async function putRecording(value){
  const db=await openDB(),tx=db.transaction('recordings','readwrite'),done=txPromise(tx);
  tx.objectStore('recordings').put(value);await done;
}
export async function getRecording(id){const db=await openDB();return request(db.transaction('recordings').objectStore('recordings').get(id))}
export async function listRecordings(){const db=await openDB();return request(db.transaction('recordings').objectStore('recordings').getAll())}
export async function patchRecording(id,patch){
  const db=await openDB(),tx=db.transaction('recordings','readwrite'),done=txPromise(tx);
  const store=tx.objectStore('recordings'),rec=await request(store.get(id));
  if(!rec){tx.abort();throw new Error('Запись не найдена')}
  Object.assign(rec,patch);
  store.put(rec);await done;return rec;
}
export async function addChunk(recordingId,index,blob){
  const db=await openDB(),tx=db.transaction(['recordings','chunks'],'readwrite'),done=txPromise(tx);
  tx.objectStore('chunks').put({recordingId,index,blob});
  const store=tx.objectStore('recordings'),rec=await request(store.get(recordingId));
  if(!rec){tx.abort();throw new Error('Запись удалена')}
  rec.size=(rec.size||0)+blob.size;
  rec.chunkCount=Math.max(rec.chunkCount||0,index+1);
  rec.lastChunkAt=Date.now();
  store.put(rec);await done;return rec.size;
}
export async function saveImportedRecording(rec,file){
  const db=await openDB(),tx=db.transaction(['recordings','files'],'readwrite'),done=txPromise(tx);
  tx.objectStore('recordings').put(rec);
  tx.objectStore('files').put({recordingId:rec.id,blob:file});
  await done;
}
export async function saveImportedFile(recordingId,file){
  const db=await openDB(),tx=db.transaction('files','readwrite'),done=txPromise(tx);
  tx.objectStore('files').put({recordingId,blob:file});await done;
}
export async function getBlob(rec){
  const db=await openDB();
  const saved=await request(db.transaction('files').objectStore('files').get(rec.id));
  if(saved)return saved.blob;
  const chunks=await request(db.transaction('chunks').objectStore('chunks').index('recordingId').getAll(rec.id));
  if(!chunks.length)throw new Error('Сохранённые аудиоданные не найдены');
  chunks.sort((a,b)=>a.index-b.index);
  if(chunks.some((c,i)=>c.index!==i)||chunks.length!==(rec.chunkCount||chunks.length))
    throw new Error('Некоторые аудиофрагменты отсутствуют. Запись повреждена; экспорт остановлен.');
  return new Blob(chunks.map(c=>c.blob),{type:rec.mime||'audio/webm'});
}
export async function removeRecording(id){
  const db=await openDB(),tx=db.transaction(['recordings','chunks','files'],'readwrite'),done=txPromise(tx);
  tx.objectStore('recordings').delete(id);tx.objectStore('files').delete(id);
  const store=tx.objectStore('chunks'),index=store.index('recordingId');
  const cursor=index.openCursor(IDBKeyRange.only(id));
  cursor.onsuccess=()=>{const c=cursor.result;if(c){c.delete();c.continue()}};
  await done;
}


// Streams stored audio directly to a File System Access writer. At no point does
// this require assembling all chunks of a multi-hour recording in JS memory.
export async function streamRecordingAudio(rec,writer){
  const db=await openDB();
  const saved=await request(db.transaction('files').objectStore('files').get(rec.id));
  if(saved){await writer.write(saved.blob);return}
  const total=Number(rec.chunkCount)||0;
  if(!Number.isSafeInteger(total)||total<1||total>200000)
    throw new Error('Нет сохранённого аудио или неверно число блоков');
  for(let i=0;i<total;i++){
    const part=await request(db.transaction('chunks').objectStore('chunks').get([rec.id,i]));
    if(!part||!part.blob)throw new Error(`Аудиоблок ${i+1}/${total} отсутствует`);
    await writer.write(part.blob);
  }
}
