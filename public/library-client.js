/** Desktop archive transport. Audio streams and transcript pages stay bounded. */
export class LibraryError extends Error{
 constructor(code,message,status=0){super(message);this.name='LibraryError';this.code=code;this.status=status}
}
const messages={LIBRARY_NOT_CONFIGURED:'Выберите папку для записей.',LIBRARY_MISSING:'Папка с записями недоступна. Подключите диск или выберите её снова.',VERSION_CONFLICT:'Запись изменена в другом окне. Обновите её перед сохранением.',LIBRARY_BUSY:'Архив уже открыт другим экземпляром MONO.',TRASHED:'Запись находится в корзине.',DISK_FULL:'В папке архива недостаточно свободного места.',AUDIO_DAMAGED:'Не удалось проверить целостность аудио. Исходные файлы сохранены.'};
Object.assign(messages,{TRANSFER_PENDING:'Сначала продолжите или остановите незавершённое копирование в настройках.',TRANSFER_LIBRARY_CHANGED:'Выбран другой архив. Подключите исходную папку перед продолжением копирования.',TRANSFER_JOURNAL_INVALID:'Не удалось проверить журнал копирования. Исходный архив сохранён.',TRANSFER_JOURNAL_WRITE_FAILED:'Не удалось сохранить состояние копирования. Проверьте доступность диска.',INVALID_TRANSFER_STATE:'Эту операцию нельзя продолжить. Обновите состояние архива.'});
Object.assign(messages,{TRANSFER_CLEANUP_REQUIRED:'Не удалось очистить временные файлы прежней операции. Проверьте доступность диска и повторите.',TRANSFER_RECOVERY_LIMIT:'Сохранены сведения о нескольких сбоях копирования. Обратитесь за помощью перед новой попыткой; исходные записи сохранены.'});
export class LibraryClient{
 constructor({fetch:transport=globalThis.fetch.bind(globalThis)}={}){this.fetch=transport;this.csrf=null;this.status=null;this.records=new Map();this.queues=new Map();this.renewing=null}
 async renewSession(){
  if(this.renewing)return this.renewing;
  this.renewing=(async()=>{const response=await this.fetch('/api/local/session',{credentials:'same-origin',cache:'no-store',signal:AbortSignal.timeout(5000)});if(!response.ok)throw new LibraryError('SESSION_UNAVAILABLE','Не удалось подключиться к локальному приложению.',response.status);const data=await response.json();if(!/^[a-f0-9]{64}$/.test(data.csrf))throw new LibraryError('INVALID_SESSION','Приложение вернуло неверный ответ.');this.csrf=data.csrf})().finally(()=>{this.renewing=null});
  return this.renewing;
 }
 request(route,options){return this.requestPath('/api/local'+route,options)}
 jobRequest(route,options){
  if(typeof route!=='string'||!/^\/api\/jobs(?:\/[a-zA-Z0-9_-]+)*(?:\?[^#]*)?$/.test(route))throw new LibraryError('INVALID_ROUTE','Неизвестная операция очереди.');
  return this.requestPath(route,{...options,allowHTTPError:true});
 }
 async requestPath(route,{method='GET',body,headers={},signal,allowHTTPError=false}={}){
  const h=new Headers(headers);if(method!=='GET'&&method!=='HEAD')h.set('X-Mono-CSRF',this.csrf||'');
  if(body!==undefined&&!(body instanceof Blob)&&typeof body!=='string'&&!(body instanceof ReadableStream)){h.set('Content-Type','application/json');body=JSON.stringify(body)}
  let response=await this.fetch(route,{method,headers:h,body,signal,credentials:'same-origin',cache:'no-store'});
  // A 401 is emitted before dispatch: retrying a replayable body cannot commit
  // the mutation twice. Network errors and uncertain outcomes are never retried.
  if(response.status===401&&!(body instanceof ReadableStream)){
   await response.body?.cancel();await this.renewSession();if(method!=='GET'&&method!=='HEAD')h.set('X-Mono-CSRF',this.csrf);
   response=await this.fetch(route,{method,headers:h,body,signal,credentials:'same-origin',cache:'no-store'});
  }
  if(!response.ok&&!allowHTTPError){let data;try{data=await response.json()}catch{data={}}throw new LibraryError(data.code||'HTTP_ERROR',messages[data.code]||data.error||`Ошибка архива (${response.status})`,response.status)}
  return response;
 }
 async json(route,options){return (await this.request(route,options)).json()}
 async init(){await this.renewSession();return this.status=await this.json('/status')}
 async configure(options){this.status=await this.json('/library/configure',{method:'POST',body:options});this.records.clear();return this.status}
 remember(record){this.records.set(record.id,record);return record}
 async list({cursor=null,limit=100,query='',trash=false,signal}={}){const params=new URLSearchParams({limit:String(limit),q:query,trash:String(trash)});if(cursor)params.set('cursor',cursor);const page=await this.json('/records?'+params,{signal});for(const r of page.items)this.remember(r);return page}
 async get(id,{transcript=false}={}){
  const record=this.remember(await this.json('/records/'+encodeURIComponent(id)));
  if(transcript&&record.transcriptSummary){
   const segments=[];let offset=0;
   do{const page=await this.transcript(id,{offset,limit:100});segments.push(...page.segments.map(({index,...segment})=>segment));offset=page.nextOffset}while(offset!==null);
   return {...record,transcript:{model:record.transcriptSummary.model,segments}};
  }return record;
 }
 serial(id,action){const operation=(this.queues.get(id)||Promise.resolve()).then(action);const settled=operation.catch(()=>{});this.queues.set(id,settled);void settled.then(()=>{if(this.queues.get(id)===settled)this.queues.delete(id)});return operation}
 async current(id){return this.records.get(id)||this.get(id)}
 async create(meta){return this.remember(await this.json('/records',{method:'POST',body:meta}))}
 async import(meta,audio){return this.remember(await this.json('/records/import',{method:'POST',headers:{'Content-Type':meta.mime||'application/octet-stream','X-Mono-Record':encodeURIComponent(JSON.stringify(meta))},body:audio}))}
 patch(id,patch){return this.serial(id,async()=>{
  let record=await this.current(id);const {transcript,...metadata}=patch;
  if(transcript!==undefined)record=this.remember(await this.json(`/records/${id}/transcript`,{method:'PUT',headers:{'Content-Type':'application/json','X-Mono-Version':String(record.version)},body:JSON.stringify(transcript)}));
  if(Object.keys(metadata).length)record=this.remember(await this.json('/records/'+id,{method:'PATCH',body:{expectedVersion:record.version,patch:metadata}}));
  return record;
 })}
 transcript(id,{offset=0,limit=65,query='',signal}={}){return this.json(`/records/${id}/transcript?`+new URLSearchParams({offset:String(offset),limit:String(limit),q:query}),{signal})}
 submit(id,options){return this.json(`/records/${id}/transcribe`,{method:'POST',body:options})}
 edit(id,index,text){return this.serial(id,async()=>{const r=await this.current(id);return this.remember(await this.json(`/records/${id}/transcript/edit`,{method:'PUT',headers:{'Content-Type':'application/json','X-Mono-Version':String(r.version)},body:JSON.stringify({index,text})}))})}
 segment(id,index,blob,{track='original',frames=0}={}){return this.serial(id,async()=>{const receipt=await this.json(`/records/${id}/segments/${track}/${index}`,{method:'PUT',headers:{'X-Mono-Frames':String(frames)},body:blob});await this.get(id);return receipt})}
 trash(id){return this.serial(id,async()=>{const r=await this.current(id);return this.remember(await this.json(`/records/${id}/trash`,{method:'POST',body:{expectedVersion:r.version}}))})}
 restore(id,version){return this.serial(id,async()=>{const r=await this.current(id);return this.remember(await this.json(`/records/${id}/restore`,{method:'POST',body:{expectedVersion:version??r.version}}))})}
 audioURL(id,variant='original'){return `/api/local/records/${encodeURIComponent(id)}/audio?variant=${encodeURIComponent(variant)}`}
 async streamAudio(id,writer){const response=await this.request(`/records/${id}/audio`);for await(const part of response.body)await writer.write(part)}
}
