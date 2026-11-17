"""Read old mono-portable-v1 exports into an isolated native staging archive."""
import json,math,re,shutil,uuid
from datetime import datetime
from pathlib import Path
from local_core.library import Library,digest
from local_core.paths import atomic_json,confined,reject_links,identifier
from local_core.protocol import CoreError

def fail(code='INVALID_BACKUP'):raise CoreError(code,code)
def convert_legacy(source,target,cancel=None,progress=None):
    from local_core.transfer import copy_file,snapshot_library
    source=Path(source).absolute();reject_links(source);manifest=confined(source,'manifest.json')
    if not manifest.is_file() or manifest.stat().st_size>25*1024**2:fail()
    try:value=json.loads(manifest.read_text(encoding='utf-8'))
    except (ValueError,UnicodeError):fail()
    if not isinstance(value,dict) or value.get('format')!='mono-portable-v1' or not isinstance(value.get('records'),list) or len(value['records'])>10000:fail()
    prepared=[];ids=set()
    for item in value['records']:
        if not isinstance(item,dict) or not isinstance(item.get('record'),dict):fail()
        record=item['record'];rid=identifier(record.get('id'));audio=item.get('audio')
        if rid in ids or not isinstance(audio,str) or not re.fullmatch(re.escape(rid)+r'\.(webm|wav|ogg|flac|mp4|mp3|m4a|aac)',audio,re.IGNORECASE):fail()
        ids.add(rid);file=confined(source,audio)
        if not file.is_file() or not 0<file.stat().st_size<=32*1024**3:fail()
        title=record.get('title');mime=record.get('mime');stamp=record.get('createdAt');duration=record.get('duration',0)
        if not isinstance(title,str) or not title.strip() or len(title)>500 or not isinstance(mime,str) or len(mime)>100 or not isinstance(stamp,str):fail()
        try:datetime.fromisoformat(stamp)
        except ValueError:fail()
        if type(duration) not in [int,float] or not math.isfinite(duration) or duration<0:fail()
        prepared.append((record,file))
    if progress is not None:progress.update({'phase':'converting','copiedBytes':0,'totalBytes':sum(file.stat().st_size for _,file in prepared)})
    library=Library.open(target)
    try:
        for record,file in prepared:
            if cancel is not None and cancel.is_set():fail('TRANSFER_CANCELLED')
            if shutil.disk_usage(target).free<file.stat().st_size+16*1024**2:fail('DISK_FULL')
            created=library.create_record({**record,'status':'importing'});staged=confined(library.root,'.staging',str(uuid.uuid4())+'.part');sha=digest(file)
            copy_file(file,staged,{'size':file.stat().st_size,'sha256':sha},cancel,progress)
            receipt=library.commit_segment(created['id'],'original',0,staged,0,sha)
            fields=['duration','source','estimatedUSD','completedAt','peaks','gapMarkers'];patch={key:record[key] for key in fields if key in record}
            status=record.get('status','saved')
            if status in ['recording','queued','processing','uploading']:status='interrupted'
            if status not in ['saved','completed','interrupted','failed','cancelled']:fail()
            if record.get('transcript'):patch['transcript']=record['transcript']
            elif status=='completed':status='saved'
            patch.update({'status':status,'chunkCount':1})
            library.patch_record(created['id'],receipt['version'],patch)
        snapshot=snapshot_library(library)
        atomic_json(confined(library.root,'backup.json'),snapshot)
        return snapshot
    finally:library.close()
