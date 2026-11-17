"""Original provenance, immutable edit history, real files/copy and fault boundaries."""
import errno,hashlib,json,os,subprocess,sys,tempfile,unittest,uuid
from pathlib import Path
from unittest.mock import patch
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from local_core.library import Library
from local_core.protocol import CoreError
import local_core.paths as paths

def read(file):return json.loads(file.read_text(encoding='utf-8'))
def fingerprint(value):return hashlib.sha256(json.dumps(value,sort_keys=True,ensure_ascii=False,separators=(',',':')).encode('utf-8')).hexdigest()
def value(text='Original',model='first-model',language='ru',raw='First raw'):
    return {'model':model,'language':language,'rawText':raw,'segments':[{'id':7,'start':.25,'end':1.75,'text':text}]}

class TranscriptJournalTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.root=Path(self.temp.name)/'library';self.lib=Library.open(self.root)
        self.record=self.lib.create_record({'title':'Isolated journal'})
    def tearDown(self):self.lib.close();self.temp.cleanup()
    def change(self,transcript):
        self.record=self.lib.patch_record(self.record['id'],self.record['version'],{'transcript':transcript});return self.record
    @property
    def folder(self):return self.root/'records'/self.record['id']/'transcripts'
    def revisions(self):return sorted([read(file) for file in (self.folder/'revisions').glob('*.json')],key=lambda row:row['version'])
    def remove_index(self):
        self.lib.close()
        for name in ['library.sqlite3','library.sqlite3-wal','library.sqlite3-shm']:(self.root/name).unlink(missing_ok=True)
        self.lib=Library.open(self.root)
    def test_first_source_metadata_restores_after_later_metadata_projection_and_index_loss(self):
        self.change(value());original=read(self.folder/'original.json')
        self.change(value('Edited','late-model','en','Late raw'))
        (self.folder/'original.json').unlink();(self.folder/'edits.json').unlink();self.remove_index()
        self.assertEqual(self.lib.recover()['corrupt'],[])
        self.assertEqual(read(self.folder/'original.json'),original)
        self.assertEqual(read(self.folder/'edits.json'),self.record['transcript'])
        self.assertEqual(self.lib.get_record(self.record['id']),self.record)
        before={file.relative_to(self.folder).as_posix():file.read_bytes() for file in self.folder.rglob('*.json')}
        self.lib.recover();self.assertEqual(before,{file.relative_to(self.folder).as_posix():file.read_bytes() for file in self.folder.rglob('*.json')})
    def test_chronology_is_immutable_and_repeated_transcript_content_is_deduplicated(self):
        a=self.change(value());self.change(value('B'));self.record=self.lib.patch_record(self.record['id'],self.record['version'],{'title':'Only title changed'});self.change(value())
        rows=self.revisions();self.assertEqual([r['version'] for r in rows],list(range(a['version'],self.record['version']+1)))
        self.assertEqual(len(list((self.folder/'objects').glob('*.json'))),2)
        for row in rows:
            self.assertEqual(row['recordId'],self.record['id']);self.assertEqual(row['schema'],1)
            for field in ['sourceSha256','transcriptSha256']:
                snapshot=read(self.folder/'objects'/(row[field]+'.json'));self.assertEqual(fingerprint(snapshot),row[field])
        self.assertEqual(rows[-1]['recordSha256'],fingerprint(read(self.lib.manifest(self.record['id']))))
        self.assertEqual(rows[0]['transcriptSha256'],rows[-1]['transcriptSha256'])
    def test_verified_copy_and_merge_retain_history_and_first_source(self):
        from local_core.transfer import snapshot_library,copy_snapshot,merge_backup
        self.change(value());source=read(self.folder/'original.json');self.change(value('Edit','later','en','late'))
        snapshot=snapshot_library(self.lib);copied=Path(self.temp.name)/'backup';copy_snapshot(self.root,copied,snapshot)
        target=Path(self.temp.name)/'merged';other=Library.open(target)
        try:merge_backup(copied,target)
        finally:other.close()
        other=Library.open(target)
        try:
            transcript_folder=target/'records'/self.record['id']/'transcripts';(transcript_folder/'original.json').unlink()
            self.assertEqual(other.recover()['corrupt'],[]);self.assertEqual(read(transcript_folder/'original.json'),source)
            self.assertEqual(len(list((transcript_folder/'revisions').glob('*.json'))),2)
            for entry in snapshot['files']:
                if '/transcripts/' in entry['path']:self.assertEqual((target/entry['path']).read_bytes(),(self.root/entry['path']).read_bytes())
        finally:other.close()
    def test_damaged_source_is_reported_without_disabling_healthy_record_or_damaging_audio(self):
        self.change(value());self.change(value('Later','later','en','late'));rows=self.revisions();self.assertTrue(rows,'Missing durable journal')
        source=self.folder/'objects'/(rows[0]['sourceSha256']+'.json');source.write_text('{}',encoding='utf-8');(self.folder/'original.json').unlink()
        healthy=self.lib.create_record({'title':'Healthy neighbor'});self.lib.close();self.lib=Library.open(self.root)
        report=self.lib.recover();self.assertEqual(report['corrupt'],[])
        self.assertEqual(report['transcriptRecoveryErrors'],[{'recordId':self.record['id'],'code':'TRANSCRIPT_HISTORY_DAMAGED'}])
        self.assertEqual(self.lib.get_record(healthy['id']),healthy)
        self.assertEqual(self.lib.get_record(self.record['id'])['transcriptHistoryError'],'TRANSCRIPT_HISTORY_DAMAGED')
        before=self.lib.manifest(self.record['id']).read_bytes()
        with self.assertRaisesRegex(CoreError,'История'):self.lib.patch_record(self.record['id'],self.record['version'],{'title':'Must not commit'})
        self.assertEqual(self.lib.manifest(self.record['id']).read_bytes(),before)
        from local_core.transfer import snapshot_library
        with self.assertRaises(CoreError):snapshot_library(self.lib)
    def test_missing_past_edit_object_cannot_be_silently_omitted_from_backup(self):
        from local_core.transfer import snapshot_library,check_files
        self.change(value());self.change(value('Past edit'));past=self.revisions();self.assertEqual(len(past),2)
        self.change(value('Latest edit'));snapshot=snapshot_library(self.lib)
        old=self.folder/'objects'/(past[-1]['transcriptSha256']+'.json')
        omitted={**snapshot,'files':[row for row in snapshot['files'] if row['path']!=old.relative_to(self.root).as_posix()]}
        with self.assertRaises(CoreError):check_files(self.root,omitted)
        old.unlink()
        with self.assertRaises(CoreError):snapshot_library(self.lib)
    def test_uncommitted_future_revision_cannot_supply_source_or_block_next_version(self):
        folder=self.folder/'revisions';folder.mkdir(parents=True)
        fake={'schema':1,'recordId':self.record['id'],'version':2,'recordSha256':'a'*64,'sourceSha256':'b'*64,'transcriptSha256':'c'*64,'committedAt':'2026-10-22T00:00:00+00:00'}
        file=folder/(f"{2:016x}-"+'a'*64+'.json');file.write_text(json.dumps(fake),encoding='utf-8')
        self.change(value());self.assertEqual(read(self.folder/'original.json')['model'],'first-model');self.assertTrue(file.exists())
        self.change(value('Later'));self.assertEqual(self.lib.recover()['transcriptRecoveryErrors'],[]);self.assertTrue(file.exists())
    def test_missing_source_snapshot_repairs_only_from_matching_independent_projection(self):
        self.change(value());original=read(self.folder/'original.json');self.change(value('Edit','later','en','late'))
        rows=self.revisions();self.assertTrue(rows);snapshot=self.folder/'objects'/(rows[0]['sourceSha256']+'.json');snapshot.unlink()
        self.lib.recover();self.assertEqual(read(snapshot),original)
        self.assertEqual(read(self.folder/'original.json'),original)
    def test_disk_failure_after_manifest_is_unacknowledged_and_settled_before_reads_or_backup(self):
        self.change(value());real=paths.publish
        def full(source,target):
            if target.parent.name=='revisions':raise OSError(errno.ENOSPC,'isolated history disk full')
            return real(source,target)
        with patch.object(paths,'publish',side_effect=full):
            with self.assertRaises(OSError):self.change(value('Durable manifest'))
            from local_core.transfer import snapshot_library
            with self.assertRaises(OSError):snapshot_library(self.lib)
        actual=self.lib.get_record(self.record['id']);self.assertEqual(actual['transcript']['segments'][0]['text'],'Durable manifest')
        self.assertEqual(self.revisions()[-1]['version'],actual['version'])
    def test_recovery_reports_missing_old_edit_and_keeps_latest_text_readable(self):
        self.change(value());self.change(value('Old edit'));old=self.revisions()[-1]['transcriptSha256'];self.change(value('Latest'))
        (self.folder/'objects'/(old+'.json')).unlink()
        report=self.lib.recover()
        self.assertEqual(report['transcriptRecoveryErrors'],[{'recordId':self.record['id'],'code':'TRANSCRIPT_HISTORY_DAMAGED'}])
        self.assertEqual(report['corrupt'],[])
        self.assertEqual(self.lib.get_record(self.record['id'])['transcript']['segments'][0]['text'],'Latest')
    def test_current_manifest_anchor_beats_same_version_stale_sqlite(self):
        first=self.change(value());self.change(value('Latest','late','en','late'))
        stale={**read(self.lib.manifest(self.record['id'])),'transcript':first['transcript']}
        with self.lib.db:self.lib.db.execute('UPDATE records SET data=? WHERE id=?',(json.dumps(stale),self.record['id']))
        (self.folder/'original.json').unlink();self.lib.recover()
        self.assertEqual(read(self.folder/'original.json')['model'],'first-model')
        self.assertEqual(self.lib.get_record(self.record['id'])['transcript'],self.record['transcript'])
    def test_current_revision_required_in_backup_with_existing_history(self):
        from local_core.transfer import snapshot_library,check_files
        self.change(value());self.change(value('Latest'));snapshot=snapshot_library(self.lib)
        current=max((self.folder/'revisions').glob('*.json'));current.unlink()
        without={**snapshot,'files':[row for row in snapshot['files'] if row['path']!=current.relative_to(self.root).as_posix()]}
        with self.assertRaises(CoreError):check_files(self.root,without)
    def test_read_only_snapshot_namespace_uses_files_without_requiring_live_writer(self):
        from types import SimpleNamespace
        from local_core.transfer import snapshot_library
        self.change(value());self.change(value('Edited'))
        before={f.relative_to(self.root).as_posix():f.read_bytes() for f in self.root.rglob('*.json')}
        snapshot=snapshot_library(SimpleNamespace(root=self.root),check_active=False)
        self.assertTrue(any('/revisions/' in row['path'] for row in snapshot['files']))
        self.assertEqual(before,{f.relative_to(self.root).as_posix():f.read_bytes() for f in self.root.rglob('*.json')})
    def test_legacy_archive_without_source_metadata_does_not_fabricate_first_model(self):
        from local_core.schema import record as validate_record
        raw=read(self.lib.manifest(self.record['id']));raw['version']+=1
        raw['transcript']={**value('Edited','late-model','en','Late raw'),'segments':[{'id':7,'start':.25,'end':1.75,'text':'Edited','original':'Original'}]}
        validate_record(raw);paths.atomic_json(self.lib.manifest(raw['id']),raw);self.lib._index_record(raw)
        self.assertFalse(self.folder.exists(),'Fixture must be a valid legacy manifest/index without any journal or original projection')
        report=self.lib.recover();source=read(self.folder/'original.json')
        self.assertEqual(source,{'segments':[{'id':7,'start':.25,'end':1.75,'text':'Original','original':'Original'}]})
        self.assertEqual(report['transcriptRecoveryWarnings'],[{'recordId':raw['id'],'code':'TRANSCRIPT_SOURCE_METADATA_UNAVAILABLE'}])
        self.assertTrue(self.revisions()[0]['sourceMetadataUnavailable'])
        self.assertEqual(self.lib.get_record(raw['id'])['transcript'],raw['transcript'])
    def test_invalid_header_schema_cross_record_hash_and_size_fail_closed(self):
        self.change(value());file=next((self.folder/'revisions').glob('*.json'));original=file.read_bytes()
        for mutation in [{'schema':2},{'recordId':str(uuid.uuid4())},{'sourceSha256':'../../outside'}]:
            with self.subTest(mutation=mutation):
                file.write_text(json.dumps({**json.loads(original),**mutation}),encoding='utf-8')
                result=self.lib.recover();self.assertEqual(result['corrupt'],[])
                self.assertEqual(result['transcriptRecoveryErrors'][0]['code'],'TRANSCRIPT_HISTORY_DAMAGED')
                self.assertEqual(file.read_text(encoding='utf-8'),json.dumps({**json.loads(original),**mutation}))
                file.write_bytes(original);self.assertEqual(self.lib.recover()['transcriptRecoveryErrors'],[])
        file.write_bytes(original+b' '*8193)
        self.assertEqual(self.lib.recover()['transcriptRecoveryErrors'][0]['code'],'TRANSCRIPT_HISTORY_LIMIT')
    def test_failed_manifest_publish_never_creates_new_journal_content(self):
        self.change(value());before={f.relative_to(self.folder).as_posix():f.read_bytes() for f in self.folder.rglob('*.json')};real=paths.publish
        def deny(source,target):
            if target.name=='record.json':raise PermissionError(errno.EACCES,'isolated manifest denial')
            return real(source,target)
        with patch.object(paths,'publish',side_effect=deny):
            with self.assertRaises(PermissionError):self.change(value('Never committed','later'))
        self.assertEqual(before,{f.relative_to(self.folder).as_posix():f.read_bytes() for f in self.folder.rglob('*.json')})
    def test_real_process_cuts_at_journal_and_ack_boundaries_keep_source_edit_audio_and_version(self):
        self.lib.close();launcher=Path(__file__).resolve().parents[1]
        child_code=r'''
import hashlib,json,os,sys
from pathlib import Path
sys.path.insert(0,sys.argv[1])
from local_core.library import Library
import local_core.paths as paths
root=Path(sys.argv[2]);phase=sys.argv[3];editing=sys.argv[4]=='edit'
lib=Library.open(root);record=lib.create_record({'title':'Own process journal cut'})
audio=b'isolated original audio';stage=root/'.staging'/'fixture.part';stage.write_bytes(audio)
lib.commit_segment(record['id'],'original',0,stage,0,hashlib.sha256(audio).hexdigest());record=lib.get_record(record['id'])
first={'model':'first','language':'ru','rawText':'First raw','segments':[{'id':7,'start':0,'end':1,'text':'Original'}]}
if editing:record=lib.patch_record(record['id'],record['version'],{'transcript':first})
print(json.dumps({'id':record['id'],'version':record['version']}),flush=True)
real=paths.publish
def cut(source,target):
 if phase=='before-manifest' and target.name=='record.json':os._exit(41)
 real(source,target)
 if phase=='manifest' and target.name=='record.json' or phase=='object' and target.parent.name=='objects' or phase=='revision' and target.parent.name=='revisions':os._exit(41)
paths.publish=cut
change={**first,'model':'later' if editing else 'first','language':'en' if editing else 'ru','rawText':'Late raw' if editing else 'First raw','segments':[{'id':7,'start':0,'end':1,'text':'Edited' if editing else 'Original'}]}
result=lib.patch_record(record['id'],record['version'],{'transcript':change});print(json.dumps({'ack':result['version']}),flush=True);sys.stdin.read();lib.close()
'''
        for editing in [False,True]:
            for phase in ['before-manifest','manifest','object','revision','ack']:
                with self.subTest(editing=editing,phase=phase),tempfile.TemporaryDirectory() as temp:
                    root=Path(temp)/'library';child=subprocess.Popen([sys.executable,'-c',child_code,str(launcher),str(root),phase,'edit' if editing else 'first'],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,encoding='utf-8')
                    try:
                        before=json.loads(child.stdout.readline())
                        if phase=='ack':self.assertEqual(json.loads(child.stdout.readline())['ack'],before['version']+1);child.kill()
                        child.wait(timeout=15);self.assertIn(child.returncode,[-9,1] if phase=='ack' else [41],child.stderr.read())
                    finally:
                        if child.poll() is None:child.kill();child.wait(timeout=5)
                        child.stdin.close();child.stdout.close();child.stderr.close()
                    lib=Library.open(root)
                    try:
                        result=lib.recover();self.assertEqual(result['transcriptRecoveryErrors'],[]);self.assertEqual(result['corrupt'],[])
                        current=lib.get_record(before['id']);self.assertEqual(current['version'],before['version']+int(phase!='before-manifest'))
                        self.assertEqual(b''.join(Path(f['path']).read_bytes() for f in lib.audio_descriptor(before['id'])['files']),b'isolated original audio')
                        if editing or phase!='before-manifest':
                            folder=root/'records'/before['id']/'transcripts';self.assertEqual(read(folder/'original.json')['model'],'first')
                            self.assertEqual(read(folder/'original.json')['language'],'ru');self.assertEqual(read(folder/'original.json')['rawText'],'First raw')
                            self.assertEqual(read(folder/'edits.json')['segments'][0]['text'],'Edited' if editing and phase!='before-manifest' else 'Original')
                            self.assertEqual(len(list((folder/'revisions').glob('*.json'))),1+int(editing and phase!='before-manifest'))
                        lib.recover();self.assertEqual(lib.get_record(before['id']),current)
                    finally:lib.close()

if __name__=='__main__':unittest.main()
