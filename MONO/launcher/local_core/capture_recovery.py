"""Replay only durable native-capture intents; never infer successful capture."""
import json,os,re
from local_core.paths import confined,identifier,publish
from local_core.protocol import CoreError

def invalid():raise CoreError('INVALID_CAPTURE_JOURNAL','INVALID_CAPTURE_JOURNAL')
def recover_capture(library):
    from local_core.capture import wave_descriptor,integer
    from local_core.library import digest
    recovered=[];errors=[]
    for journal in sorted(confined(library.root,'journal').glob('capture-*.json')):
        try:
            journal=confined(library.root,'journal',journal.name)
            if journal.stat().st_size>16384:invalid()
            value=json.loads(journal.read_text(encoding='utf-8'))
            if not isinstance(value,dict) or set(value)!={'recordId','sessionId','track','index','stagingId','sha256','frames','metadata'}:invalid()
            rid=identifier(value['recordId']);session=identifier(value['sessionId']);stage=identifier(value['stagingId']);track=value['track'];index=value['index'];sha=value['sha256'];frames=value['frames'];metadata=value['metadata']
            if track not in ['mic','system'] or not integer(index) or index>999999 or not integer(frames,1) or not isinstance(sha,str) or not re.fullmatch('[a-f0-9]{64}',sha):invalid()
            if journal.name!=f'capture-{session}-{track}-{index}.json':invalid()
            keys={'sampleRate','channels','bitsPerSample','formatTag','startMonotonicNs','endMonotonicNs'}
            if not isinstance(metadata,dict) or set(metadata)!=keys or any(not integer(n) for n in metadata.values()):invalid()
            raw=library._raw(rid);capture=raw.get('_capture',{});origin=capture.get('originMonotonicNs');directory=capture.get('sessionDirectory')
            if raw.get('_trashed') or raw.get('_damaged') or capture.get('sessionId')!=session or capture.get('mode') not in [track,'both'] or not integer(origin):invalid()
            if not isinstance(directory,str) or not re.fullmatch(r'\.staging/capture-[a-f0-9-]{36}',directory):invalid()
            identifier(directory.removeprefix('.staging/capture-'))
            start=metadata['startMonotonicNs'];end=metadata['endMonotonicNs'];rate=metadata['sampleRate']
            if start<origin or start-origin>30*86400*10**9 or end<=start or not 8000<=rate<=384000:invalid()
            nominal=round(frames*1e9/rate)
            if abs(end-start-nominal)>max(2_000_000,nominal//20):invalid()
            existing=next((part for part in raw['_segments'] if part['track']==track and part['index']==index),None)
            if existing and (existing['sha256']!=sha or existing['frames']!=frames or any(existing.get(k)!=v for k,v in metadata.items())):invalid()
            if not existing and raw['status'] not in ['interrupted','requesting','recording','paused']:invalid()
            prior=[part for part in raw['_segments'] if part['track']==track and part['index']<index]
            if len(prior)!=index or prior and any(prior[0].get(k)!=metadata[k] for k in ['sampleRate','channels','bitsPerSample','formatTag']):invalid()
            native=confined(library.root,*directory.split('/'),f'{track}-{index:06}.wav');staged=confined(library.root,'.staging',stage+'.part');target=confined(library.root,'records',rid,'original',track,f'{index:06}.part')
            candidates=[file for file in [staged,target,native] if file.exists()]
            if not candidates:invalid()
            for file in candidates:
                descriptor=wave_descriptor(file)
                if digest(file)!=sha or descriptor['frames']!=frames or any(descriptor[k]!=metadata[k] for k in ['sampleRate','channels','bitsPerSample','formatTag']):invalid()
            if not existing:
                if not staged.exists():
                    if native.exists():publish(native,staged)
                    else:
                        # Publication may precede the manifest. Preserve that orphan
                        # until the normal, hash-verified commit path adopts it.
                        with target.open('rb') as source,staged.open('xb') as output:
                            for block in iter(lambda:source.read(1024*1024),b''):output.write(block)
                            output.flush();os.fsync(output.fileno())
                library.commit_segment(rid,track,index,staged,frames,sha,format_info=metadata)
            raw=library._raw(rid);duration=max(raw['duration'],(end-origin)/1e9)
            if raw['duration']!=duration or raw['status'] in ['requesting','recording','paused']:
                raw['duration']=duration;raw['status']='interrupted';raw['version']+=1;library._commit(raw)
            journal.unlink()
            if rid not in recovered:recovered.append(rid)
        except (OSError,ValueError,KeyError,TypeError,CoreError):errors.append(journal.name)
    return {'captureRecovered':recovered,'captureRecoveryErrors':errors}
