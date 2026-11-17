import {LibraryClient,LibraryError} from './library-client.js';
export const captureErrors={ACCESS_DENIED:'Доступ к звуку не предоставлен. Разрешите его в настройках системы и повторите проверку.',DEVICE_LOST:'Выбранное устройство отключено или изменилось. Выберите его снова.',DEVICE_BUSY:'Звук занят другим приложением. Закройте его или выберите другое устройство.',UNSUPPORTED_FORMAT:'Формат устройства пока не поддерживается. Выберите другое устройство.',CAPTURE_HELPER_UNAVAILABLE:'Помощник записи недоступен. Перезапустите MONO.',CAPTURE_HELPER_TIMEOUT:'Запись перестала отвечать. Сохранённые фрагменты остались в архиве.',ARCHIVE_SAVE_FAILED:'Не удалось подтвердить сохранение. Проверьте диск с архивом; исходные фрагменты сохранены для восстановления.',ARCHIVE_IO_ERROR:'Диск с записями недоступен. Запись остановлена; подтверждённые фрагменты сохранены.',CAPTURE_BUSY:'Сначала остановите текущую запись.',HELPER_UNAVAILABLE:'В этом выпуске недоступен нативный модуль записи.',SLEEP:'Компьютер переходил в сон. Запись остановлена; сохранённые фрагменты остались в архиве.'};
Object.assign(captureErrors,{BROWSER_AUDIO_UNAVAILABLE:'В этом браузере недоступна запись микрофона.',BROWSER_AUDIO_ERROR:'Микрофон перестал передавать звук. Повторите проверку источника.',BROWSER_CAPTURE_LOST:'Связь с окном записи потеряна.',BROWSER_CAPTURE_OWNER:'Управляйте паузой в окне, где началась запись.',NO_AUDIO_CAPTURED:'Микрофон не передал аудио. Проверьте выбранный вход.',ACCESS_TIMEOUT:'Доступ к микрофону не подтверждён вовремя. Повторите проверку.',CAPTURE_QUEUE_OVERFLOW:'Архив не успевает сохранять звук. Проверьте диск.'});
Object.assign(captureErrors,{LIBRARY_BUSY:'Дождитесь завершения копирования архива, затем начните запись.',CAPTURE_NOT_READY:'Модуль записи ещё не готов. Повторите проверку.',NOT_SUPPORTED:'На этом компьютере не найдено подходящих устройств записи.',CAPTURE_STOP_TIMEOUT:'Запись не завершилась вовремя. Подтверждённые фрагменты сохранены в архиве.',UNEXPECTED_CAPTURE_STOP:'Устройство неожиданно остановило запись. Подтверждённые фрагменты сохранены.',INVALID_CAPTURE_PROTOCOL:'Модуль записи передал некорректные данные. Перезапустите MONO.',DISCONTINUITY:'Устройство пропустило часть звука. Запись остановлена; сохранённые фрагменты в архиве.',IO_ERROR:'Не удалось записать звук на диск. Проверьте папку архива.',INTERNAL:'Внутренняя ошибка модуля записи. Перезапустите MONO.',DISK_FULL:'В папке архива недостаточно свободного места.',INVALID_CAPTURE_MODE:'Выбранный источник недоступен. Выберите другой источник записи.',INVALID_PAUSED_AUDIO:'Во время паузы получен звук. Запись остановлена для сохранности данных.',ACCESS_TIMEOUT:'Доступ к микрофону не подтверждён вовремя. Повторите проверку.'});
export function captureFailureMessage(value){
 const saved=Number(value.savedBytes)>0||Number(value.savedFrames)>0;
 const detail=captureErrors[value.errorCode];
 if(saved)return 'Запись прервана. Подтверждённые фрагменты сохранены в архиве. '+(detail||'Проверьте источник перед новой записью.');
 const hint=['ACCESS_DENIED','DEVICE_LOST','DEVICE_BUSY','UNSUPPORTED_FORMAT','BROWSER_AUDIO_UNAVAILABLE','BROWSER_CAPTURE_OWNER','NO_AUDIO_CAPTURED','ACCESS_TIMEOUT'].includes(value.errorCode)?detail:'Проверьте источник и повторите запись.';
 return 'Не удалось начать запись. Сохранение аудио не подтверждено. '+hint;
}
export class CaptureClient{
 constructor({library=new LibraryClient(),timeoutMs=5000}={}){if(!Number.isFinite(timeoutMs)||timeoutMs<1||timeoutMs>30000)throw new RangeError('Invalid capture deadline');this.library=library;this.timeoutMs=timeoutMs;this.initialized=null;this.polling=null}
 async init(){return this.initialized??=Promise.resolve(this.library.csrf?this.library.status:this.library.init()).catch(error=>{this.initialized=null;throw error})}
 async call(operation,params,{signal}={}){const deadline=signal||AbortSignal.timeout(this.timeoutMs);try{await this.init();return await this.library.json('/capture/'+operation,{method:params===undefined?'GET':'POST',body:params,signal:deadline})}catch(error){if(captureErrors[error.code])error.message=captureErrors[error.code];if(error instanceof LibraryError||error.name==='AbortError'&&deadline.reason?.name!=='TimeoutError')throw error;throw new LibraryError('CAPTURE_CONNECTION_LOST','Не удалось получить подтверждение от модуля записи. Проверяем её состояние; действие не будет повторено автоматически.')}}
 async capabilities({signal}={}){let result=await this.call('capabilities',undefined,{signal}),deadline=Date.now()+8000;while(result.supported!==false&&!result.ready&&result.state!=='error'&&Date.now()<deadline){await new Promise(resolve=>setTimeout(resolve,100));signal?.throwIfAborted();result=await this.call('capabilities',undefined,{signal})}return result}
 devices(){return this.call('devices')}
 checkAccess(){return this.call('check_access')}
 async start(options,{test=false,signal}={}){const c=await this.capabilities({signal});signal?.throwIfAborted();if(!c.ready)throw new LibraryError(c.reason||'CAPTURE_NOT_READY',captureErrors[c.reason]||'Модуль записи ещё не готов. Повторите проверку.');return this.call(test?'test':'start',options)}
 pause(){return this.call('pause',{})}
 resume(){return this.call('resume',{})}
 stop(){return this.call('stop',{})}
 status(options){return this.call('status',undefined,options)}
 discardTest(recordId){return this.call('discard_test',{recordId})}
 watch(onState,{signal,interval=150}={}){
  if(this.polling)return this.polling;
  this.polling=(async()=>{while(!signal?.aborted){const state=await this.status();if(signal?.aborted)break;onState(state);await new Promise(resolve=>setTimeout(resolve,interval))}})().finally(()=>{this.polling=null});return this.polling;
 }
}
