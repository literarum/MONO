/** Shared settings/onboarding form. Secret exists only for the explicit request. */
export class CredentialsClient{
 constructor(library){this.library=library}
 status(){return this.library.json('/credentials/status')}
 configure(key,{signal}={}){return this.library.json('/credentials/configure',{method:'POST',body:{key},signal})}
 delete(){return this.library.json('/credentials/delete',{method:'POST',body:{}})}
}
export function mountCredentials(host,{client,onChange=()=>{}}){
 const id='groq-key-'+crypto.randomUUID();let controller=null,destroyed=false,current=null,replacing=false,confirmTimer=0;
 // One clear state at the top: connected (green) or not (grey). With a key in place the field is
 // hidden; «Заменить ключ» opens it again, «Отключить» asks once more before removing the key.
 host.innerHTML=`<form class="credentials-form" autocomplete="off">
  <div class="credential-state" data-state="checking"><span class="credential-light" aria-hidden="true"></span><div class="credential-state-text"><strong class="credential-status" role="status">Проверяем подключение…</strong><span class="credential-detail"></span></div><div class="credential-manage"><button class="btn btn-outline btn-small credential-replace" type="button" hidden>Заменить ключ</button><button class="btn btn-outline btn-small credential-delete" type="button" hidden>Отключить</button></div></div>
  <div class="credential-entry" hidden><label class="field-label" for="${id}">Ключ Groq</label><div class="credential-field"><input class="text-field" id="${id}" type="password" name="groq-key" autocomplete="off" autocapitalize="off" spellcheck="false" maxlength="512" placeholder="Вставьте ключ: gsk_…" data-1p-ignore data-lpignore="true"><div class="credential-actions"><button class="btn btn-primary btn-small" type="submit">Подключить</button><button class="btn btn-outline btn-small credential-cancel" type="button" hidden>Отменить</button><button class="btn-plain credential-back" type="button" hidden>Не менять</button></div></div><nav class="credential-account-links" aria-label="Личный кабинет Groq"><a class="btn btn-tinted btn-small" href="https://console.groq.com/keys" target="_blank" rel="noopener noreferrer" referrerpolicy="no-referrer">Получить ключ на сайте Groq ↗</a><a class="btn btn-tinted btn-small" href="https://console.groq.com/settings/billing" target="_blank" rel="noopener noreferrer" referrerpolicy="no-referrer">Оплата и лимиты ↗</a></nav></div>
  <p class="field-hint credential-message" role="status" aria-live="polite"></p></form>`;
 const form=host.querySelector('form'),input=host.querySelector('input'),submit=host.querySelector('[type="submit"]'),cancel=host.querySelector('.credential-cancel'),remove=host.querySelector('.credential-delete'),replace=host.querySelector('.credential-replace'),back=host.querySelector('.credential-back'),status=host.querySelector('.credential-status'),detail=host.querySelector('.credential-detail'),state=host.querySelector('.credential-state'),message=host.querySelector('.credential-message'),entry=host.querySelector('.credential-entry');
 const busy=value=>{submit.disabled=value;input.disabled=value;remove.disabled=value;replace.disabled=value;cancel.hidden=!value;submit.textContent=value?'Проверяем…':current?.configured?'Сохранить новый ключ':'Подключить'};
 const layout=()=>{const configured=Boolean(current?.configured),managed=Boolean(current?.managed);entry.hidden=managed||(configured&&!replacing);replace.hidden=!configured||managed||replacing;remove.hidden=!configured||managed;back.hidden=!(configured&&replacing);if(!entry.hidden&&replacing)input.focus()};
 const render=value=>{current=value;replacing=false;
  const kind=value.managed||value.configured?'on':value.errorCode?'error':'off';state.dataset.state=kind;
  status.textContent=value.managed?'Groq подключён':value.configured?'Groq подключён':value.errorCode==='VAULT_LOCKED'?'Хранилище ключей заблокировано':value.errorCode?'Хранилище ключей недоступно':'Groq не подключён';
  detail.textContent=value.managed?'Ключ задан в параметрах запуска MONO.':value.configured?`Ключ ${value.masked} проверен и хранится в защищённом хранилище Windows.`:value.errorCode==='VAULT_LOCKED'?'Разблокируйте системное хранилище ключей и повторите.':value.errorCode?'Расшифровка временно недоступна; записывать можно.':'Без ключа можно записывать и слушать. Для расшифровки подключите ключ — это бесплатно.';
  layout();busy(false)};
 replace.addEventListener('click',()=>{replacing=true;message.textContent='Вставьте новый ключ — прежний останется, пока новый не проверен.';layout()});
 back.addEventListener('click',()=>{replacing=false;input.value='';message.textContent='';layout()});
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
 remove.addEventListener('click',async()=>{if(controller)return;if(!remove.dataset.confirm){remove.dataset.confirm='1';remove.textContent='Точно отключить?';remove.classList.add('is-danger');clearTimeout(confirmTimer);confirmTimer=setTimeout(()=>{delete remove.dataset.confirm;remove.textContent='Отключить';remove.classList.remove('is-danger')},4000);return}delete remove.dataset.confirm;remove.textContent='Отключить';remove.classList.remove('is-danger');busy(true);input.value='';try{const value=await client.delete();if(!destroyed){render(value);message.textContent='Groq отключён. Записи остались в архиве.';onChange(value)}}catch(error){if(!destroyed)message.textContent=error.message}finally{if(!destroyed)busy(false)}});
 void refresh();
 return {refresh,clear(){input.value='';controller?.abort()},destroy(){destroyed=true;input.value='';controller?.abort();host.replaceChildren()}};
}
