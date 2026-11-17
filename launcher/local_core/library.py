"""Single-writer file archive. SQLite indexes independently recoverable manifests."""
import base64, copy, hashlib, json, math, os, re, shutil, sqlite3, uuid
from datetime import datetime, timezone
from pathlib import Path
from local_core.paths import LibraryLock,atomic_json,confined,identifier,publish,reject_links
from local_core.protocol import CoreError
from local_core.schema import PATCH_FIELDS,fields as validate_fields,record as validate_record,transcript as validate_transcript
from local_core.transcript_journal import TranscriptJournal,ERRORS as HISTORY_ERRORS,projection

def now():return datetime.now(timezone.utc).isoformat()
def digest(file):
    value=hashlib.sha256()
    with file.open('rb') as stream:
        for block in iter(lambda:stream.read(1024*1024),b''):value.update(block)
    return value.hexdigest()
def failure(code):raise CoreError(code,code)

class Library:
    @classmethod
    def open(cls,root):return cls(root)
    @staticmethod
    def _empty_initialization(root):
        """Recognize only the exact, payload-free interrupted bootstrap layout."""
        directories={'records','.staging','trash','journal'}
        if not root.is_dir() or {p.name for p in root.iterdir()}!=directories|{'library.sqlite3','.mono-library.lock'}:return False
        for name in directories:
            path=confined(root,name)
            if not path.is_dir() or any(path.iterdir()):return False
        database=confined(root,'library.sqlite3');lock=confined(root,'.mono-library.lock')
        return database.is_file() and database.stat().st_size==0 and database.stat().st_nlink==1 and lock.is_file() and lock.stat().st_size==1 and lock.stat().st_nlink==1
    @classmethod
    def open_empty_initialization(cls,root):
        root=Path(root).absolute();reject_links(root)
        if not cls._empty_initialization(root):failure('NOT_LIBRARY')
        return cls(root,_resume_empty=True)
    def __init__(self,root,*,_resume_empty=False):
        root=Path(root).absolute();reject_links(root)
        # Reject future formats before acquiring a new lock or creating any
        # archive files. Immutable read-only preflight cannot create WAL/SHM.
        meta=confined(root,'library.json');database=confined(root,'library.sqlite3')
        if meta.exists():
            try:data=json.loads(meta.read_text(encoding='utf-8'))
            except (ValueError,UnicodeError):failure('INVALID_LIBRARY')
            if not isinstance(data,dict) or data.get('schema')!=1:failure('NEWER_LIBRARY_VERSION')
        if database.exists():
            probe=None
            try:
                probe=sqlite3.connect(database.as_uri()+'?mode=ro&immutable=1',uri=True)
                if probe.execute('PRAGMA user_version').fetchone()[0]>1:failure('NEWER_LIBRARY_VERSION')
            finally:
                if probe is not None:probe.close()
        root.mkdir(parents=True,exist_ok=True)
        self.root=root.resolve();self.lock=LibraryLock(self.root/'.mono-library.lock');self.db=None;self._pending_commits=set();self._transcript_errors={}
        try:
            if _resume_empty:
                # Check again with exclusive ownership, before touching SQLite.
                # Read the locked byte through its owning handle on Windows.
                self.lock.handle.seek(0);signature=self.lock.handle.read(1);self.lock.handle.seek(0)
                if signature!=b'\0' or not self._empty_initialization(self.root):failure('NOT_LIBRARY')
            database=confined(self.root,'library.sqlite3')
            self.db=sqlite3.connect(database)
            def matches(encoded,query):
                record=json.loads(encoded);needle=query.casefold()
                return int(needle in record['title'].casefold() or any(needle in s['text'].casefold() for s in record.get('transcript',{}).get('segments',[])))
            self.db.create_function('mono_matches',2,matches,deterministic=True)
            version=self.db.execute('PRAGMA user_version').fetchone()[0]
            if version>1:failure('NEWER_LIBRARY_VERSION')
            for name in ['records','.staging','trash','journal']:
                confined(self.root,name).mkdir(exist_ok=True)
            self.db.executescript(Path(__file__).with_name('schema.sql').read_text(encoding='utf-8'))
            meta=confined(self.root,'library.json')
            if meta.exists():
                data=json.loads(meta.read_text(encoding='utf-8'))
                if data.get('schema')!=1:failure('NEWER_LIBRARY_VERSION')
            else:atomic_json(meta,{'schema':1,'id':str(uuid.uuid4()),'createdAt':now()})
        except Exception:self.close();raise
    def close(self):
        if self.db is not None:self.db.close();self.db=None
        if getattr(self,'lock',None):self.lock.close()
    def manifest(self,rid):return confined(self.root,'records',identifier(rid),'record.json')
    def _raw(self,rid):
        self._settle_pending()
        identifier(rid)
        row=self.db.execute('SELECT data FROM records WHERE id=?',(rid,)).fetchone()
        if not row:failure('NOT_FOUND')
        return json.loads(row[0])
    def _public(self,record):
        value={k:copy.deepcopy(v) for k,v in record.items() if not k.startswith('_')}
        if record['id'] in self._transcript_errors:value['transcriptHistoryError']=self._transcript_errors[record['id']]
        return value
    def _validate_commit(self,record):
        validate_record(record)
        metadata={k:v for k,v in record.items() if not k.startswith('_') and k!='transcript'}
        if len(json.dumps(metadata,ensure_ascii=False,separators=(',',':')).encode('utf-8'))>48000:failure('INVALID_RECORD_SIZE')
    def _commit(self,record):
        self._settle_pending()
        self._validate_commit(record)
        if record['id'] in self._transcript_errors:
            raise CoreError(self._transcript_errors[record['id']],'История расшифровки требует восстановления из резервной копии.')
        source=self._transcript_source(record) if 'transcript' in record else None
        # The manifest is the commit point. Never publish transcript projections
        # during validation, or use a possibly uncommitted projection as input.
        self._pending_commits.add(record['id'])
        atomic_json(self.manifest(record['id']),record)
        self._sync_transcript(record,source)
        self._index_record(record)
        self._pending_commits.discard(record['id'])
        return self._public(record)
    def _index_record(self,record):
        encoded=json.dumps(record,ensure_ascii=False,separators=(',',':'))
        with self.db:
            self.db.execute('INSERT INTO records(id,title,created_at,version,status,trashed,data) VALUES(?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET title=excluded.title,version=excluded.version,status=excluded.status,trashed=excluded.trashed,data=excluded.data',(record['id'],record['title'],record['createdAt'],record['version'],record['status'],int(record.get('_trashed',False)),encoded))
            self.db.execute('DELETE FROM segments WHERE record_id=?',(record['id'],))
            for part in record.get('_segments',[]):self.db.execute('INSERT INTO segments VALUES(?,?,?,?,?,?,?)',(record['id'],part['track'],part['index'],part['frames'],part['sha256'],part['path'],part['bytes']))
    def _settle_pending(self):
        # An I/O failure may occur after durable publication but before its ACK.
        # Reconcile before serving stale versions or accepting another mutation.
        for rid in list(self._pending_commits):
            file=self.manifest(rid)
            if file.exists():
                record=json.loads(file.read_text(encoding='utf-8'))
                self._validate_commit(record)
                if record['id']!=rid:failure('INVALID_ID')
                try:self._sync_transcript(record)
                except CoreError as error:
                    if error.code not in HISTORY_ERRORS:raise
                    self._transcript_errors[rid]=error.code
                self._index_record(record)
            elif self.db.execute('SELECT 1 FROM records WHERE id=?',(rid,)).fetchone():
                failure('LIBRARY_RECOVERY_REQUIRED')
            self._pending_commits.discard(rid)
    def _transcript_source(self,record):
        previous=self.db.execute('SELECT data FROM records WHERE id=?',(record['id'],)).fetchone()
        return TranscriptJournal(self.root,record['id']).source(record,json.loads(previous[0]) if previous else None)
    def _sync_transcript(self,record,source=None):
        value=record.get('transcript')
        if value is None:return
        folder=confined(self.root,'records',record['id'],'transcripts')
        original_file=confined(folder,'original.json');edits_file=confined(folder,'edits.json')
        original=source if source is not None else self._transcript_source(record)
        previous=self.db.execute('SELECT data FROM records WHERE id=?',(record['id'],)).fetchone()
        TranscriptJournal(self.root,record['id']).publish(record,original,json.loads(previous[0]) if previous else None)
        if projection(original_file)!=original:atomic_json(original_file,original)
        if projection(edits_file)!=value:atomic_json(edits_file,value)
        self._transcript_errors.pop(record['id'],None)
        return any(key in value and key not in original for key in ['model','language','rawText'])
    def verify_transcript_history(self):
        self._settle_pending()
        if self._transcript_errors:raise CoreError('TRANSCRIPT_HISTORY_DAMAGED','История расшифровки требует восстановления из резервной копии.')
        for row in self.db.execute('SELECT data FROM records'):
            record=json.loads(row[0])
            if 'transcript' in record:
                self._sync_transcript(record);TranscriptJournal(self.root,record['id']).verify(record)
    def create_record(self,meta,migration=None):
        self._settle_pending()
        if not isinstance(meta,dict):failure('INVALID_RECORD')
        title=meta.get('title','Новая запись')
        if not isinstance(title,str) or not title.strip() or len(title)>500:failure('INVALID_TITLE')
        rid=identifier(meta['id']) if 'id' in meta else str(uuid.uuid4())
        if self.db.execute('SELECT 1 FROM records WHERE id=?',(rid,)).fetchone():failure('ID_CONFLICT')
        record={'id':rid,'title':title.strip(),'createdAt':meta.get('createdAt',now()),'duration':0,'mime':meta.get('mime','audio/wav'),'size':0,'source':meta.get('source','Импорт'),'status':meta.get('status','saved'),'version':1,'tracks':[],'_segments':[]}
        if migration is not None:record['_migration']=copy.deepcopy(migration)
        return self._commit(record)
    def get_record(self,rid):
        raw=self._raw(rid)
        if raw.get('_trashed'):failure('TRASHED')
        return self._public(raw)
    def metadata(self,rid):
        record=self.get_record(rid)
        transcript=record.pop('transcript',None)
        if transcript:record['transcriptSummary']={'segmentCount':len(transcript.get('segments',[])),'model':transcript.get('model')}
        return record
    def transcript_page(self,rid,offset=0,limit=50,query=''):
        if type(offset) is not int or offset<0 or type(limit) is not int or not 1<=limit<=100:failure('INVALID_PAGE')
        segments=self.get_record(rid).get('transcript',{}).get('segments',[])
        rows=[{**segment,'index':index} for index,segment in enumerate(segments) if not query or query.casefold() in segment['text'].casefold()]
        page=rows[offset:offset+limit]
        end=offset+len(page)
        return {'segments':page,'total':len(rows),'nextOffset':end if end<len(rows) else None}
    def transcript_page_file(self,rid,offset=0,limit=50,query=''):
        page=self.transcript_page(rid,offset,limit,query)
        token=str(uuid.uuid4());file=confined(self.root,'.staging',token+'.part')
        atomic_json(file,page)
        return {'id':token,'path':str(file),'size':file.stat().st_size}
    def _transcript(self,record,value):
        if not isinstance(value,dict) or not isinstance(value.get('segments'),list) or len(value['segments'])>200000:failure('INVALID_TRANSCRIPT')
        if 'model' in value and (not isinstance(value['model'],str) or len(value['model'])>200):failure('INVALID_TRANSCRIPT')
        original=record.get('transcript')
        if original and len(original['segments'])!=len(value['segments']):failure('ORIGINAL_CONFLICT')
        normalized=[]
        for index,item in enumerate(value['segments']):
            if not isinstance(item,dict) or not isinstance(item.get('text'),str) or len(item['text'])>20000:failure('INVALID_TRANSCRIPT')
            start=item.get('start',0);end=item.get('end',start)
            if not isinstance(start,(int,float)) or not isinstance(end,(int,float)) or not math.isfinite(start) or not math.isfinite(end) or start<0 or end<start:failure('INVALID_TIMESTAMPS')
            if original:
                source=original['segments'][index]
                if start!=source['start'] or end!=source['end']:failure('ORIGINAL_CONFLICT')
                original_text=source.get('original',source['text'])
            else:original_text=item.get('original',item['text'])
            if not isinstance(original_text,str) or len(original_text)>20000:failure('INVALID_TRANSCRIPT')
            segment_id=original['segments'][index].get('id',index) if original else item.get('id',index)
            normalized.append({'id':segment_id,'start':start,'end':end,'text':item['text'],'original':original_text})
        result={**value,'segments':normalized}
        return result
    def commit_transcript(self,rid,expected_version,staged_file):
        record=self.get_record(rid)
        if record['version']!=expected_version:failure('VERSION_CONFLICT')
        file=Path(staged_file);reject_links(file)
        if file.parent.resolve()!=confined(self.root,'.staging').resolve() or file.stat().st_size>32*1024**2:failure('UNSAFE_PATH')
        try:
            def invalid_constant(_):raise ValueError()
            with file.open(encoding='utf-8') as stream:value=json.load(stream,parse_constant=invalid_constant)
        except (ValueError,UnicodeError):failure('INVALID_TRANSCRIPT')
        self.patch_record(rid,expected_version,{'transcript':value})
        return self.metadata(rid)
    def edit_transcript(self,rid,expected_version,staged_file):
        record=self.get_record(rid)
        if record['version']!=expected_version:failure('VERSION_CONFLICT')
        file=Path(staged_file);reject_links(file)
        if file.parent.resolve()!=confined(self.root,'.staging').resolve() or file.stat().st_size>200000:failure('UNSAFE_PATH')
        try:value=json.loads(file.read_text(encoding='utf-8'))
        except (ValueError,UnicodeError):failure('INVALID_TRANSCRIPT')
        index=value.get('index');text=value.get('text');transcript=record.get('transcript',{})
        if type(index) is not int or not 0<=index<len(transcript.get('segments',[])) or not isinstance(text,str):failure('INVALID_TRANSCRIPT')
        transcript['segments'][index]['text']=text
        self.patch_record(rid,expected_version,{'transcript':transcript})
        return self.metadata(rid)
    def list_records(self,cursor=None,limit=100,query='',trashed=False):
        self._settle_pending()
        if not isinstance(limit,int) or not 1<=limit<=200:failure('INVALID_LIMIT')
        if type(trashed) is not bool:failure('INVALID_FILTER')
        clauses=['trashed=?'];args=[int(trashed)]
        if query:
            if not isinstance(query,str) or len(query)>500:failure('INVALID_QUERY')
            clauses.append('mono_matches(data,?)=1');args.append(query)
        if cursor:
            try:
                stamp,rid=json.loads(base64.urlsafe_b64decode(cursor).decode());identifier(rid)
                if not isinstance(stamp,str):raise ValueError()
            except Exception:failure('INVALID_CURSOR')
            clauses.append('(created_at<? OR (created_at=? AND id<?))');args.extend([stamp,stamp,rid])
        rows=self.db.execute('SELECT data FROM records WHERE '+' AND '.join(clauses)+' ORDER BY created_at DESC,id DESC LIMIT ?',[*args,limit+1]).fetchall()
        records=[json.loads(row[0]) for row in rows];page=records[:limit];next_cursor=None
        items=[];consumed=[];byte_count=0
        for rec in page:
            item=self._public(rec)
            if trashed:item['trashed']=True
            if 'transcript' in item:item['transcriptSummary']={'segmentCount':len(item['transcript'].get('segments',[]))};del item['transcript']
            size=len(json.dumps(item,ensure_ascii=False,separators=(',',':')).encode('utf-8'))+1
            if items and byte_count+size>50000:break
            items.append(item);consumed.append(rec);byte_count+=size
        if len(records)>len(consumed) and consumed:next_cursor=base64.urlsafe_b64encode(json.dumps([consumed[-1]['createdAt'],consumed[-1]['id']]).encode()).decode()
        return {'items':items,'nextCursor':next_cursor}
    def patch_record(self,rid,expected_version,patch):
        record=self._raw(rid)
        if record.get('_trashed'):failure('TRASHED')
        if record['version']!=expected_version:failure('VERSION_CONFLICT')
        if not isinstance(patch,dict) or set(patch)-PATCH_FIELDS:failure('INVALID_PATCH')
        validate_fields(patch)
        if 'title' in patch and (not isinstance(patch['title'],str) or not patch['title'].strip() or len(patch['title'])>500):failure('INVALID_TITLE')
        if 'duration' in patch and (not isinstance(patch['duration'],(float,int)) or not math.isfinite(patch['duration']) or patch['duration']<0):failure('INVALID_DURATION')
        if 'transcript' in patch:patch={**patch,'transcript':self._transcript(record,patch['transcript'])}
        record.update(copy.deepcopy(patch));record['version']+=1
        return self._commit(record)
    def commit_segment(self,rid,track,index,staged_file,duration_frames,sha256,format_info=None):
        record=self._raw(rid)
        if record.get('_trashed'):failure('TRASHED')
        if track not in ['mic','system','mix','original']:failure('INVALID_TRACK')
        if not isinstance(index,int) or index<0 or index>999999 or not isinstance(duration_frames,int) or duration_frames<0:failure('INVALID_SEGMENT')
        if not isinstance(sha256,str) or not re.fullmatch('[a-f0-9]{64}',sha256):failure('CHECKSUM')
        source=Path(staged_file).absolute();reject_links(source)
        if source.parent.resolve()!=confined(self.root,'.staging').resolve() or not source.is_file():failure('UNSAFE_PATH')
        if digest(source)!=sha256:failure('CHECKSUM')
        previous=next((p for p in record['_segments'] if p['track']==track and p['index']==index),None)
        if previous:
            if previous['sha256']!=sha256 or previous['frames']!=duration_frames:failure('SEGMENT_CONFLICT')
            source.unlink();return {'recordId':rid,'track':track,'index':index,'sha256':sha256,'committedFrames':sum(p['frames'] for p in record['_segments'] if p['track']==track),'version':record['version']}
        parts=[p for p in record['_segments'] if p['track']==track]
        if index!=len(parts):failure('SEQUENCE')
        if shutil.disk_usage(self.root).free<source.stat().st_size+16*1024*1024:failure('DISK_FULL')
        relative=Path('records')/rid/'original'/track/f'{index:06}.part';target=confined(self.root,*relative.parts)
        if target.exists() and digest(target)!=sha256:failure('SEGMENT_CONFLICT')
        size=source.stat().st_size
        record['_segments'].append({'track':track,'index':index,'frames':duration_frames,'sha256':sha256,'path':relative.as_posix(),'bytes':size,**(format_info or {})})
        record['size']+=size;record['version']+=1
        record['tracks']=[{'id':name,'frames':sum(p['frames'] for p in record['_segments'] if p['track']==name),'segmentCount':sum(p['track']==name for p in record['_segments'])} for name in dict.fromkeys(p['track'] for p in record['_segments'])]
        for descriptor in record['tracks']:
            part_source=next(p for p in record['_segments'] if p['track']==descriptor['id'])
            descriptor.update({key:part_source[key] for key in ['sampleRate','channels'] if key in part_source});descriptor['gaps']=[gap for gap in record.get('gapMarkers',[]) if gap.get('track',descriptor['id'])==descriptor['id']]
        # Reject the complete proposed DTO before moving the only staged source.
        self._validate_commit(record)
        target.parent.mkdir(parents=True,exist_ok=True)
        with source.open('r+b') as stream:stream.flush();os.fsync(stream.fileno())
        publish(source,target)
        self._commit(record)
        return {'recordId':rid,'track':track,'index':index,'sha256':sha256,'committedFrames':sum(p['frames'] for p in record['_segments'] if p['track']==track),'version':record['version']}
    def trash(self,rid,expected_version):
        record=self._raw(rid)
        if record['version']!=expected_version:failure('VERSION_CONFLICT')
        record['_trashed']=True;record['version']+=1;record['_trashedAt']=now();return self._commit(record)
    def restore(self,rid,expected_version):
        record=self._raw(rid)
        if record['version']!=expected_version:failure('VERSION_CONFLICT')
        record['_trashed']=False;record['version']+=1;return self._commit(record)
    def audio_descriptor(self,rid,variant='original'):
        record=self._raw(rid)
        if record.get('_trashed'):failure('TRASHED')
        if record.get('_damaged'):failure('AUDIO_DAMAGED')
        if record['status']=='migrating':failure('MIGRATION_INCOMPLETE')
        if variant!='original':failure('VARIANT_NOT_READY')
        if '_capture' in record:failure('PREPARATION_REQUIRED')
        tracks={part['track'] for part in record['_segments']}
        track=next((name for name in ['mix','original','mic','system'] if name in tracks),None)
        if track is None:failure('AUDIO_NOT_FOUND')
        parts=sorted((part for part in record['_segments'] if part['track']==track),key=lambda part:part['index'])
        if [p['index'] for p in parts]!=list(range(len(parts))):failure('SEQUENCE')
        files=[]
        for part in parts:
            file=confined(self.root,*Path(part['path']).parts)
            if not file.is_file() or file.stat().st_size!=part['bytes']:failure('AUDIO_DAMAGED')
            files.append({'path':str(file),'size':part['bytes'],'sha256':part['sha256']})
        return {'id':rid,'mime':record['mime'],'size':sum(p['bytes'] for p in parts),'files':files}
    def recover(self):
        self._settle_pending()
        report={'recovered':[],'interrupted':[],'corrupt':[],'orphans':0,'transcriptRecoveryErrors':[],'transcriptRecoveryWarnings':[]}
        for folder in confined(self.root,'records').iterdir():
            if not folder.is_dir():continue
            try:
                identifier(folder.name);file=confined(self.root,'records',folder.name,'record.json')
                record=json.loads(file.read_text(encoding='utf-8'))
                validate_record(record)
                if record['id']!=folder.name:failure('INVALID_ID')
                for part in record.get('_segments',[]):
                    audio=confined(self.root,*Path(part['path']).parts)
                    if not audio.is_file() or digest(audio)!=part['sha256']:failure('CHECKSUM')
            except (OSError,ValueError,KeyError,CoreError):
                report['corrupt'].append(folder.name)
                # Preserve the damaged source manifest and bytes for recovery.
                # Only the rebuildable index is marked unsafe for playback.
                try:
                    damaged=self._raw(folder.name);damaged['_damaged']=True;damaged['status']='damaged'
                    with self.db:self.db.execute('UPDATE records SET status=?,data=? WHERE id=?',('damaged',json.dumps(damaged,ensure_ascii=False),folder.name))
                except CoreError:pass
                continue
            # Repair failures are availability errors, not damaged source audio.
            # Retain pending state so a cached Library cannot bypass recovery.
            self._pending_commits.add(record['id'])
            try:
                if self._sync_transcript(record):report['transcriptRecoveryWarnings'].append({'recordId':record['id'],'code':'TRANSCRIPT_SOURCE_METADATA_UNAVAILABLE'})
                if 'transcript' in record:TranscriptJournal(self.root,record['id']).verify(record)
            except CoreError as error:
                if error.code not in HISTORY_ERRORS:raise
                self._transcript_errors[record['id']]=error.code
                report['transcriptRecoveryErrors'].append({'recordId':record['id'],'code':error.code})
            row=self.db.execute('SELECT version,data FROM records WHERE id=?',(record['id'],)).fetchone()
            indexed=json.loads(row[1]) if row else None
            if not row or indexed!=record:
                self._index_record(record);report['recovered'].append(record['id'])
            self._pending_commits.discard(record['id'])
            if record['status'] in ['requesting','recording','paused']:
                record['status']='interrupted';record['version']+=1;self._commit(record);report['interrupted'].append(record['id'])
        from local_core.capture_recovery import recover_capture
        report.update(recover_capture(self))
        # Count after replay: an adopted publication is no longer an orphan.
        for row in self.db.execute('SELECT data FROM records'):
            record=json.loads(row[0]);known={part['path'] for part in record['_segments']}
            for candidate in confined(self.root,'records',record['id']).glob('original/*/*.part'):
                reject_links(candidate)
                if candidate.relative_to(self.root).as_posix() not in known:report['orphans']+=1
        return report
