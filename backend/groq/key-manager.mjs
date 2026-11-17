const messages={
 INVALID_KEY:'Ключ Groq не принят. Создайте новый ключ и повторите подключение.',
 KEY_FORBIDDEN:'У ключа нет доступа к Groq. Проверьте организацию и разрешения.',
 RATE_LIMITED:'Groq временно ограничил запросы. Повторите подключение позже.',
 BILLING_LIMIT:'Groq ограничил доступ по расходам. Проверьте оплату и лимит в Billing вашего аккаунта.',
 NETWORK_ERROR:'Не удалось соединиться с Groq. Проверьте подключение к интернету и повторите проверку.',
 PROVIDER_UNAVAILABLE:'Groq сейчас недоступен. Ключ не сохранён; повторите подключение позже.',
 MODEL_UNAVAILABLE:'Groq не вернул модель распознавания. Проверьте доступные модели в вашем аккаунте.',
 PROVIDER_RESPONSE:'Не удалось проверить ответ Groq. Ключ не сохранён.',KEY_TIMEOUT:'Groq не ответил вовремя. Ключ не сохранён.',
 KEY_BUSY:'Проверка ключа уже выполняется.',KEY_MANAGED:'Ключ задан при запуске приложения. Измените его в настройках запуска.',CANCELLED:'Подключение отменено.',KEY_NOT_CONFIGURED:'Подключите Groq для расшифровки.',
 VAULT_UNAVAILABLE:'Системное хранилище ключей недоступно. Ключ не сохранён.',VAULT_LOCKED:'Системное хранилище ключей заблокировано. Разблокируйте его и повторите подключение.'
};
export class KeyError extends Error{constructor(code){super(messages[code]||messages.VAULT_UNAVAILABLE);this.name='KeyError';this.code=code}}
async function providerJSON(response,limit=1024*1024){
 let size=0;const parts=[];const reader=response.body?.getReader();if(!reader)throw new KeyError('PROVIDER_RESPONSE');
 try{while(true){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>limit)throw new KeyError('PROVIDER_RESPONSE');parts.push(value)}const bytes=new Uint8Array(size);let offset=0;for(const part of parts){bytes.set(part,offset);offset+=part.byteLength}return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));}
 catch(error){await reader.cancel().catch(()=>{});if(error instanceof KeyError)throw error;if(error?.name==='AbortError'||error?.name==='TimeoutError')throw error;throw new KeyError('PROVIDER_RESPONSE')}
 finally{reader.releaseLock()}
}
async function models(response){const value=await providerJSON(response);if(!Array.isArray(value?.data)||value.data.length>10000)throw new KeyError('PROVIDER_RESPONSE');if(!value.data.some(row=>row?.id==='whisper-large-v3-turbo'))throw new KeyError('MODEL_UNAVAILABLE')}
async function providerFailure(response){
 // Recognize a bounded allowlist. Provider text can echo credentials; it never
 // becomes an exception, diagnostic, HTTP response, or log entry.
 let code;try{code=(await providerJSON(response,65536))?.error?.code}catch{}
 if(response.status===402||['blocked_api_access','insufficient_quota','billing_hard_limit_reached'].includes(code))return 'BILLING_LIMIT';
 return response.status===401?'INVALID_KEY':response.status===403?'KEY_FORBIDDEN':response.status===429?'RATE_LIMITED':'PROVIDER_UNAVAILABLE';
}
export class KeyManager{
 constructor({worker,externalKey='',endpoint='https://api.groq.com/openai/v1/models',timeoutMs=8000,onChange=()=>{}}){this.worker=worker;this.externalKey=externalKey;this.endpoint=endpoint;this.timeoutMs=timeoutMs;this.onChange=onChange;this.busy=false;this.current={configured:!!externalKey,verified:false,managed:!!externalKey,masked:externalKey?'•••• '+externalKey.slice(-4):null,errorCode:null}}
 async status(){
  if(this.externalKey)return {...this.current,busy:this.busy};
  try{const status=await this.worker.call('credentials.status');this.current={...status,managed:false};}
  catch{this.current={configured:false,verified:false,managed:false,masked:null,errorCode:'VAULT_UNAVAILABLE'}}
  this.onChange(this.current);return {...this.current,busy:this.busy};
 }
 async getKey(){
  if(this.externalKey)return this.externalKey;
  try{const result=await this.worker.call('credentials.read');if(!result.key)throw new KeyError('KEY_NOT_CONFIGURED');return result.key}
  catch(error){const safe=error instanceof KeyError?error:new KeyError(error.code==='VAULT_LOCKED'?'VAULT_LOCKED':'VAULT_UNAVAILABLE');this.current={configured:false,verified:false,managed:false,masked:null,errorCode:safe.code};this.onChange(this.current);throw safe}
 }
 async configure(key,{signal}={}){
  if(this.externalKey)throw new KeyError('KEY_MANAGED');if(this.busy)throw new KeyError('KEY_BUSY');
  if(typeof key!=='string'||!/^[A-Za-z0-9_-]{20,512}$/.test(key))throw new KeyError('INVALID_KEY');
  this.busy=true;const timeout=AbortSignal.timeout(this.timeoutMs);const combined=signal?AbortSignal.any([signal,timeout]):timeout;
  try{
   if(combined.aborted)throw new KeyError(signal?.aborted?'CANCELLED':'KEY_TIMEOUT');
   let response;
   try{response=await fetch(this.endpoint,{method:'GET',headers:{Authorization:'Bearer '+key,Accept:'application/json'},signal:combined,redirect:'error'});}
   catch{throw new KeyError(signal?.aborted?'CANCELLED':timeout.aborted?'KEY_TIMEOUT':'NETWORK_ERROR')}
   if(!response.ok){const code=await providerFailure(response);if(combined.aborted)throw new KeyError(signal?.aborted?'CANCELLED':'KEY_TIMEOUT');throw new KeyError(code)}
   try{await models(response)}catch(error){if(combined.aborted)throw new KeyError(signal?.aborted?'CANCELLED':'KEY_TIMEOUT');throw error}
   if(combined.aborted)throw new KeyError(signal?.aborted?'CANCELLED':'KEY_TIMEOUT');
   let stored;try{stored=await this.worker.call('credentials.store',{key,verifiedAt:new Date().toISOString()})}catch(error){throw new KeyError(error.code==='VAULT_LOCKED'?'VAULT_LOCKED':'VAULT_UNAVAILABLE')}
   this.current={...stored,managed:false};this.onChange(this.current);return {...this.current,busy:false};
  }finally{key=null;this.busy=false}
 }
 async delete(){
  if(this.externalKey)throw new KeyError('KEY_MANAGED');if(this.busy)throw new KeyError('KEY_BUSY');this.busy=true;
  try{let result;try{result=await this.worker.call('credentials.delete')}catch(error){throw new KeyError(error.code==='VAULT_LOCKED'?'VAULT_LOCKED':'VAULT_UNAVAILABLE')}this.current={...result,managed:false};this.onChange(this.current);return {...this.current,busy:false}}
  finally{this.busy=false}
 }
}
