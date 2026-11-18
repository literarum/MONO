"""One authoritative archive DTO validator, shared by writes and recovery."""
import math,re
from datetime import datetime
from local_core.paths import identifier
from local_core.protocol import CoreError

PATCH_FIELDS={'title','duration','mime','source','status','transcript','jobId','job','clientKey','serverAcked','completedAt','estimatedUSD','transcriptionStartedAt','importKey','gapMarkers','chunkCount','lastChunkAt','peaks','bookmarks'}
STATUSES={'saved','requesting','recording','paused','uploading','queued','processing','completed','failed','cancelled','interrupted','importing','migrating','damaged'}
TRACKS={'mic','system','mix','original'}
def invalid():raise CoreError('INVALID_RECORD','Проверьте данные записи')
def number(value,minimum=0):return type(value) in [int,float] and math.isfinite(value) and value>=minimum
def integer(value,minimum=0,maximum=2**53-1):return type(value) is int and minimum<=value<=maximum
def string(value,limit,empty=True):return isinstance(value,str) and len(value)<=limit and (empty or bool(value.strip()))
def stamp(value):
    if not string(value,64,False):return False
    try:datetime.fromisoformat(value);return True
    except ValueError:return False

def transcript(value):
    if not isinstance(value,dict) or set(value)-{'segments','rawText','model','language'}:invalid()
    segments=value.get('segments')
    if not isinstance(segments,list) or len(segments)>200000:invalid()
    for key,limit in [('rawText',32*1024**2),('model',200),('language',32)]:
        if key in value and not string(value[key],limit):invalid()
    for segment in segments:
        if not isinstance(segment,dict) or set(segment)-{'id','start','end','text','original'}:invalid()
        if not number(segment.get('start')) or not number(segment.get('end')) or segment['end']<segment['start'] or not string(segment.get('text'),20000):invalid()
        if 'original' in segment and not string(segment['original'],20000):invalid()
        if 'id' in segment and not (integer(segment['id']) or string(segment['id'],100,False)):invalid()

def gaps(value):
    if not isinstance(value,list) or len(value)>10000:invalid()
    for gap in value:
        if not isinstance(gap,dict) or set(gap)-{'start','end','reason','track'}:invalid()
        if not number(gap.get('start')) or not number(gap.get('end')) or gap['end']<gap['start'] or not string(gap.get('reason'),200,False):invalid()
        if 'track' in gap and gap['track'] not in TRACKS:invalid()

def fields(value):
    if not isinstance(value,dict):invalid()
    for key,limit,empty in [('title',500,False),('source',500,True),('clientKey',100,False),('importKey',200,False)]:
        if key in value and not string(value[key],limit,empty):invalid()
    if 'mime' in value and (not string(value['mime'],100,False) or not re.fullmatch(r'(?:audio/[a-zA-Z0-9.+-]+|video/mp4|application/octet-stream)(?:;\s*codecs="?[a-zA-Z0-9,. _-]+"?)?',value['mime'])):invalid()
    if 'status' in value and (not isinstance(value['status'],str) or value['status'] not in STATUSES):invalid()
    for key in ['duration','estimatedUSD','lastChunkAt']:
        if key in value and not number(value[key]):invalid()
    for key in ['createdAt','completedAt','transcriptionStartedAt']:
        if key in value and not stamp(value[key]):invalid()
    for key in ['chunkCount','size','version']:
        if key in value and not integer(value[key],1 if key=='version' else 0,1000000 if key=='chunkCount' else 2**53-1):invalid()
    if 'serverAcked' in value and type(value['serverAcked']) is not bool:invalid()
    if value.get('jobId') is not None:identifier(value['jobId'])
    if 'job' in value:
        job=value['job']
        if not isinstance(job,dict) or set(job)-{'stage','error','completed','total'}:invalid()
        if 'stage' in job and not string(job['stage'],1000):invalid()
        if job.get('error') is not None and not string(job['error'],2000):invalid()
        for key in ['completed','total']:
            if key in job and not integer(job[key],0,1000000):invalid()
    if 'peaks' in value and (not isinstance(value['peaks'],list) or len(value['peaks'])>500 or any(not number(n) or n>1 for n in value['peaks'])):invalid()
    if 'bookmarks' in value:
        marks=value['bookmarks']
        if not isinstance(marks,list) or len(marks)>1000:invalid()
        for mark in marks:
            if not isinstance(mark,dict) or set(mark)-{'at','label'} or not number(mark.get('at')) or ('label' in mark and not string(mark['label'],200)):invalid()
    if 'gapMarkers' in value:gaps(value['gapMarkers'])
    if 'transcript' in value:transcript(value['transcript'])

def record(value):
    if not isinstance(value,dict):invalid()
    required={'id','title','createdAt','duration','mime','size','source','status','version','tracks','_segments'}
    optional=PATCH_FIELDS|{'_trashed','_trashedAt','_damaged','_migration','_capture'}
    if not required<=set(value) or set(value)-required-optional:invalid()
    rid=identifier(value['id']);fields(value)
    for key in ['_trashed','_damaged']:
        if key in value and type(value[key]) is not bool:invalid()
    if '_trashedAt' in value and not stamp(value['_trashedAt']):invalid()
    parts=value['_segments'];tracks=value['tracks']
    if not isinstance(parts,list) or len(parts)>1000000 or not isinstance(tracks,list) or len(tracks)>4:invalid()
    grouped={};size=0
    for part in parts:
        required_part={'track','index','frames','sha256','path','bytes'};format_fields={'sampleRate','channels','bitsPerSample','formatTag','startMonotonicNs','endMonotonicNs'}
        if not isinstance(part,dict) or not required_part<=set(part) or set(part)-required_part-format_fields:invalid()
        for key in format_fields:
            if key in part and not integer(part[key],0 if key in ['startMonotonicNs','endMonotonicNs'] else 1,2**63-1 if key in ['startMonotonicNs','endMonotonicNs'] else 2**53-1):invalid()
        if 'endMonotonicNs' in part and part['endMonotonicNs']<=part.get('startMonotonicNs',-1):invalid()
        track=part['track']
        if not isinstance(track,str) or track not in TRACKS or not integer(part['index'],0,999999) or not integer(part['frames']) or not integer(part['bytes'],1):invalid()
        if not isinstance(part['sha256'],str) or not re.fullmatch('[a-f0-9]{64}',part['sha256']):invalid()
        if part['path']!=f"records/{rid}/original/{track}/{part['index']:06}.part":invalid()
        grouped.setdefault(track,[]).append(part);size+=part['bytes']
    if size!=value['size']:invalid()
    if {track.get('id') for track in tracks if isinstance(track,dict)}!=set(grouped):invalid()
    if len(tracks)!=len(grouped):invalid()
    for track in tracks:
        if not isinstance(track,dict) or set(track)-{'id','frames','segmentCount','sampleRate','channels','gaps'}:invalid()
        rows=grouped[track['id']]
        if [part['index'] for part in rows]!=list(range(len(rows))) or track.get('frames')!=sum(part['frames'] for part in rows) or track.get('segmentCount')!=len(rows):invalid()
        if 'sampleRate' in track and not integer(track['sampleRate'],0,768000):invalid()
        if 'channels' in track and not integer(track['channels'],0,64):invalid()
        if 'gaps' in track:gaps(track['gaps'])
    if '_migration' in value:
        journal=value['_migration']
        if not isinstance(journal,dict):invalid()
        identifier(journal.get('sourceId'))
        if not isinstance(journal.get('fingerprint'),str) or not re.fullmatch('[a-f0-9]{64}',journal['fingerprint']) or type(journal.get('complete')) is not bool or not integer(journal.get('expectedParts'),1,200000):invalid()
        fields(journal.get('meta'))
    if '_capture' in value:
        capture=value['_capture']
        if not isinstance(capture,dict):invalid()
        identifier(capture.get('sessionId'))
        if capture.get('mode') not in ['mic','system','both']:invalid()
        for key in ['inputId','outputId']:
            if capture.get(key) is not None and not string(capture[key],4096,False):invalid()
        if 'originMonotonicNs' in capture and not integer(capture['originMonotonicNs'],maximum=2**63-1):invalid()
