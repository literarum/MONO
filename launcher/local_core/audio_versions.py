"""Immutable prepared media. Source manifests never point at partial outputs."""
import hashlib,json,os,re,uuid,math
from pathlib import Path
from local_core.library import digest
from local_core.paths import atomic_json,confined,publish,reject_links
from local_core.protocol import CoreError

def fail(code):raise CoreError(code,code)
def sha(value):return isinstance(value,str) and re.fullmatch('[a-f0-9]{64}',value) is not None
def fingerprint(value):return hashlib.sha256(json.dumps(value,sort_keys=True,separators=(',',':')).encode('utf-8')).hexdigest()
def valid_analysis(value):
    keys={'schema','analysisVersion','duration','frames','sampleRate','channels','format','peak','rms','truePeak','clipping','silence','noiseHeuristic','loudness'}
    if not isinstance(value,dict) or set(value)!=keys or value['schema']!=1 or value['analysisVersion']!='audio-analysis-1' or value['noiseHeuristic'] is not None:return False
    nested={'format':{'codec','container'},'clipping':{'samples','fraction','threshold','heuristic'},'silence':{'seconds','fraction','thresholdDbFS','windowMs','heuristic'},'loudness':{'valid','integrated','range','threshold','reason'}}
    if any(not isinstance(value[key],dict) or set(value[key])!=fields for key,fields in nested.items()):return False
    def safe(item):
        if item is None or type(item) is bool:return True
        if type(item) in [int,float]:return math.isfinite(item) and abs(item)<=2**53-1
        if isinstance(item,str):return re.fullmatch('[a-z0-9_,.-]{1,128}',item) is not None
        if isinstance(item,dict):return all(safe(child) for child in item.values())
        return False
    numeric=lambda item:type(item) in [int,float] and math.isfinite(item)
    if not safe(value) or not all(type(value[key]) is int and value[key]>0 for key in ['frames','sampleRate','channels']) or not numeric(value['duration']) or value['duration']<=0:return False
    if not 8000<=value['sampleRate']<=384000 or not 1<=value['channels']<=64 or abs(value['duration']-value['frames']/value['sampleRate'])>1e-7:return False
    if any(item is not None and not numeric(item) for item in [value['peak'],value['rms'],value['truePeak']]):return False
    clip=value['clipping'];silence=value['silence'];loud=value['loudness']
    if type(clip['samples']) is not int or not 0<=clip['samples']<=value['frames']*value['channels'] or any(not numeric(clip[key]) for key in ['fraction','threshold']) or not 0<=clip['fraction']<=1 or not 0<clip['threshold']<=1 or clip['heuristic'] is not True:return False
    if any(not numeric(silence[key]) for key in ['seconds','fraction','thresholdDbFS','windowMs']) or not 0<=silence['seconds']<=value['duration']+1e-7 or not 0<=silence['fraction']<=1 or silence['heuristic'] is not True:return False
    if type(loud['valid']) is not bool or loud['reason'] not in [None,'too-short','below-gate'] or any(loud[key] is not None and not numeric(loud[key]) for key in ['integrated','range','threshold']):return False
    return (loud['valid'] and loud['integrated'] is not None and loud['reason'] is None) or (not loud['valid'] and loud['integrated'] is None and loud['reason'] is not None)
class AudioVersions:
    def __init__(self,library):self.library=library
    def sources(self,rid):
        raw=self.library._raw(rid)
        if raw.get('_trashed'):fail('TRASHED')
        if raw.get('_damaged'):fail('AUDIO_DAMAGED')
        if raw['status'] in ['requesting','recording','paused','importing','migrating']:fail('SOURCE_BUSY')
        parts=raw['_segments']
        if not parts:fail('AUDIO_NOT_FOUND')
        files=[]
        for part in parts:
            file=confined(self.library.root,*Path(part['path']).parts)
            if not file.is_file() or file.stat().st_size!=part['bytes']:fail('AUDIO_DAMAGED')
            files.append({**part,'path':str(file),'size':part['bytes']})
        kind='native' if '_capture' in raw else 'container'
        identity={'kind':kind,'duration':raw['duration'],'mime':raw['mime'],'parts':parts}
        if kind=='container':return {'kind':kind,'sourceHash':fingerprint(identity),'duration':raw['duration'],'mime':raw['mime'],'files':files}
        origin=raw['_capture'].get('originMonotonicNs')
        if type(origin) is not int or origin<0:fail('INVALID_SOURCE')
        tracks=[]
        for name in ['mic','system']:
            rows=[part for part in files if part['track']==name]
            if not rows:continue
            selected=[]
            for part in rows:
                if any(type(part.get(key)) is not int for key in ['sampleRate','channels','startMonotonicNs','endMonotonicNs']):fail('INVALID_SOURCE')
                selected.append({**part,'start':(part['startMonotonicNs']-origin)/1e9,'end':(part['endMonotonicNs']-origin)/1e9})
            tracks.append({'id':name,'sampleRate':rows[0]['sampleRate'],'channels':rows[0]['channels'],'parts':selected})
        if not tracks or sum(len(track['parts']) for track in tracks)!=len(parts):fail('INVALID_SOURCE')
        return {'kind':kind,'sourceHash':fingerprint(identity),'duration':raw['duration'],'tracks':tracks}
    def sources_file(self,rid):
        spec=self.sources(rid);token=str(uuid.uuid4());file=confined(self.library.root,'.staging',token+'.part');atomic_json(file,spec)
        return {'id':token,'path':str(file),'size':file.stat().st_size}
    def _metadata(self,meta):
        keys={'id','sourceHash','pipelineVersion','profile','parametersHash','frames','sampleRate','channels','mime'}
        if not isinstance(meta,dict) or set(meta) not in [keys,keys|{'analysisJson','analysisHash'}] or any(not sha(meta[key]) for key in ['id','sourceHash','parametersHash']):fail('INVALID_AUDIO_VERSION')
        if not isinstance(meta['pipelineVersion'],str) or not re.fullmatch('[a-z0-9.-]{1,100}',meta['pipelineVersion']) or meta['profile'] not in ['original','gentle','level','quiet','speech','denoise'] or meta['mime']!='audio/flac':fail('INVALID_AUDIO_VERSION')
        for key,minimum,maximum in [('frames',1,2**53-1),('sampleRate',8000,384000),('channels',1,64)]:
            if type(meta[key]) is not int or not minimum<=meta[key]<=maximum:fail('INVALID_AUDIO_VERSION')
        identity=[meta[key] for key in ['sourceHash','pipelineVersion','profile','parametersHash']]
        if hashlib.sha256(json.dumps(identity,separators=(',',':')).encode()).hexdigest()!=meta['id']:fail('INVALID_AUDIO_VERSION')
        if 'analysisJson' in meta:
            raw=meta['analysisJson']
            if not isinstance(raw,str) or len(raw.encode())>16000 or not sha(meta['analysisHash']) or hashlib.sha256(raw.encode()).hexdigest()!=meta['analysisHash']:fail('INVALID_AUDIO_ANALYSIS')
            try:report=json.loads(raw)
            except (TypeError,ValueError):fail('INVALID_AUDIO_ANALYSIS')
            if not isinstance(report,dict) or set(report)!={'original','prepared'} or not all(valid_analysis(value) for value in report.values()) or any(report['prepared'][key]!=meta[key] for key in ['frames','sampleRate','channels']):fail('INVALID_AUDIO_ANALYSIS')
        return meta
    def _paths(self,rid,version_id):
        if not sha(version_id):fail('INVALID_AUDIO_VERSION')
        folder=confined(self.library.root,'records',rid,'derived',version_id)
        return folder,confined(folder,'version.json'),confined(folder,'audio.flac')
    def _descriptor(self,rid,stored):
        _,_,audio=self._paths(rid,stored['id'])
        if type(stored.get('bytes')) is not int or not 1<=stored['bytes']<=32*1024**3 or not sha(stored.get('audioSha256')) or not audio.is_file() or audio.stat().st_size!=stored['bytes'] or digest(audio)!=stored['audioSha256']:fail('AUDIO_VERSION_DAMAGED')
        result={'id':rid,'versionId':stored['id'],'sourceHash':stored['sourceHash'],'mime':'audio/flac','size':stored['bytes'],'frames':stored['frames'],'sampleRate':stored['sampleRate'],'channels':stored['channels'],'files':[{'path':str(audio),'size':stored['bytes'],'sha256':stored['audioSha256']}]}
        if 'analysisJson' in stored:result.update(profile=stored['profile'],pipelineVersion=stored['pipelineVersion'],parametersHash=stored['parametersHash'],analysisHash=stored['analysisHash'],analysis=json.loads(stored['analysisJson']))
        return result
    def get(self,rid,version_id,source_hash):
        current=self.sources(rid)
        if current['sourceHash']!=source_hash:fail('STALE_AUDIO_VERSION')
        _,manifest,_=self._paths(rid,version_id)
        if not manifest.exists():return None
        try:
            if manifest.stat().st_size>10000:fail('AUDIO_VERSION_DAMAGED')
            stored=json.loads(manifest.read_text(encoding='utf-8'))
            if not isinstance(stored,dict) or set(stored)-{'schema','bytes','audioSha256','id','sourceHash','pipelineVersion','profile','parametersHash','frames','sampleRate','channels','mime','analysisJson','analysisHash'} or stored.get('schema')!=1:fail('AUDIO_VERSION_DAMAGED')
            self._metadata({key:value for key,value in stored.items() if key not in ['schema','bytes','audioSha256']})
        except (ValueError,TypeError,KeyError):fail('AUDIO_VERSION_DAMAGED')
        if stored['id']!=version_id or stored['sourceHash']!=source_hash:fail('STALE_AUDIO_VERSION')
        return self._descriptor(rid,stored)
    def commit(self,rid,meta,staged_file,audio_sha):
        self._metadata(meta)
        if not sha(audio_sha):fail('CHECKSUM')
        source=self.sources(rid)
        if source['sourceHash']!=meta['sourceHash']:fail('STALE_AUDIO_VERSION')
        staged=Path(staged_file).absolute();reject_links(staged)
        if staged.parent.resolve()!=confined(self.library.root,'.staging').resolve() or not staged.is_file() or not 4<=staged.stat().st_size<=32*1024**3:fail('UNSAFE_PATH')
        if digest(staged)!=audio_sha:fail('CHECKSUM')
        with staged.open('rb') as file:
            if file.read(4)!=b'fLaC':fail('INVALID_AUDIO_VERSION')
        folder,manifest,audio=self._paths(rid,meta['id']);stored={**meta,'schema':1,'bytes':staged.stat().st_size,'audioSha256':audio_sha}
        if manifest.exists():
            existing=self.get(rid,meta['id'],meta['sourceHash'])
            if json.loads(manifest.read_text(encoding='utf-8'))!=stored:fail('AUDIO_VERSION_CONFLICT')
            staged.unlink();return existing
        if audio.exists() and digest(audio)!=audio_sha:fail('AUDIO_VERSION_CONFLICT')
        folder.mkdir(parents=True,exist_ok=True)
        with staged.open('r+b') as file:file.flush();os.fsync(file.fileno())
        publish(staged,audio);atomic_json(manifest,stored)
        return self._descriptor(rid,stored)
