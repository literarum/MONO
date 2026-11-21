/** Snapshot before confirmation: later UI changes cannot change an approved send. */
export function captureSelection(recordId,selected,settings){
 const choice=selected?.recordId===recordId?selected:null;
 if(choice&&!/^[a-f0-9]{64}$/.test(choice.versionId))throw new Error('Выбранный вариант недоступен. Подготовьте его ещё раз.');
 return Object.freeze({profile:settings.profile,prompt:settings.prompt||'',...(choice?{preparedVersionId:choice.versionId}:{}),title:choice?.title||'Оригинал'});
}
export async function selectionKey(recordId,selection){
 const bytes=new TextEncoder().encode(JSON.stringify([recordId,selection.preparedVersionId||null,selection.profile,selection.prompt,'whisper-large-v3-turbo']));
 return [...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))].map(value=>value.toString(16).padStart(2,'0')).join('');
}
