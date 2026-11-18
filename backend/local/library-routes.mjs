import {open,unlink,statfs} from 'node:fs/promises';import {createReadStream} from 'node:fs';import {createHash} from 'node:crypto';import {once} from 'node:events';
import {pipeline} from 'node:stream/promises';
const send=(res,status,body)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});res.end(JSON.stringify(body))};
export async function readJSON(req,limit=60000){let size=0;const chunks=[];for await(const part of req){size+=part.length;if(size>limit){const e=new Error('Слишком большой запрос');e.code='TOO_LARGE';throw e}chunks.push(part)}try{const value=JSON.parse(Buffer.concat(chunks).toString('utf8')||'{}');if(!value||Array.isArray(value)||typeof value!=='object')throw new Error();return value}catch{const e=new Error('Некорректный запрос');e.code='INVALID_JSON';throw e}}
function errorStatus(code){return ['NOT_FOUND','TRASHED','AUDIO_NOT_FOUND'].includes(code)?404:['VERSION_CONFLICT','LIBRARY_BUSY','LIBRARY_ACTIVE','SEGMENT_CONFLICT','ID_CONFLICT','MIGRATION_CONFLICT','TRANSFER_CONFLICT','TRANSFER_PENDING','TRANSFER_SOURCE_CHANGED','TRANSFER_LIBRARY_CHANGED','PREPARATION_BUSY','SOURCE_BUSY','CAPTURE_BUSY','STALE_AUDIO_VERSION'].includes(code)?409:code==='TOO_LARGE'?413:code==='DISK_FULL'?507:code?.startsWith('INVALID')||['CHECKSUM','SEQUENCE','NOT_LIBRARY','UNSAFE_PATH'].includes(code)?400:503}
export async function receive(req,worker,limit=32*1024**3){
 const stage=await worker.call('stage.allocate');let handle,total=0;const hash=createHash('sha256');
 try{
  handle=await open(stage.path,'r+');let checkAt=0;
  for await(const part of req){
   total+=part.length;if(total>limit){const e=new Error('Файл слишком большой');e.code='TOO_LARGE';throw e}
   if(total>=checkAt){const free=await statfs(stage.path);if(Number(free.bavail)*Number(free.bsize)<part.length+16*1024**2){const e=new Error('Недостаточно места');e.code='DISK_FULL';throw e}checkAt=total+8*1024**2}
   hash.update(part);let offset=0;while(offset<part.length){const {bytesWritten}=await handle.write(part,offset,part.length-offset);if(!bytesWritten)throw new Error('WRITE_FAILED');offset+=bytesWritten}
  }
  if(!total){const e=new Error('Пустой файл');e.code='INVALID_AUDIO';throw e}
  await handle.sync();await handle.close();handle=null;return {stagingId:stage.id,sha256:hash.digest('hex'),size:total};
 }catch(error){if(handle)await handle.close();await worker.call('stage.discard',{id:stage.id}).catch(()=>{});throw error}
}
function byteRange(header,size){
 if(!header)return {start:0,end:size-1,partial:false};
 const match=/^bytes=(\d*)-(\d*)$/.exec(header);if(!match||!match[1]&&!match[2])return null;
 let start=match[1]?Number(match[1]):Math.max(0,size-Number(match[2]));let end=match[2]&&match[1]?Math.min(size-1,Number(match[2])):size-1;
 if(!Number.isSafeInteger(start)||!Number.isSafeInteger(end)||start<0||start>end||start>=size)return null;return {start,end,partial:true};
}
export async function streamAudio(req,res,descriptor){
 const range=byteRange(req.headers.range,descriptor.size);
 if(!range){res.writeHead(416,{'Content-Range':`bytes */${descriptor.size}`,'Cache-Control':'no-store'});res.end();return}
 const mime=/^audio\/[a-zA-Z0-9.+-]+(?:;codecs=[a-zA-Z0-9,.-]+)?$/.test(descriptor.mime)?descriptor.mime:'application/octet-stream';
 res.writeHead(range.partial?206:200,{'Content-Type':mime,'Content-Length':range.end-range.start+1,'Accept-Ranges':'bytes','Cache-Control':'no-store','X-Content-Type-Options':'nosniff',...(range.partial?{'Content-Range':`bytes ${range.start}-${range.end}/${descriptor.size}`}:{})});
 if(req.method==='HEAD'){res.end();return}
 let offset=0;
 for(const file of descriptor.files){
  const first=Math.max(0,range.start-offset),last=Math.min(file.size-1,range.end-offset);offset+=file.size;if(first>last)continue;
  for await(const part of createReadStream(file.path,{start:first,end:last})){if(res.destroyed)return;if(!res.write(part))await once(res,'drain')}
 }res.end();
}
export async function libraryRoute(req,res,url,worker,{submitLibraryJob,isLibraryBusy,resolveOriginal,preparation,resolveSpeakers}={}){
 const base='/api/local',pathname=url.pathname;
 if(!pathname.startsWith(base+'/records')&&!pathname.startsWith(base+'/library/')&&!pathname.startsWith(base+'/migration/'))return false;
 try{
  if([base+'/library/configure',base+'/library/transfer'].includes(pathname)&&req.method==='POST'&&isLibraryBusy?.()){send(res,409,{error:'Дождитесь завершения обработки',code:'LIBRARY_ACTIVE'});return true}
  if(pathname===base+'/library/configure'&&req.method==='POST'){send(res,200,await worker.call('library.configure',await readJSON(req)));return true}
  if(pathname===base+'/library/choose'&&req.method==='POST'){send(res,200,await worker.call('folder.choose',await readJSON(req)));return true}
  if(pathname===base+'/library/choice'&&req.method==='POST'){send(res,200,await worker.call('folder.poll',await readJSON(req)));return true}
  if(pathname===base+'/library/choice/cancel'&&req.method==='POST'){send(res,200,await worker.call('folder.cancel',await readJSON(req)));return true}
  if(pathname===base+'/library/transfer'&&req.method==='POST'){send(res,202,await worker.call('transfer.start',await readJSON(req)));return true}
  if(pathname===base+'/library/transfer/status'&&req.method==='POST'){send(res,200,await worker.call('transfer.status',await readJSON(req)));return true}
  if(pathname===base+'/library/transfer/cancel'&&req.method==='POST'){send(res,200,await worker.call('transfer.cancel',await readJSON(req)));return true}
  if(pathname===base+'/library/transfer/resume'&&req.method==='POST'){send(res,202,await worker.call('transfer.resume',await readJSON(req)));return true}
  if(pathname===base+'/library/transfer/recover'&&req.method==='POST'){await readJSON(req);send(res,200,await worker.call('transfer.recover_invalid'));return true}
  if(pathname===base+'/migration/begin'&&req.method==='POST'){send(res,201,await worker.call('migration.begin',await readJSON(req)));return true}
  const migration=pathname.match(/^\/api\/local\/migration\/([a-f0-9-]{36})\/(parts\/(\d+)|transcript|finish)$/);
  if(migration){
   const id=migration[1],action=migration[2];
   if(action==='finish'&&req.method==='POST'){await readJSON(req);send(res,200,await worker.call('migration.finish',{id}));return true}
   if(req.method==='PUT'&&(action.startsWith('parts/')||action==='transcript')){
    await worker.call('records.get',{id});const upload=await receive(req,worker,action==='transcript'?32*1024**2:32*1024**3);
    try{send(res,200,await worker.call(action==='transcript'?'migration.transcript':'migration.part',{id,index:Number(migration[3]),...upload},{timeoutMs:60000}))}finally{await worker.call('stage.discard',{id:upload.stagingId}).catch(()=>{})}return true;
   }
  }
  if(pathname===base+'/records'&&req.method==='GET'){send(res,200,await worker.call('records.list',{cursor:url.searchParams.get('cursor'),limit:Number(url.searchParams.get('limit')||100),query:url.searchParams.get('q')||'',trash:url.searchParams.get('trash')==='true'}));return true}
  if(pathname===base+'/records'&&req.method==='POST'){send(res,201,await worker.call('records.create',{meta:await readJSON(req)}));return true}
  if(pathname===base+'/records/import'&&req.method==='POST'){
   let meta;try{const raw=req.headers['x-mono-record'];if(!raw||raw.length>8000)throw new Error();meta=JSON.parse(decodeURIComponent(raw));if(!meta||typeof meta.title!=='string'||meta.title.length>500||typeof meta.mime!=='string')throw new Error()}catch{send(res,400,{error:'Проверьте параметры аудиофайла',code:'INVALID_RECORD'});return true}
   const uploaded=await receive(req,worker);try{send(res,201,await worker.call('records.import',{meta,...uploaded},{timeoutMs:60000}))}finally{await worker.call('stage.discard',{id:uploaded.stagingId}).catch(()=>{})}return true;
  }
  const match=pathname.match(/^\/api\/local\/records\/([a-f0-9-]{36})(?:\/(audio|speakers|trash|restore|transcribe|transcript(?:\/edit)?|segments\/(mic|system|mix|original)\/(\d+)))?$/);
  if(!match)return false;const id=match[1],action=match[2];
  if(!action&&req.method==='GET'){send(res,200,await worker.call('records.get',{id}));return true}
  if(action==='speakers'&&req.method==='GET'){send(res,200,{profile:resolveSpeakers?await resolveSpeakers(id):null});return true}
  if(!action&&req.method==='PATCH'){send(res,200,await worker.call('records.patch',{...await readJSON(req),id}));return true}
  if(action==='transcribe'&&req.method==='POST'){
   if((await worker.call('status')).libraryBusy){send(res,409,{error:'Дождитесь завершения копирования',code:'LIBRARY_BUSY'});return true}
   const options=await readJSON(req),record=await worker.call('records.get',{id});
   if(Object.keys(options).some(key=>!['clientKey','profile','prompt','preparedVersionId'].includes(key))||options.preparedVersionId!==undefined&&(typeof options.preparedVersionId!=='string'||!/^[a-f0-9]{64}$/.test(options.preparedVersionId))){send(res,400,{code:'INVALID_JOB',error:'Проверьте выбранный вариант записи'});return true}
   const source=options.preparedVersionId?await preparation.resolve(id,options.preparedVersionId):resolveOriginal?await resolveOriginal(id):await worker.call('records.audio',{id});
   const result=await submitLibraryJob(record,source,options);send(res,result.reused?200:202,result);return true;
  }
  if(action==='transcript'&&req.method==='GET'){
   const page=await worker.call('records.transcript.file',{id,offset:Number(url.searchParams.get('offset')||0),limit:Number(url.searchParams.get('limit')||50),query:url.searchParams.get('q')||''});
   try{res.writeHead(200,{'Content-Type':'application/json; charset=utf-8','Content-Length':page.size,'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});await pipeline(createReadStream(page.path),res)}finally{await worker.call('stage.discard',{id:page.id}).catch(()=>{})}return true;
  }
  if(['transcript','transcript/edit'].includes(action)&&req.method==='PUT'){
   await worker.call('records.get',{id});const uploaded=await receive(req,worker,32*1024**2);
   try{send(res,200,await worker.call(action==='transcript'?'records.transcript.commit':'records.transcript.edit',{id,expectedVersion:Number(req.headers['x-mono-version']),...uploaded},{timeoutMs:60000}))}finally{await worker.call('stage.discard',{id:uploaded.stagingId}).catch(()=>{})}return true;
  }
  if(['trash','restore'].includes(action)&&req.method==='POST'){send(res,200,await worker.call('records.'+action,{...await readJSON(req),id}));return true}
  if(action==='audio'&&['GET','HEAD'].includes(req.method)){
   const controller=new AbortController(),close=()=>{if(!res.writableEnded)controller.abort()};res.on('close',close);
   try{const variant=url.searchParams.get('variant')||'original';const descriptor=variant==='original'&&resolveOriginal?await resolveOriginal(id,{signal:controller.signal}):await worker.call('records.audio',{id,variant});if(!res.destroyed)await streamAudio(req,res,descriptor)}finally{res.off('close',close)}return true;
  }
  if(action?.startsWith('segments/')&&req.method==='PUT'){
   await worker.call('records.get',{id});const uploaded=await receive(req,worker,32*1024**2);
   try{send(res,200,await worker.call('records.segment',{id,track:match[3],index:Number(match[4]),frames:Number(req.headers['x-mono-frames']||0),...uploaded}))}finally{await worker.call('stage.discard',{id:uploaded.stagingId}).catch(()=>{})}return true;
  }
  return false;
 }catch(error){
  if(res.headersSent){res.destroy();return true}
  const historyError=['TRANSCRIPT_HISTORY_DAMAGED','TRANSCRIPT_HISTORY_CONFLICT','TRANSCRIPT_HISTORY_LIMIT'].includes(error.code);
  const folderErrors={PICKER_UNAVAILABLE:'Не удалось открыть системное окно выбора папки.',PICKER_BUSY:'Окно выбора папки уже открыто. Завершите выбор или отмените его.',NOT_LIBRARY:'В этой папке нет архива MONO. Для нового архива выберите пустую папку.',INVALID_CHOICE:'Выбор папки больше не действует. Выберите папку ещё раз.',NETWORK_LIBRARY:'Выберите папку на локальном диске компьютера.',FOLDER_UNAVAILABLE:'Папка «Документы» недоступна. Выберите другую папку.',INVALID_LIBRARY:'Не удалось прочитать описание архива. Сохраните папку и выберите другой архив.',NEWER_LIBRARY_VERSION:'Архив создан в более новой версии MONO. Обновите приложение.'};
  const message=folderErrors[error.code]||(historyError?'История расшифровки требует восстановления из резервной копии. Остальные записи доступны.':'Операция с архивом не выполнена');
  send(res,errorStatus(error.code),{error:message,code:error.code||'LIBRARY_ERROR'});return true;
 }
}
