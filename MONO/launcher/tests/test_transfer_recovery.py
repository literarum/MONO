import hashlib,json,os,tempfile,time,unittest,uuid
from pathlib import Path
from unittest.mock import patch
from local_core.config import LocalConfig
from local_core.library import Library
from local_core.protocol import CoreError
from local_core.transfer import copy_file,verify_backup

class TransferRecoveryTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.root=Path(self.temp.name)
        self.env=patch.dict(os.environ,{'MONO_CONFIG_DIR':str(self.root/'config')});self.env.start()
        lib=Library.open(self.root/'source');self.record=lib.create_record({'title':'Recovery fixture','mime':'audio/wav'})
        data=b'preserved source audio';stage=lib.root/'.staging'/'audio.part';stage.write_bytes(data)
        receipt=lib.commit_segment(self.record['id'],'original',0,stage,100,hashlib.sha256(data).hexdigest())
        lib.patch_record(self.record['id'],receipt['version'],{'transcript':{'segments':[{'start':0,'end':1,'text':'Edited','original':'Original'}]}})
        lib.close();self.config=LocalConfig();self.config.settings={'schema':1,'libraryRoot':str(self.root/'source')}
        from local_core.paths import atomic_json
        atomic_json(self.config.file,self.config.settings);self.config.get_library()
    def tearDown(self):
        self.config.close();self.env.stop();self.temp.cleanup()
    def wait(self,operation):
        deadline=time.monotonic()+10
        while time.monotonic()<deadline:
            status=self.config.transfers.status(operation['id'])
            if status['state']!='running':return status
            time.sleep(.01)
        self.fail('transfer did not settle')
    def start(self,kind='move'):
        destination=self.root/'destination';destination.mkdir(exist_ok=True)
        token=str(uuid.uuid4());self.config.choices[token]={'path':destination,'purpose':{'move':'move','export':'backup','import':'import'}[kind],'expires':time.monotonic()+600}
        return self.config.transfers.start({'kind':kind,'choiceId':token})
    def interrupt(self,kind='move'):
        calls=0
        def injected(*args,**kwargs):
            nonlocal calls
            calls+=1
            if calls==2:raise OSError('injected interruption')
            return copy_file(*args,**kwargs)
        with patch('local_core.transfer.copy_file',side_effect=injected):
            operation=self.wait(self.start(kind))
        self.assertEqual(operation['state'],'failed',operation)
        self.config.close();self.config=LocalConfig()
        return operation
    def test_reopen_preserves_operation_and_resumes_exact_copy(self):
        operation=self.interrupt();pending=self.config.status()['transfer']
        self.assertEqual(pending['id'],operation['id']);self.assertIn(pending['state'],['failed','interrupted'])
        self.assertEqual(self.config.settings['libraryRoot'],str(self.root/'source'))
        completed=self.wait(self.config.transfers.resume(operation['id']))
        self.assertEqual(completed['state'],'completed',completed);self.assertEqual(verify_backup(self.root/'destination')['libraryId'],json.loads((self.root/'source'/'library.json').read_text())['id'])
        self.assertEqual(self.config.get_library().get_record(self.record['id'])['transcript']['segments'][0],{'id':0,'start':0,'end':1,'text':'Edited','original':'Original'})
        self.assertTrue((self.root/'source'/'records'/self.record['id']/'record.json').is_file())
    def test_changed_source_is_rejected_before_switching(self):
        operation=self.interrupt();lib=self.config.get_library();record=lib.get_record(self.record['id']);lib.patch_record(record['id'],record['version'],{'title':'Changed after interruption'})
        result=self.wait(self.config.transfers.resume(operation['id']))
        self.assertEqual(result.get('errorCode'),'TRANSFER_SOURCE_CHANGED',result);self.assertEqual(self.config.settings['libraryRoot'],str(self.root/'source'))
        self.assertFalse((self.root/'destination'/'backup.json').exists())
    def test_pending_operation_cannot_be_forgotten_and_wrong_id_is_rejected(self):
        operation=self.interrupt()
        with self.assertRaisesRegex(CoreError,'TRANSFER_PENDING'):self.start('export')
        with self.assertRaisesRegex(CoreError,'NOT_FOUND'):self.config.transfers.resume(str(uuid.uuid4()))
        self.config.transfers.cancel(operation['id']);self.config.close();self.config=LocalConfig()
        self.assertNotIn('transfer',self.config.status())
        with self.assertRaisesRegex(CoreError,'INVALID_TRANSFER_STATE'):self.config.transfers.resume(operation['id'])
    def test_resume_checks_pending_stages(self):
        operation=self.interrupt();self.config.pending_stages.add(str(uuid.uuid4()))
        with self.assertRaisesRegex(CoreError,'LIBRARY_ACTIVE'):self.config.transfers.resume(operation['id'])
    def test_journal_write_failure_does_not_leave_a_phantom_running_operation(self):
        with patch.object(self.config.transfers.journal,'save',side_effect=OSError('injected full config disk')):
            with self.assertRaises(OSError):self.start()
        self.assertFalse(self.config.transfers.active)
        self.assertFalse((self.root/'destination'/'.mono-transfer.json').exists())
    def test_tampered_destination_fails_without_changing_source(self):
        operation=self.interrupt();part=next((self.root/'destination'/'records').rglob('*.part'));part.write_bytes(b'tampered')
        result=self.wait(self.config.transfers.resume(operation['id']))
        self.assertEqual(result.get('errorCode'),'TRANSFER_CONFLICT',result);self.assertEqual(self.config.settings['libraryRoot'],str(self.root/'source'))
    def test_export_resumes_same_destination_after_reopen(self):
        operation=self.interrupt('export');completed=self.wait(self.config.transfers.resume(operation['id']))
        self.assertEqual(completed['state'],'completed',completed)
        destinations=list((self.root/'destination').glob('MONO_BACKUP_*'));self.assertEqual(len(destinations),1);verify_backup(destinations[0])
        self.assertEqual(self.config.settings['libraryRoot'],str(self.root/'source'))
    def test_journal_corruption_is_visible_and_does_not_start_copy(self):
        self.interrupt();file=self.root/'config'/'transfer.json';file.write_text('{broken',encoding='utf-8');self.config.close();self.config=LocalConfig()
        self.assertEqual(self.config.status().get('transferRecoveryError'),'TRANSFER_JOURNAL_INVALID')
        with self.assertRaisesRegex(CoreError,'TRANSFER_JOURNAL_INVALID'):self.start()
        self.assertEqual(file.read_text(),'{broken')
    def test_explicit_invalid_journal_recovery_preserves_evidence_and_allows_new_copy(self):
        self.interrupt();file=self.root/'config'/'transfer.json';file.write_text('{broken',encoding='utf-8');self.config.close();self.config=LocalConfig()
        result=self.config.transfers.recover_invalid();self.assertEqual(result,{'recovered':True})
        self.assertNotIn('transferRecoveryError',self.config.status());self.assertFalse(file.exists())
        preserved=list((self.root/'config').glob('transfer-invalid-*.json'));self.assertEqual(len(preserved),1);self.assertEqual(preserved[0].read_text(),'{broken')
        completed=self.wait(self.start('export'));self.assertEqual(completed['state'],'completed',completed)
        self.assertTrue((self.root/'source'/'records'/self.record['id']/'record.json').is_file())
    def test_terminal_operation_removes_only_its_private_conversion_workspace(self):
        operation=self.interrupt('export');workspace=self.root/'config'/'transfers'/operation['id'];self.assertTrue((workspace/'snapshot.json').is_file())
        completed=self.wait(self.config.transfers.resume(operation['id']));self.assertEqual(completed['state'],'completed',completed)
        self.assertFalse(workspace.exists(),'terminal private inventory/converted audio must not accumulate')
        verify_backup(Path(completed['result']['displayPath']));self.assertTrue((self.root/'source'/'records'/self.record['id']/'record.json').is_file())
    def test_cleanup_failure_is_visible_bounded_and_retried_before_next_operation(self):
        with patch.object(self.config.transfers.journal,'cleanup',side_effect=PermissionError('injected private temp access denial')):
            operation=self.wait(self.start('export'));self.assertEqual(operation['state'],'completed',operation);self.assertTrue(operation['cleanupPending'])
            with self.assertRaisesRegex(CoreError,'TRANSFER_CLEANUP_REQUIRED'):self.start('export')
        workspace=self.root/'config'/'transfers'/operation['id'];self.assertTrue(workspace.exists())
        completed=self.wait(self.start('export'));self.assertEqual(completed['state'],'completed',completed);self.assertFalse(workspace.exists())
    def test_cleanup_does_not_follow_a_reparse_point_into_any_other_folder(self):
        import subprocess
        operation=self.interrupt('export');workspace=self.root/'config'/'transfers'/operation['id'];outside=self.root/'outside';outside.mkdir();sentinel=outside/'keep.txt';sentinel.write_bytes(b'never delete source or unrelated data')
        link=workspace/('legacy-'+uuid.uuid4().hex)
        if os.name=='nt':
            result=subprocess.run([os.environ['COMSPEC'],'/c','mklink','/J',str(link),str(outside)],capture_output=True,text=True)
            self.assertEqual(result.returncode,0,result.stderr)
        else:link.symlink_to(outside,target_is_directory=True)
        try:
            cancelled=self.config.transfers.cancel(operation['id']);self.assertEqual(cancelled['state'],'cancelled');self.assertTrue(cancelled['cleanupPending']);self.assertEqual(sentinel.read_bytes(),b'never delete source or unrelated data')
            with self.assertRaisesRegex(CoreError,'TRANSFER_CLEANUP_REQUIRED'):self.start('export')
        finally:
            if os.name=='nt':link.rmdir()
            else:link.unlink()
        completed=self.wait(self.start('export'));self.assertEqual(completed['state'],'completed',completed);self.assertEqual(sentinel.read_bytes(),b'never delete source or unrelated data')
    def test_crash_after_pointer_publication_reconciles_without_reopening_locked_target(self):
        original=self.config.transfers.journal.save
        def fail_completed(task):
            if task['state']=='completed':raise OSError('injected journal publication failure after pointer')
            return original(task)
        with patch.object(self.config.transfers.journal,'save',side_effect=fail_completed):
            operation=self.wait(self.start());self.assertEqual(operation['state'],'failed',operation)
        self.assertTrue(Path(self.config.settings['libraryRoot']).samefile(self.root/'destination'))
        self.config.close();self.config=LocalConfig()
        self.assertEqual(self.config.status()['transfer']['state'],'interrupted')
        completed=self.wait(self.config.transfers.resume(operation['id']));self.assertEqual(completed['state'],'completed',completed)
        self.assertEqual(self.config.get_library().get_record(self.record['id'])['transcript']['segments'][0]['original'],'Original')
    def test_modified_inventory_and_configured_library_are_rejected(self):
        operation=self.interrupt();snapshot=next((self.root/'config'/'transfers').glob('*/snapshot.json'));snapshot.write_text('{}',encoding='utf-8')
        failed=self.wait(self.config.transfers.resume(operation['id']));self.assertEqual(failed.get('errorCode'),'TRANSFER_JOURNAL_INVALID',failed)
        self.config.library.close();self.config.library=None
        other=Library.open(self.root/'other');other.close();self.config.settings['libraryRoot']=str(self.root/'other')
        with self.assertRaisesRegex(CoreError,'TRANSFER_LIBRARY_CHANGED'):self.config.transfers.resume(operation['id'])
    def test_modern_and_legacy_import_recover_original_and_edited_text(self):
        from local_core.transfer import snapshot_library,copy_snapshot
        for legacy in [False,True]:
            with self.subTest(legacy=legacy):
                self.config.transfers.cancel(self.config.transfers.task['id']) if self.config.transfers.task else None
                source=self.root/('legacy' if legacy else 'modern');source.mkdir()
                if legacy:
                    rid=str(uuid.uuid4());data=b'legacy bytes';(source/(rid+'.wav')).write_bytes(data)
                    record={'id':rid,'title':'Legacy','createdAt':'2026-10-01T10:00:00Z','duration':1,'mime':'audio/wav','status':'completed','transcript':{'segments':[{'start':0,'end':1,'text':'Old edit','original':'Old original'}]}}
                    (source/'manifest.json').write_text(json.dumps({'format':'mono-portable-v1','records':[{'audio':rid+'.wav','record':record}]}),encoding='utf-8')
                else:
                    archive=Library.open(self.root/'import-original');r=archive.create_record({'title':'Imported','mime':'audio/wav'});rid=r['id']
                    staged=archive.root/'.staging'/'audio.part';staged.write_bytes(b'import bytes');receipt=archive.commit_segment(rid,'original',0,staged,100,hashlib.sha256(b'import bytes').hexdigest())
                    archive.patch_record(rid,receipt['version'],{'transcript':{'segments':[{'start':0,'end':1,'text':'Old edit','original':'Old original'}]}})
                    copy_snapshot(archive.root,source,snapshot_library(archive));archive.close()
                before={f.relative_to(source).as_posix():f.read_bytes() for f in source.rglob('*') if f.is_file()}
                token=str(uuid.uuid4());self.config.choices[token]={'path':source,'purpose':'import','expires':time.monotonic()+600}
                # Interrupt the real merge after frozen conversion/inventory,
                # not the conversion itself; no mock supplies copied results.
                from local_core.transfer import merge_backup
                def interrupted_merge(*args,**kwargs):raise OSError('injected before import copy')
                with patch('local_core.transfer.merge_backup',side_effect=interrupted_merge):
                    operation=self.wait(self.config.transfers.start({'kind':'import','choiceId':token}));self.assertEqual(operation['state'],'failed',operation)
                self.config.close();self.config=LocalConfig()
                completed=self.wait(self.config.transfers.resume(operation['id']));self.assertEqual(completed['state'],'completed',completed)
                self.assertFalse((self.root/'config'/'transfers'/operation['id']).exists(),'legacy conversion temporary audio must be cleaned after verified import')
                segment=self.config.get_library().get_record(rid)['transcript']['segments'][0];self.assertEqual((segment['text'],segment['original']),('Old edit','Old original'))
                self.assertEqual(before,{f.relative_to(source).as_posix():f.read_bytes() for f in source.rglob('*') if f.is_file()})
