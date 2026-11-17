"""At-least-once browser copy journal, persisted in each record manifest."""
import copy,hashlib,json,math,re
from local_core.paths import identifier
from local_core.protocol import CoreError

def fail(code):raise CoreError(code,code)
META_FIELDS={'id','title','createdAt','duration','mime','source','size','status','estimatedUSD','completedAt','chunkCount','peaks','gapMarkers'}

class Migration:
    def __init__(self,library):self.library=library
    def begin(self,params):
        source=identifier(params.get('sourceId'));meta=params.get('meta');count=params.get('expectedParts');text_hash=params.get('transcriptHash')
        if not isinstance(meta,dict) or set(meta)-META_FIELDS or type(count) is not int or not 1<=count<=200000:fail('INVALID_MIGRATION')
        rid=identifier(meta.get('id'))
        if not isinstance(meta.get('title'),str) or not meta['title'].strip() or len(meta['title'])>500 or not isinstance(meta.get('mime'),str) or len(meta['mime'])>100:fail('INVALID_MIGRATION')
        if type(meta.get('size')) is not int or not 0<meta['size']<=32*1024**3:fail('INVALID_MIGRATION')
        if type(meta.get('duration',0)) not in [int,float] or not math.isfinite(meta.get('duration',0)) or meta.get('duration',0)<0:fail('INVALID_MIGRATION')
        if text_hash is not None and (not isinstance(text_hash,str) or not re.fullmatch('[a-f0-9]{64}',text_hash)):fail('INVALID_MIGRATION')
        fingerprint=hashlib.sha256(json.dumps({'meta':meta,'count':count,'text':text_hash},ensure_ascii=False,sort_keys=True,separators=(',',':')).encode('utf-8')).hexdigest()
        try:record=self.library._raw(rid)
        except CoreError as error:
            if error.code!='NOT_FOUND':raise
            record=None
        if record:
            journal=record.get('_migration',{})
            if record.get('_trashed'):fail('TRASHED')
            if journal.get('sourceId')!=source or journal.get('fingerprint')!=fingerprint:fail('MIGRATION_CONFLICT')
        else:
            journal={'sourceId':source,'fingerprint':fingerprint,'expectedParts':count,'transcriptHash':text_hash,'complete':False,'meta':copy.deepcopy(meta)}
            self.library.create_record({**meta,'status':'migrating'},migration=journal);record=self.library._raw(rid)
        return {'record':self.library.metadata(rid),'complete':record['_migration']['complete'],'committedParts':len(record['_segments'])}
    def record(self,rid):
        record=self.library._raw(rid)
        if record.get('_trashed'):fail('TRASHED')
        if '_migration' not in record:fail('INVALID_MIGRATION')
        return record
    def part(self,rid,index,file,sha256):
        record=self.record(rid)
        if type(index) is not int or not 0<=index<record['_migration']['expectedParts']:fail('INVALID_SEGMENT')
        return self.library.commit_segment(rid,'original',index,file,0,sha256)
    def transcript(self,rid,file,sha256):
        record=self.record(rid);journal=record['_migration']
        if sha256!=journal['transcriptHash']:fail('MIGRATION_CONFLICT')
        if journal['complete']:return self.library.metadata(rid)
        self.library.commit_transcript(rid,record['version'],file)
        record=self.record(rid);record['_migration']['transcriptCommitted']=True;record['version']+=1;self.library._commit(record)
        return self.library.metadata(rid)
    def finish(self,rid):
        record=self.record(rid);journal=record['_migration']
        if journal['complete']:return self.library.metadata(rid)
        if len(record['_segments'])!=journal['expectedParts'] or record['size']!=journal['meta']['size'] or journal['transcriptHash'] and not journal.get('transcriptCommitted'):fail('MIGRATION_INCOMPLETE')
        meta=copy.deepcopy(journal['meta']);meta.pop('id');meta.pop('size')
        status=meta.pop('status','saved')
        if status in ['recording','queued','processing','uploading']:status='interrupted'
        if status=='completed' and not record.get('transcript'):status='saved'
        record.update(meta);record['status']=status;record['_migration']['complete']=True;record['version']+=1;self.library._commit(record)
        return self.library.metadata(rid)
