/** Pure, independently testable portability rules. Never trust imported metadata. */
export function audioExtension(mime){
 const m=String(mime||'').toLowerCase();
 if(m.includes('wav'))return 'wav';
 if(m.includes('ogg'))return 'ogg';
 if(m.includes('flac'))return 'flac';
 if(m.includes('mpeg'))return 'mp3';
 if(m.includes('aac'))return 'aac';
 if(m.includes('mp4'))return 'm4a';
 return 'webm';
}
export function validBackupItem(item){
 return !!item && !!item.record &&
  /^[a-f0-9-]{36}$/i.test(String(item.record.id||'')) &&
  typeof item.audio==='string' &&
  /^[-a-f0-9]{36}\.(webm|wav|ogg|flac|mp4|mp3|m4a|aac)$/i.test(item.audio) &&
  item.audio.startsWith(item.record.id+'.');
}
export function portableRecord(original,id){
 if(!/^[a-f0-9-]{36}$/i.test(String(id)))throw new Error('Invalid target ID');
 const rec={...original,id,title:String(original.title||'Импортированная запись').slice(0,150)};
 if(['processing','queued','recording','uploading'].includes(rec.status))rec.status='interrupted';
 for(const field of ['serverJobId','taskKey','clientKey','jobId','job','serverAcked',
                     'cancelRequested','purgeRequested'])delete rec[field];
 return rec;
}
