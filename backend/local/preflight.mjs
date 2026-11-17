// Pre-flight check: one read-only snapshot of every system recording depends on.
// Levels follow crew-alerting practice (EICAS): warning = action required before
// recording, caution = degraded capability, advisory = informational, ok = normal.
import {statfs,access} from 'node:fs/promises';import {constants} from 'node:fs';

// Worst case on disk: native float32 stereo at 48 kHz (browser capture is ~4× smaller).
export const BYTES_PER_HOUR=48000*2*4*3600;
const LEVELS=['ok','advisory','caution','warning'];
const check=(id,level,title,detail,action=null)=>({id,level,title,detail,...(action?{action}:{})});
async function timed(promise,ms){let timer;try{return await Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Object.assign(new Error('TIMEOUT'),{code:'TIMEOUT'})),ms)})])}finally{clearTimeout(timer)}}

export async function preflight({worker,runtime,keyManager,now=()=>performance.now()}){
 const checks=[];
 const tools=await runtime();
 checks.push(tools.ffmpeg&&tools.ffprobe?check('audio-tools','ok','FFmpeg','Обработка и прослушивание звука доступны.')
  :check('audio-tools','caution','FFmpeg не найден','Запись работает, но прослушивание, подготовка и расшифровка недоступны.','Переустановите MONO или установите FFmpeg.'));
 let status=null;const started=now();
 try{status=await timed(worker.call('status'),4000);const ms=Math.round(now()-started);
  checks.push(ms>1500?check('core','caution','Ядро архива отвечает медленно',`Ответ за ${ms} мс. Диск или антивирус могут задерживать запись.`):check('core','ok','Ядро архива',`Отвечает за ${ms} мс.`));
 }catch{checks.push(check('core','warning','Ядро архива не отвечает','Запись и библиотека недоступны.','Перезапустите MONO.'))}
 if(status){
  if(!status.libraryConfigured)checks.push(check('library','warning','Папка архива не выбрана','Записи некуда сохранять.','Выберите папку в настройках.'));
  else if(!status.libraryAvailable)checks.push(check('library','warning','Папка архива недоступна',status.libraryPath||'','Подключите диск с архивом или выберите папку снова.'));
  else{
   let writable=true;try{await access(status.libraryPath,constants.W_OK)}catch{writable=false}
   if(!writable)checks.push(check('library','warning','Нет прав записи в папку архива',status.libraryPath,'Выберите другую папку или выдайте права записи.'));
   else checks.push(check('library','ok','Папка архива',status.libraryPath));
   try{const space=await statfs(status.libraryPath),free=Number(space.bavail)*Number(space.bsize),hours=free/BYTES_PER_HOUR;
    const detail=`Свободно ${(free/1024**3).toFixed(1)} ГБ — не меньше ${hours>=10?Math.floor(hours):hours.toFixed(1)} ч записи.`;
    checks.push(hours<.25?check('disk','warning','Почти нет места на диске',detail,'Освободите место или перенесите архив.'):hours<2?check('disk','caution','Мало места на диске',detail,'Длинная встреча может не поместиться.'):check('disk','ok','Свободное место',detail));
   }catch{checks.push(check('disk','advisory','Свободное место не определено','Система не сообщила объём диска.'))}
  }
  if(status.libraryBusy)checks.push(check('transfer','warning','Идёт копирование архива','Запись станет доступна после завершения копирования.','Дождитесь окончания или остановите копирование в настройках.'));
  else if(status.transfer)checks.push(check('transfer','advisory','Есть незавершённое копирование архива','Записи это не мешает.','Продолжите или отмените копирование в настройках.'));
 }
 try{const capture=await timed(worker.call('capture.capabilities'),9000);
  if(capture.browserActive)checks.push(check('capture','ok','Модуль записи','Идёт запись через браузер.'));
  else if(capture.ready)checks.push(check('capture','ok','Системный модуль записи',`Доступно: ${(capture.modes||[]).map(mode=>({mic:'микрофон',system:'звук компьютера',both:'микрофон и компьютер'})[mode]||mode).join(', ')}.`));
  else checks.push(check('capture','advisory','Системный модуль записи не установлен','Микрофон записывается через окно браузера. Звук компьютера недоступен.'));
 }catch{checks.push(check('capture','advisory','Системный модуль записи не ответил','Микрофон записывается через окно браузера.'))}
 try{const key=await timed(keyManager.status(),3000);
  checks.push(key.configured?check('groq','ok','Groq подключён','Расшифровка доступна.'):check('groq','caution','Groq не подключён','Записывать можно; расшифровка начнётся после подключения ключа.','Подключите ключ в настройках.'));
 }catch{checks.push(check('groq','caution','Хранилище ключа недоступно','Расшифровка временно недоступна.'))}
 const worst=checks.reduce((level,item)=>LEVELS.indexOf(item.level)>LEVELS.indexOf(level)?item.level:level,'ok');
 return {checkedAt:new Date().toISOString(),level:worst,canRecord:!checks.some(item=>item.level==='warning'),checks};
}
