"""Additive transcript provenance: immutable content and committed revision references.

The record manifest remains the commit point. Nothing here is a user-authentication
or tamper-proof encryption mechanism; hashes bind recoverable archive content.
"""
import hashlib,json,re
from local_core.paths import atomic_json,confined,reject_links
from local_core.protocol import CoreError
from local_core.schema import transcript as validate_transcript,integer,stamp

MAX_OBJECT=128*1024**2
MAX_REVISIONS=1000000
HASH=re.compile('[a-f0-9]{64}')
NAME=re.compile(r'([0-9a-f]{16})-([a-f0-9]{64})\.json')
ERRORS={'TRANSCRIPT_HISTORY_DAMAGED','TRANSCRIPT_HISTORY_CONFLICT','TRANSCRIPT_HISTORY_LIMIT'}

def fail(code='TRANSCRIPT_HISTORY_DAMAGED'):
    raise CoreError(code,'История расшифровки требует восстановления из резервной копии.')

def fingerprint(value):
    return hashlib.sha256(json.dumps(value,sort_keys=True,ensure_ascii=False,separators=(',',':')).encode('utf-8')).hexdigest()

def source_of(value):return {**value,'segments':[{**row,'text':row.get('original',row['text'])} for row in value['segments']]}

def projection(file):
    if not file.exists():return None
    if file.stat().st_size>MAX_OBJECT:fail('TRANSCRIPT_HISTORY_LIMIT')
    try:
        value=json.loads(file.read_text(encoding='utf-8'));validate_transcript(value);return value
    except (ValueError,UnicodeError,CoreError):return None

class TranscriptJournal:
    def __init__(self,root,rid):self.folder=confined(root,'records',rid,'transcripts');self.rid=rid
    def entries(self,record,previous=None,full=True):
        directory=confined(self.folder,'revisions')
        if not directory.exists():return []
        def path(version,digest):return confined(directory,f'{version:016x}-{digest}.json')
        file=path(record['version'],fingerprint(record))
        if not file.exists():
            if previous is not None and 'transcript' not in previous:return []
            prior=path(previous['version'],fingerprint(previous)) if previous is not None else None
            if prior is not None and prior.exists():file=prior
            else:
                # Only for a missing head/index: preserve ambiguity rather than
                # choosing an arbitrary old/future branch as original metadata.
                candidates=[];count=0
                for candidate in directory.iterdir():
                    reject_links(candidate);count+=1
                    if count>MAX_REVISIONS:fail('TRANSCRIPT_HISTORY_LIMIT')
                    match=NAME.fullmatch(candidate.name)
                    if match and int(match[1],16)<record['version']:candidates.append((int(match[1],16),candidate))
                if not candidates:return []
                latest=max(v for v,_ in candidates);heads=[p for v,p in candidates if v==latest]
                if len(heads)!=1:fail('TRANSCRIPT_HISTORY_CONFLICT')
                file=heads[0]
        rows=[];ceiling=record['version']+1
        while True:
            reject_links(file);match=NAME.fullmatch(file.name)
            if not match or not file.is_file():fail()
            version=int(match[1],16)
            if not 1<=version<ceiling:fail()
            if len(rows)>=MAX_REVISIONS:fail('TRANSCRIPT_HISTORY_LIMIT')
            if file.stat().st_size>8192:fail('TRANSCRIPT_HISTORY_LIMIT')
            try:row=json.loads(file.read_text(encoding='utf-8'))
            except (ValueError,UnicodeError):fail()
            keys={'schema','recordId','version','recordSha256','sourceSha256','transcriptSha256','recordCreatedAt','parent','sourceMetadataUnavailable'}
            if not isinstance(row,dict) or set(row)!=keys or type(row['schema']) is not int or row['schema']!=1 or row['recordId']!=self.rid:fail()
            if not integer(row['version'],1) or row['version']!=version or row['recordSha256']!=match[2] or not stamp(row['recordCreatedAt']):fail()
            if any(not isinstance(row[key],str) or not HASH.fullmatch(row[key]) for key in ['sourceSha256','transcriptSha256','recordSha256']):fail()
            if type(row['sourceMetadataUnavailable']) is not bool:fail()
            rows.append(row)
            parent=row['parent']
            if parent is None:break
            if not isinstance(parent,dict) or set(parent)!={'version','recordSha256'} or not integer(parent['version'],1,version-1) or not isinstance(parent['recordSha256'],str) or not HASH.fullmatch(parent['recordSha256']):fail()
            if not full:break
            ceiling=version;file=path(parent['version'],parent['recordSha256'])
        return list(reversed(rows))
    def object(self,digest,candidates=(),repair=False):
        file=confined(self.folder,'objects',digest+'.json')
        present=projection(file)
        if present is not None and fingerprint(present)==digest:return present
        for value in candidates:
            if value is not None and fingerprint(value)==digest:
                if repair:atomic_json(file,value)
                return value
        fail()
    def source(self,record,previous=None):
        derived=source_of(record['transcript']);existing=projection(confined(self.folder,'original.json'))
        rows=self.entries(record,previous,full=False)
        # Prefer an exact committed manifest/index anchor over older branches.
        anchors=[row for row in rows if row['version']==record['version'] or previous is not None and row['version']==previous['version']]
        if anchors:rows=[max(anchors,key=lambda row:row['version'])]
        elif previous is not None and 'transcript' not in previous:rows=[];existing=None
        if rows:
            sources={row['sourceSha256'] for row in rows}
            if len(sources)!=1:fail('TRANSCRIPT_HISTORY_CONFLICT')
            source=self.object(next(iter(sources)),[existing,derived])
            if source['segments']!=derived['segments']:fail('TRANSCRIPT_HISTORY_CONFLICT')
            return source
        if existing is not None and existing['segments']==derived['segments']:return existing
        # A legacy archive may have already lost all first model/language/rawText
        # copies. Preserve known segment origins; do not call late metadata first.
        return derived if previous is not None and 'transcript' not in previous else {'segments':derived['segments']}
    def publish(self,record,source,previous=None):
        value=record['transcript'];source_hash=fingerprint(source);value_hash=fingerprint(value);record_hash=fingerprint(record)
        # Immutable objects may be repaired from the exact canonical/projection
        # value, but never replaced with different content under the same hash.
        self.object(source_hash,[source],repair=True);self.object(value_hash,[value],repair=True)
        directory=confined(self.folder,'revisions');file=confined(directory,f"{record['version']:016x}-{record_hash}.json")
        rows=self.entries(record,previous,full=False);existing=[row for row in rows if row['version']==record['version']]
        if existing:
            if len(existing)!=1 or existing[0]['sourceSha256']!=source_hash or existing[0]['transcriptSha256']!=value_hash:fail('TRANSCRIPT_HISTORY_CONFLICT')
        else:
            atomic_json(file,{'schema':1,'recordId':self.rid,'version':record['version'],'recordSha256':record_hash,
                'sourceSha256':source_hash,'transcriptSha256':value_hash,'recordCreatedAt':record['createdAt'],
                'parent':{'version':rows[-1]['version'],'recordSha256':rows[-1]['recordSha256']} if rows else None,
                'sourceMetadataUnavailable':any(key in value and key not in source for key in ['model','language','rawText'])})
    def verify(self,record,inventory=None):
        rows=self.entries(record)
        if not rows:return
        if not any(row['version']==record['version'] and row['recordSha256']==fingerprint(record) for row in rows):fail()
        source=self.source(record);source_hash=fingerprint(source)
        groups={}
        for row in rows:groups.setdefault(row['version'],[]).append(row)
        for version,group in groups.items():
            selected=[row for row in group if row['sourceSha256']==source_hash]
            if len(selected)!=1:fail('TRANSCRIPT_HISTORY_CONFLICT')
            row=selected[0]
            current=self.object(row['transcriptSha256'])
            if row['sourceMetadataUnavailable']!=any(key in current and key not in source for key in ['model','language','rawText']):fail()
            for field in ['sourceSha256','transcriptSha256']:
                self.object(row[field])
                if inventory is not None:
                    name=f"records/{self.rid}/transcripts/objects/{row[field]}.json"
                    if name not in inventory:fail()
            if inventory is not None:
                name=f"records/{self.rid}/transcripts/revisions/{version:016x}-{row['recordSha256']}.json"
                if name not in inventory:fail()
