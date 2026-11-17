"""Verified, resumable copies. No source file is moved or deleted."""
import hashlib,json,os,re,shutil,uuid,threading,time,tempfile
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path,PurePosixPath
from local_core.paths import atomic_json,confined,identifier,publish,reject_links
from local_core.library import digest,now
from local_core.protocol import CoreError
from local_core.schema import record as validate_record

def fail(code):raise CoreError(code,code)
def fingerprint(value):return hashlib.sha256(json.dumps(value,ensure_ascii=False,sort_keys=True,separators=(',',':')).encode('utf-8')).hexdigest()
def relative(value):
    if not isinstance(value,str) or '\\' in value or ':' in value or len(value)>2048:fail('INVALID_BACKUP_PATH')
    parts=PurePosixPath(value).parts
    if PurePosixPath(value).is_absolute() or any(p in ['.','..'] for p in parts) or '/'.join(parts)!=value:fail('INVALID_BACKUP_PATH')
    if value=='library.json':return parts
    if len(parts)<3 or parts[0]!='records':fail('INVALID_BACKUP_PATH')
    identifier(parts[1])
    if Path(parts[-1]).suffix not in ['.json','.part','.wav','.flac','.webm','.ogg','.mp3','.m4a','.aac','.mp4']:fail('INVALID_BACKUP_PATH')
    return parts

def ensure_idle(library):
    library._settle_pending()
    if library.db.execute("SELECT 1 FROM records WHERE trashed=0 AND status IN ('requesting','recording','paused','uploading','queued','processing','importing','migrating') LIMIT 1").fetchone():fail('LIBRARY_ACTIVE')

def snapshot_library(library,check_active=True):
    if check_active:
        ensure_idle(library);library.verify_transcript_history()
    files=[];root=library.root
    for file in [root/'library.json',*sorted((root/'records').rglob('*'))]:
        reject_links(file)
        if file.is_dir():continue
        name=file.relative_to(root).as_posix();relative(name)
        files.append({'path':name,'size':file.stat().st_size,'sha256':digest(file)})
    meta=json.loads((root/'library.json').read_text(encoding='utf-8'))
    snapshot={'format':'mono-archive-v2','schema':2,'libraryId':meta['id'],'createdAt':now(),'files':files,'complete':True}
    validate_snapshot(snapshot);check_records(root,files);return snapshot

def validate_snapshot(snapshot):
    if not isinstance(snapshot,dict) or snapshot.get('format')!='mono-archive-v2' or snapshot.get('schema')!=2 or snapshot.get('complete') is not True:fail('INVALID_BACKUP')
    identifier(snapshot.get('libraryId'));files=snapshot.get('files')
    if not isinstance(files,list) or not 1<=len(files)<=500000:fail('INVALID_BACKUP')
    names=set()
    for item in files:
        if not isinstance(item,dict):fail('INVALID_BACKUP')
        relative(item.get('path'));size=item.get('size');sha=item.get('sha256')
        if type(size) is not int or size<0 or size>32*1024**3 or not isinstance(sha,str) or not re.fullmatch('[a-f0-9]{64}',sha):fail('INVALID_BACKUP')
        if item['path'] in names:fail('INVALID_BACKUP')
        names.add(item['path'])
    if 'library.json' not in names:fail('INVALID_BACKUP')
    return snapshot

def check_files(root,snapshot,cancel=None):
    validate_snapshot(snapshot)
    for item in snapshot['files']:
        if cancel is not None and cancel.is_set():fail('TRANSFER_CANCELLED')
        file=confined(root,*relative(item['path']))
        if not file.is_file() or file.stat().st_size!=item['size'] or digest(file)!=item['sha256']:fail('BACKUP_CHECKSUM')
    meta=json.loads(confined(root,'library.json').read_text(encoding='utf-8'))
    if meta.get('schema')!=1 or meta.get('id')!=snapshot['libraryId']:fail('INVALID_BACKUP')
    check_records(root,snapshot['files'])
    return snapshot

def check_records(root,files):
    # Every manifest and transcript-history reference must be covered by the
    # verified inventory, including read-only background source snapshots.
    inventory={item['path']:item for item in files}
    for item in files:
        if not item['path'].endswith('/record.json'):continue
        record=json.loads(confined(root,*relative(item['path'])).read_text(encoding='utf-8'))
        validate_record(record)
        if record.get('id')!=relative(item['path'])[1]:fail('INVALID_BACKUP')
        for part in record.get('_segments',[]):
            name=part.get('path');entry=inventory.get(name)
            if not entry or not name.startswith('records/'+record['id']+'/original/') or entry['sha256']!=part.get('sha256') or entry['size']!=part.get('bytes'):fail('INVALID_BACKUP')
        if 'transcript' in record:
            from local_core.transcript_journal import TranscriptJournal
            TranscriptJournal(root,record['id']).verify(record,inventory)

def verify_backup(root,cancel=None):
    root=Path(root).absolute();reject_links(root);file=confined(root,'backup.json')
    if not file.is_file() or file.stat().st_size>64*1024**2:fail('INVALID_BACKUP')
    try:snapshot=json.loads(file.read_text(encoding='utf-8'))
    except (ValueError,UnicodeError):fail('INVALID_BACKUP')
    return check_files(root,snapshot,cancel)

def copy_file(source,target,item,cancel=None,progress=None):
    reject_links(source);reject_links(target);target.parent.mkdir(parents=True,exist_ok=True)
    if target.exists():
        if target.stat().st_size!=item['size'] or digest(target)!=item['sha256']:fail('TRANSFER_CONFLICT')
        if progress is not None:progress['copiedBytes']+=item['size']
        return
    temp=target.with_name(target.name+'.'+str(uuid.uuid4())+'.tmp');hasher=hashlib.sha256();size=0
    try:
        with source.open('rb') as reader,temp.open('xb') as writer:
            for block in iter(lambda:reader.read(1024*1024),b''):
                if cancel is not None and cancel.is_set():fail('TRANSFER_CANCELLED')
                writer.write(block);hasher.update(block);size+=len(block)
                if progress is not None:progress['copiedBytes']+=len(block)
            writer.flush();os.fsync(writer.fileno())
        if size!=item['size'] or hasher.hexdigest()!=item['sha256']:fail('BACKUP_CHECKSUM')
        publish(temp,target)
    finally:
        if temp.exists():temp.unlink()

def copy_snapshot(source,target,snapshot,cancel=None,progress=None):
    source=Path(source).resolve();target=Path(target).absolute();reject_links(target);validate_snapshot(snapshot)
    if target.resolve().is_relative_to(source) or source.is_relative_to(target.resolve()):fail('OVERLAPPING_LIBRARY')
    marker=target/'.mono-transfer.json';signature=fingerprint({'libraryId':snapshot['libraryId'],'files':snapshot['files']})
    if target.exists() and any(target.iterdir()):
        if not marker.is_file():fail('TRANSFER_CONFLICT')
        if json.loads(marker.read_text(encoding='utf-8')).get('snapshot')!=signature:fail('TRANSFER_CONFLICT')
    target.mkdir(parents=True,exist_ok=True);reject_links(marker)
    atomic_json(marker,{'schema':1,'libraryId':snapshot['libraryId'],'snapshot':signature})
    remaining=sum(item['size'] for item in snapshot['files'] if not confined(target,*relative(item['path'])).exists())
    if shutil.disk_usage(target).free<remaining+16*1024**2:fail('DISK_FULL')
    if progress is not None:progress.update({'totalBytes':sum(item['size'] for item in snapshot['files']),'copiedBytes':0,'phase':'copying'})
    # A destination becomes an openable archive only after all record bytes.
    ordered=sorted(snapshot['files'],key=lambda item:(item['path']=='library.json',item['path'].endswith('/record.json'),item['path']))
    for item in ordered:copy_file(confined(source,*relative(item['path'])),confined(target,*relative(item['path'])),item,cancel,progress)
    if progress is not None:progress['phase']='verifying'
    check_files(target,snapshot,cancel)
    atomic_json(confined(target,'backup.json'),snapshot)
    if progress is not None:progress['phase']='complete'
    return {'records':sum(item['path'].endswith('/record.json') for item in snapshot['files']),'bytes':sum(item['size'] for item in snapshot['files'])}

def merge_backup(source,target,cancel=None,progress=None,snapshot=None):
    source=Path(source).absolute();target=Path(target).absolute();reject_links(source);reject_links(target)
    if not confined(source,'backup.json').is_file() and confined(source,'manifest.json').is_file():
        from local_core.legacy_backup import convert_legacy
        staging=confined(target,'.staging');staging.mkdir(exist_ok=True)
        with tempfile.TemporaryDirectory(prefix='legacy-',dir=staging) as temp:
            converted=Path(temp).resolve()
            if not converted.is_relative_to(staging.resolve()):fail('UNSAFE_PATH')
            convert_legacy(source,converted,cancel,progress)
            return merge_backup(converted,target,cancel,progress)
    snapshot=check_files(source,snapshot,cancel) if snapshot is not None else verify_backup(source,cancel);files=[item for item in snapshot['files'] if item['path']!='library.json']
    # Preflight all ID collisions before publishing the first new record.
    for item in files:
        destination=confined(target,*relative(item['path']))
        if destination.exists() and digest(destination)!=item['sha256']:fail('TRANSFER_CONFLICT')
    remaining=sum(item['size'] for item in files if not confined(target,*relative(item['path'])).exists())
    if shutil.disk_usage(target).free<remaining+16*1024**2:fail('DISK_FULL')
    if progress is not None:progress.update({'phase':'copying','totalBytes':sum(item['size'] for item in files),'copiedBytes':0})
    for item in sorted(files,key=lambda item:(item['path'].endswith('/record.json'),item['path'])):
        copy_file(confined(source,*relative(item['path'])),confined(target,*relative(item['path'])),item,cancel,progress)
    if progress is not None:progress['phase']='verifying'
    for item in files:
        if digest(confined(target,*relative(item['path'])))!=item['sha256']:fail('BACKUP_CHECKSUM')
    return {'records':sum(item['path'].endswith('/record.json') for item in files),'bytes':sum(item['size'] for item in files)}

class TransferManager:
    def __init__(self,config):
        from local_core.transfer_journal import TransferJournal
        self.config=config;self.pool=None;self.task=None;self.recovery_error=None
        self.journal=TransferJournal(config.directory)
        try:
            saved=self.journal.load()
            if saved:
                self.task={**saved,**{key:Path(saved[key]) for key in ['source','target','libraryRoot']},'cancel':threading.Event(),'progress':{'phase':'checking','copiedBytes':0,'totalBytes':0}}
                if self.task['state']=='running':self.task['state']='interrupted'
        except CoreError as error:self.recovery_error=error.code
    @property
    def active(self):
        self.finish();return bool(self.task and self.task['state']=='running')
    def pending(self):
        self.finish()
        if self.task and self.task['state'] in ['running','interrupted','failed']:return self.status(self.task['id'])
        return None
    def guard(self):
        if self.recovery_error:fail(self.recovery_error)
        if self.active:fail('LIBRARY_BUSY')
        if self.task and self.task['state'] in ['completed','cancelled']:
            self.cleanup(self.task)
            if self.task.get('cleanupPending'):fail('TRANSFER_CLEANUP_REQUIRED')
        if self.config.pending_stages:fail('LIBRARY_ACTIVE')
        if self.config._capture is not None and self.config._capture.active:fail('CAPTURE_BUSY')
        library=self.config.get_library();ensure_idle(library);return library
    def recover_invalid(self):
        if not self.recovery_error:fail('INVALID_TRANSFER_STATE')
        self.journal.archive_invalid();self.recovery_error=None;self.task=None
        return {'recovered':True}
    def cleanup(self,task):
        try:self.journal.cleanup(task);task.pop('cleanupPending',None)
        except (OSError,CoreError):task['cleanupPending']=True
        # The completed/cancelled intent is already durable before cleanup.
        # Cleanup failure does not undo a verified copy or hide pending bytes.
        try:self.journal.save(task)
        except OSError:task['cleanupPending']=True
    def start(self,params):
        library=self.guard()
        if self.pending():fail('TRANSFER_PENDING')
        kind=params.get('kind')
        if kind not in ['move','export','import']:fail('INVALID_TRANSFER')
        purpose={'move':'move','export':'backup','import':'import'}[kind]
        choice=self.config.consume_choice(params.get('choiceId'),[purpose]);selected=choice['path']
        from local_core.folders import local_folder
        selected=local_folder(selected);reject_links(selected)
        target=selected if kind=='move' else selected/('MONO_BACKUP_'+now().replace(':','-')+'_'+uuid.uuid4().hex[:8]) if kind=='export' else library.root
        other=selected if kind=='import' else target
        if other.resolve().is_relative_to(library.root) or library.root.is_relative_to(other.resolve()):fail('OVERLAPPING_LIBRARY')
        if kind=='move' and target.exists() and any(target.iterdir()) and not (target/'.mono-transfer.json').is_file():fail('TRANSFER_CONFLICT')
        task={'id':str(uuid.uuid4()),'kind':kind,'state':'running','source':selected if kind=='import' else library.root,'target':target,'libraryRoot':library.root,'cancel':threading.Event(),'progress':{'phase':'checking','copiedBytes':0,'totalBytes':0}}
        self.journal.save(task);self.task=task
        return self.launch()
    def resume(self,operation_id):
        task=self.task
        if not task or task['id']!=operation_id:fail('NOT_FOUND')
        if task['state'] not in ['interrupted','failed']:fail('INVALID_TRANSFER_STATE')
        library=self.guard()
        allowed=[task['libraryRoot'],task['target']] if task['kind']=='move' else [task['libraryRoot']]
        if library.root not in [path.resolve() for path in allowed]:fail('TRANSFER_LIBRARY_CHANGED')
        resumed={key:value for key,value in task.items() if key not in ['future','errorCode','closing','result']}
        resumed.update({'cancel':threading.Event(),'state':'running','progress':{'phase':'checking','copiedBytes':0,'totalBytes':0}})
        self.journal.save(resumed);self.task=resumed;return self.launch()
    def launch(self):
        task=self.task;kind=task['kind'];cancel=task['cancel'];progress=task['progress']
        if self.pool is None:self.pool=ThreadPoolExecutor(max_workers=1,thread_name_prefix='mono-archive-copy')
        def work():
            from types import SimpleNamespace
            source=task['source'];target=task['target'];reject_links(source);reject_links(target)
            if target.resolve().is_relative_to(source.resolve()) or source.resolve().is_relative_to(target.resolve()):fail('OVERLAPPING_LIBRARY')
            if task.get('snapshotHash'):
                snapshot=self.journal.snapshot(task)
                try:
                    check_files(source,snapshot,cancel)
                    actual=snapshot_library(SimpleNamespace(root=source),check_active=False)
                    if actual['libraryId']!=snapshot['libraryId'] or actual['files']!=snapshot['files']:fail('TRANSFER_SOURCE_CHANGED')
                except CoreError as error:
                    if error.code in ['BACKUP_CHECKSUM','INVALID_BACKUP']:fail('TRANSFER_SOURCE_CHANGED')
                    raise
            else:
                if kind=='import':
                    if not confined(source,'backup.json').is_file() and confined(source,'manifest.json').is_file():
                        from local_core.legacy_backup import convert_legacy
                        converted=confined(self.journal.workspace(task['id']),'legacy-'+uuid.uuid4().hex)
                        snapshot=convert_legacy(source,converted,cancel,progress)
                        task['source']=source=converted
                    else:snapshot=verify_backup(source,cancel)
                else:snapshot=snapshot_library(SimpleNamespace(root=source),check_active=False)
                self.journal.snapshot(task,snapshot)
            if cancel.is_set():fail('TRANSFER_CANCELLED')
            if kind=='import':return merge_backup(source,target,cancel,progress,snapshot=snapshot)
            return copy_snapshot(source,target,snapshot,cancel,progress)
        task['future']=self.pool.submit(work)
        return self.status(task['id'])
    def finish(self):
        task=self.task
        if not task or task['state']!='running' or 'future' not in task or not task['future'].done():return
        try:
            result=task['future'].result()
            if task['kind']=='move':
                from local_core.library import Library
                # A crash after settings publication must not lock/reopen the
                # already selected target or switch back to the old source.
                current=self.config.get_library()
                candidate=current if current.root==task['target'].resolve() else Library.open(task['target'])
                try:
                    if candidate.recover()['corrupt']:fail('INVALID_BACKUP')
                    updated={**self.config.settings,'schema':1,'libraryRoot':str(candidate.root)}
                    atomic_json(self.config.file,updated)
                except Exception:
                    if candidate is not current:candidate.close()
                    raise
                previous=self.config.library;self.config.library=candidate;self.config.settings=updated
                if previous is not candidate:previous.close()
            elif task['kind']=='import':
                if self.config.get_library().recover()['corrupt']:fail('INVALID_BACKUP')
            task['state']='completed';task['result']={**result,'displayPath':str(task['target'])}
        except Exception as error:
            task['state']=('interrupted' if task.get('closing') else 'cancelled') if getattr(error,'code',None)=='TRANSFER_CANCELLED' else 'failed'
            task['errorCode']=getattr(error,'code',None) or 'TRANSFER_FAILED'
        try:self.journal.save(task)
        except OSError:
            # Keep the last durable running intent recoverable after disk loss.
            task['state']='failed';task['errorCode']='TRANSFER_JOURNAL_WRITE_FAILED'
            return
        if task['state'] in ['completed','cancelled']:self.cleanup(task)
    def status(self,operation_id):
        self.finish();task=self.task
        if not task or task['id']!=operation_id:fail('NOT_FOUND')
        return {'id':task['id'],'kind':task['kind'],'state':task['state'],**task['progress'],**({'result':task['result']} if 'result' in task else {}),**({'errorCode':task['errorCode']} if 'errorCode' in task else {}),**({'cleanupPending':True} if task.get('cleanupPending') else {})}
    def cancel(self,operation_id):
        if not self.task or self.task['id']!=operation_id:fail('NOT_FOUND')
        self.task['cancel'].set()
        if self.task['state'] in ['interrupted','failed']:
            cancelled={**self.task,'state':'cancelled'};self.journal.save(cancelled);self.task=cancelled;self.cleanup(cancelled)
        return self.status(operation_id)
    def close(self):
        if self.task and self.task['state']=='running':self.task['closing']=True;self.task['cancel'].set()
        if self.pool:self.pool.shutdown(wait=True);self.pool=None;self.finish()
