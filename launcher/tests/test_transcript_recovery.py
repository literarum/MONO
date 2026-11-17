"""Durable transcript commit point, with real file/SQLite/process boundaries."""
import errno
import hashlib
import json
import os
import sqlite3
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from local_core.library import Library
from local_core.protocol import CoreError
import local_core.paths as paths

LAUNCHER=Path(__file__).resolve().parents[1]
ORIGINAL='Исходный текст — проверка ё'
EDITED='Исправленный текст — точность'
AUDIO=b'isolated-original-audio\x00\x01\xff'

def transcript(text=ORIGINAL):
    return {'model':'fixture-v1','language':'ru','rawText':ORIGINAL,
            'segments':[{'id':7,'start':0.25,'end':1.75,'text':text,'original':ORIGINAL}]}

def read_json(file):return json.loads(file.read_text(encoding='utf-8'))

def projection_bytes(root,rid):
    return {file.name:file.read_bytes() for file in (root/'records'/rid/'transcripts').glob('*.json')}

CHILD=r'''
import hashlib,json,os,sys,uuid
from pathlib import Path
sys.path.insert(0,sys.argv[1])
from local_core.library import Library
import local_core.paths as paths
root=Path(sys.argv[2]);phase=sys.argv[3];editing=sys.argv[4]=='edit'
original='Исходный текст — проверка ё';edited='Исправленный текст — точность'
value={'model':'fixture-v1','language':'ru','rawText':original,'segments':[{'id':7,'start':0.25,'end':1.75,'text':original,'original':original}]}
lib=Library.open(root);record=lib.create_record({'title':'Transcript fault fixture'})
audio=b'isolated-original-audio\x00\x01\xff';stage=root/'.staging'/(str(uuid.uuid4())+'.part');stage.write_bytes(audio)
lib.commit_segment(record['id'],'original',0,stage,0,hashlib.sha256(audio).hexdigest())
record=lib.get_record(record['id'])
if editing:record=lib.patch_record(record['id'],record['version'],{'transcript':value})
print(json.dumps({'id':record['id'],'beforeVersion':record['version']}),flush=True)
publish=paths.publish
def fault(source,target):
    if phase=='before-manifest' and target.name=='record.json':os._exit(41)
    publish(source,target)
    if phase=='manifest' and target.name=='record.json':os._exit(41)
    if phase=='original' and target.name=='original.json':os._exit(41)
    if phase=='edits' and target.name=='edits.json':os._exit(41)
paths.publish=fault
class IndexBoundary:
    def __init__(self,db):self.db=db
    def __getattr__(self,name):return getattr(self.db,name)
    def __enter__(self):self.db.__enter__();return self
    def __exit__(self,*args):
        result=self.db.__exit__(*args)
        if phase=='index' and args[0] is None:os._exit(41)
        return result
lib.db=IndexBoundary(lib.db)
value['segments'][0]['text']=edited if editing else original
record=lib.patch_record(record['id'],record['version'],{'transcript':value})
print(json.dumps({'ackVersion':record['version']}),flush=True)
sys.stdin.read()
lib.close()
'''

class TranscriptRecoveryTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.root=Path(self.temp.name)/'library'
        self.lib=Library.open(self.root);self.rec=self.lib.create_record({'title':'Isolated transcript'})
    def tearDown(self):
        self.lib.close();self.temp.cleanup()
    def test_rejected_full_record_never_publishes_transcript_files(self):
        for existing in [False,True]:
            with self.subTest(existing=existing):
                if existing:self.rec=self.lib.patch_record(self.rec['id'],self.rec['version'],{'transcript':transcript()})
                before=projection_bytes(self.root,self.rec['id'])
                manifest=self.lib.manifest(self.rec['id']).read_bytes()
                with self.assertRaisesRegex(CoreError,'INVALID_RECORD_SIZE'):
                    self.lib.patch_record(self.rec['id'],self.rec['version'],{
                        'transcript':transcript(EDITED),
                        'gapMarkers':[{'start':0,'end':1,'reason':'x'*100} for _ in range(500)]})
                self.assertEqual(projection_bytes(self.root,self.rec['id']),before)
                self.assertEqual(self.lib.manifest(self.rec['id']).read_bytes(),manifest)
                self.assertEqual(self.lib.get_record(self.rec['id']),self.rec)
    def test_unpublished_original_cannot_poison_first_real_transcript(self):
        folder=self.root/'records'/self.rec['id']/'transcripts';folder.mkdir()
        poisoned=transcript('Orphan');poisoned['segments'][0]['original']='Never committed'
        (folder/'original.json').write_text(json.dumps(poisoned),encoding='utf-8')
        updated=self.lib.patch_record(self.rec['id'],self.rec['version'],{'transcript':transcript(EDITED)})
        self.assertEqual(updated['transcript']['segments'][0]['original'],ORIGINAL)
        self.assertEqual(read_json(folder/'original.json')['segments'][0]['text'],ORIGINAL)
    def test_recovery_repairs_missing_and_stale_projections_even_when_index_is_current(self):
        updated=self.lib.patch_record(self.rec['id'],self.rec['version'],{'transcript':transcript(EDITED)})
        folder=self.root/'records'/self.rec['id']/'transcripts'
        (folder/'original.json').unlink();(folder/'edits.json').write_text('{}',encoding='utf-8')
        self.lib.close();self.lib=Library.open(self.root)
        self.assertEqual(self.lib.recover()['corrupt'],[])
        self.assertEqual(read_json(folder/'edits.json'),updated['transcript'])
        self.assertEqual(read_json(folder/'original.json')['segments'][0]['text'],ORIGINAL)
        before=projection_bytes(self.root,self.rec['id']);version=self.lib.get_record(self.rec['id'])['version']
        self.lib.recover();self.assertEqual(projection_bytes(self.root,self.rec['id']),before)
        self.assertEqual(self.lib.get_record(self.rec['id'])['version'],version)
    def test_failed_manifest_publication_keeps_previous_original_and_edits(self):
        self.rec=self.lib.patch_record(self.rec['id'],self.rec['version'],{'transcript':transcript()})
        before=projection_bytes(self.root,self.rec['id']);manifest=self.lib.manifest(self.rec['id']).read_bytes()
        publish=paths.publish
        def deny(source,target):
            if target.name=='record.json':raise PermissionError(errno.EACCES,'isolated publication denied')
            return publish(source,target)
        with patch.object(paths,'publish',side_effect=deny):
            with self.assertRaises(PermissionError):self.lib.patch_record(self.rec['id'],self.rec['version'],{'transcript':transcript(EDITED)})
        self.assertEqual(projection_bytes(self.root,self.rec['id']),before)
        self.assertEqual(self.lib.manifest(self.rec['id']).read_bytes(),manifest)
        self.assertEqual(self.lib.get_record(self.rec['id']),self.rec)
    def test_projection_disk_error_is_unacknowledged_and_next_operation_settles_manifest(self):
        publish=paths.publish
        def full(source,target):
            if target.name=='edits.json':raise OSError(errno.ENOSPC,'isolated disk-full fault')
            return publish(source,target)
        with patch.object(paths,'publish',side_effect=full):
            with self.assertRaises(OSError):self.lib.patch_record(self.rec['id'],self.rec['version'],{'transcript':transcript(EDITED)})
            committed=read_json(self.lib.manifest(self.rec['id']))
            self.assertEqual(committed['transcript'],transcript(EDITED))
            with self.assertRaises(OSError):self.lib.patch_record(self.rec['id'],committed['version'],{'title':'Must not acknowledge while full'})
        settled=self.lib.get_record(self.rec['id'])
        self.assertEqual(settled['transcript'],transcript(EDITED))
        self.assertEqual(settled['title'],self.rec['title'])
        changed=self.lib.patch_record(self.rec['id'],settled['version'],{'title':'After recovery'})
        self.assertEqual(changed['transcript'],transcript(EDITED))
        with self.assertRaisesRegex(CoreError,'VERSION_CONFLICT'):
            self.lib.patch_record(self.rec['id'],self.rec['version'],{'transcript':transcript('Stale')})
    def test_process_death_at_each_commit_boundary_recovers_exact_text_and_audio(self):
        self.lib.close()
        for operation in ['first','edit']:
            phases=['before-manifest','manifest','edits','index','ack']+(['original'] if operation=='first' else [])
            for phase in phases:
                with self.subTest(operation=operation,phase=phase),tempfile.TemporaryDirectory() as temp:
                    root=Path(temp)/'archive'
                    child=subprocess.Popen([sys.executable,'-c',CHILD,str(LAUNCHER),str(root),phase,operation],
                        stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,encoding='utf-8')
                    try:
                        started=json.loads(child.stdout.readline());rid=started['id']
                        if phase=='ack':
                            self.assertEqual(json.loads(child.stdout.readline())['ackVersion'],started['beforeVersion']+1)
                            child.kill()
                        child.wait(timeout=12)
                        self.assertIn(child.returncode,[-9,1] if phase=='ack' else [41],child.stderr.read())
                    finally:
                        if child.poll() is None:child.kill();child.wait(timeout=5)
                        child.stdin.close();child.stdout.close();child.stderr.close()
                    library=Library.open(root)
                    try:
                        report=library.recover();self.assertEqual(report['corrupt'],[])
                        recovered=library.get_record(rid)
                        after=phase!='before-manifest'
                        self.assertEqual(recovered['version'],started['beforeVersion']+int(after))
                        expected=EDITED if operation=='edit' and after else ORIGINAL
                        if operation=='first' and not after:self.assertNotIn('transcript',recovered)
                        else:
                            self.assertEqual(recovered['transcript'],transcript(expected))
                            folder=root/'records'/rid/'transcripts'
                            self.assertEqual(read_json(folder/'edits.json'),transcript(expected))
                            self.assertEqual(read_json(folder/'original.json')['segments'][0],transcript()['segments'][0])
                        descriptor=library.audio_descriptor(rid)
                        self.assertEqual(b''.join(Path(f['path']).read_bytes() for f in descriptor['files']),AUDIO)
                        self.assertEqual(descriptor['files'][0]['sha256'],hashlib.sha256(AUDIO).hexdigest())
                        library.recover();self.assertEqual(library.get_record(rid),recovered)
                    finally:library.close()

    def test_sqlite_failure_after_manifest_does_not_allow_stale_overwrite(self):
        database=self.lib.db
        class DeniedIndex:
            def __getattr__(self,name):return getattr(database,name)
            def __enter__(self):database.__enter__();return self
            def __exit__(self,*args):return database.__exit__(*args)
            def execute(self,sql,*args):
                if sql.startswith('INSERT INTO records'):raise sqlite3.OperationalError('isolated index fault')
                return database.execute(sql,*args)
        self.lib.db=DeniedIndex()
        with self.assertRaises(sqlite3.OperationalError):
            self.lib.patch_record(self.rec['id'],self.rec['version'],{'transcript':transcript(EDITED)})
        committed=read_json(self.lib.manifest(self.rec['id']))
        self.assertEqual(committed['transcript'],transcript(EDITED))
        with self.assertRaises(sqlite3.OperationalError):self.lib.list_records()
        self.lib.db=database
        settled=self.lib.list_records()['items'][0]
        self.assertEqual(settled['version'],committed['version'])
        self.assertEqual(self.lib.get_record(self.rec['id'])['transcript'],transcript(EDITED))

    def test_recovery_projection_write_failure_is_not_audio_corruption(self):
        self.rec=self.lib.patch_record(self.rec['id'],self.rec['version'],{'transcript':transcript(EDITED)})
        (self.root/'records'/self.rec['id']/'transcripts'/'edits.json').unlink()
        publish=paths.publish
        def deny(source,target):
            if target.name=='edits.json':raise PermissionError(errno.EACCES,'isolated projection denial')
            return publish(source,target)
        with patch.object(paths,'publish',side_effect=deny):
            with self.assertRaises(PermissionError):self.lib.recover()
            with self.assertRaises(PermissionError):self.lib.get_record(self.rec['id'])
        self.assertEqual(self.lib.get_record(self.rec['id']),self.rec)
        self.assertEqual(self.lib.recover()['corrupt'],[])

    def test_edits_keep_committed_source_identity_metadata_and_tombstone(self):
        self.rec=self.lib.patch_record(self.rec['id'],self.rec['version'],{'transcript':transcript()})
        folder=self.root/'records'/self.rec['id']/'transcripts'
        original=(folder/'original.json').read_bytes()
        changed=transcript(EDITED);changed['model']='later-model';changed['rawText']='later-raw'
        changed['segments'][0].update({'id':99,'original':'Attempted original replacement'})
        self.rec=self.lib.patch_record(self.rec['id'],self.rec['version'],{'transcript':changed})
        self.assertEqual((folder/'original.json').read_bytes(),original)
        self.assertEqual(self.rec['transcript']['segments'][0]['id'],7)
        self.assertEqual(self.rec['transcript']['segments'][0]['original'],ORIGINAL)
        before=projection_bytes(self.root,self.rec['id'])
        bad=transcript(EDITED);bad['segments'][0]['start']=0
        with self.assertRaisesRegex(CoreError,'ORIGINAL_CONFLICT'):
            self.lib.patch_record(self.rec['id'],self.rec['version'],{'transcript':bad})
        trashed=self.lib.trash(self.rec['id'],self.rec['version'])
        with self.assertRaisesRegex(CoreError,'TRASHED'):
            self.lib.patch_record(self.rec['id'],trashed['version'],{'transcript':transcript('Late job')})
        self.assertEqual(projection_bytes(self.root,self.rec['id']),before)

    def test_backup_cannot_snapshot_an_unsettled_transcript(self):
        from local_core.transfer import snapshot_library
        publish=paths.publish
        def full(source,target):
            if target.name=='edits.json':raise OSError(errno.ENOSPC,'isolated projection full')
            return publish(source,target)
        with patch.object(paths,'publish',side_effect=full):
            with self.assertRaises(OSError):self.lib.patch_record(self.rec['id'],self.rec['version'],{'transcript':transcript(EDITED)})
            with self.assertRaises(OSError):snapshot_library(self.lib)
        snapshot=snapshot_library(self.lib)
        self.assertIn(f"records/{self.rec['id']}/transcripts/edits.json",[entry['path'] for entry in snapshot['files']])
        self.assertEqual(self.lib.get_record(self.rec['id'])['transcript'],transcript(EDITED))

    def test_uncommitted_matching_original_cannot_supply_false_metadata(self):
        folder=self.root/'records'/self.rec['id']/'transcripts';folder.mkdir()
        orphan=transcript();orphan['model']='never-committed';orphan['rawText']='never-committed-raw'
        (folder/'original.json').write_text(json.dumps(orphan),encoding='utf-8')
        self.lib.patch_record(self.rec['id'],self.rec['version'],{'transcript':transcript()})
        self.assertEqual(read_json(folder/'original.json'),transcript())

if __name__=='__main__':unittest.main()
