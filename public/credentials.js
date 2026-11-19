/** Shared settings/onboarding form. Secret exists only for the explicit request. */
export class CredentialsClient{
 constructor(library){this.library=library}
 status(){return this.library.json('/credentials/status')}
 configure(key,{signal}={}){return this.library.json('/credentials/configure',{method:'POST',body:{key},signal})}
 delete(){return this.library.json('/credentials/delete',{method:'POST',body:{}})}
}
export function mountCredentials(host,{client,onChange=()=>{}}){
 const id='groq-key-'+crypto.randomUUID();let controller=null,destroyed=false,current=null;
 host.innerHTML=`<form class="credentials-form" autocomplete="off"><p class="field-hint credential-status" role="status">Проверяем подключение…</p><div class="credential-account"><p class="field-hint">Создайте ключ в личном кабинете Groq и вставьте его ниже. Для платного использования настройте оплату в том же кабинете.</p><nav class="credential-account-links" aria-label="Личный кабинет Groq"><a class="btn btn-outline btn-small" href="https://console.groq.com/keys" target="_blank" rel="noopener noreferrer" referrerpolicy="no-referrer">Создать API-ключ</a><a class="btn btn-outline btn-small" href="https://console.groq.com/settings/billing/manage" target="_blank" rel="noopener noreferrer" referrerpolicy="no-referrer">Оплата и лимиты</a></nav></div><div class="credential-entry"><label class="field-label" for="${id}">Ключ Groq</label><input class="text-field" id="${id}" type="password" name="groq-key" autocomplete="off" autocapitalize="off" spellcheck="false" maxlength="512" placeholder="gsk_…" data-1p-ignore data-lpignore="true"><div class="credential-actions"><button class="btn btn-primary btn-small" type="submit">Подключить</button><button class="btn btn-outline btn-small credential-cancel" type="button" hidden>Отменить проверку</button><button class="btn btn-outline btn-small credential-delete" type="button" hidden>Отключить</button></div></div><p class="field-hint credential-message" role="status" aria-live="polite"></p></form>`;
 const form=host.querySelector('form'),input=host.querySelector('input'),submit=host.querySelector('[type="submit"]'),cancel=host.querySelector('.credential-cancel'),remove=host.querySelector('.credential-delete'),status=host.querySelector('.credential-status'),message=host.querySelector('.credential-message'),entry=host.querySelector('.credential-entry');
 const busy=value=>{submit.disabled=value;input.disabled=value;remove.disabled=value;cancel.hidden=!value;submit.textContent=value?'Проверяем…':current?.configured?'Заменить ключ':'Подключить'};
 const render=value=>{current=value;status.textContent=value.managed?'Groq подключён через параметры запуска.':value.configured?`Groq подключён · ${value.masked}`:value.errorCode==='VAULT_LOCKED'?'Разблокируйте системное хранилище ключей и повторите подключение.':value.errorCode?'Не удалось открыть системное хранилище ключей.':'Groq ещё не подключён.';entry.hidden=Boolean(value.managed);remove.hidden=!value.configured;busy(false)};
 const refresh=async()=>{try{const value=await client.status();if(!destroyed){render(value);onChange(value)}}catch(error){if(!destroyed){status.textContent='Не удалось проверить подключение.';message.textContent=error.message}}};
 form.addEventListener('submit',async event=>{
  event.preventDefault();if(controller)return;
  // A pasted key often carries spaces, a line break or quotes from a chat or a note.
  let key=input.value.trim().replace(/^["'«“]+|["'»”]+$/g,'').replace(/\s+/g,'');
  // Groq keys start with gsk_: a pasted wrong value is caught here, without a network round-trip.
  if(!/^gsk_[A-Za-z0-9]{20,}$/.test(key)){message.textContent=key?'Это не похоже на ключ Groq: он начинается с «gsk_». Скопируйте ключ целиком на console.groq.com → API Keys.':'Вставьте ключ Groq.';input.focus();return}
  input.value='';message.textContent='Проверяем ключ. Аудио не отправляется.';controller=new AbortController();busy(true);
  try{const value=await client.configure(key,{signal:controller.signal});if(!destroyed){render(value);message.textContent='Ключ проверен и сохранён в системном хранилище.';onChange(value)}}
  catch(error){if(!destroyed){message.textContent=error.name==='AbortError'?'Проверка отменена.':error.message;await refresh()}}
  finally{key=null;input.value='';controller=null;if(!destroyed)busy(false)}
 });
 cancel.addEventListener('click',()=>controller?.abort());
 remove.addEventListener('click',async()=>{if(controller)return;busy(true);input.value='';try{const value=await client.delete();if(!destroyed){render(value);message.textContent='Groq отключён. Записи остались в архиве.';onChange(value)}}catch(error){if(!destroyed)message.textContent=error.message}finally{if(!destroyed)busy(false)}});
 void refresh();
 return {refresh,clear(){input.value='';controller?.abort()},destroy(){destroyed=true;input.value='';controller?.abort();host.replaceChildren()}};
}
