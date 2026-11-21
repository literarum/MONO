import hashlib,json,os,tempfile,time,unittest,uuid
from pathlib import Path
from unittest.mock import patch
from local_core.library import Library
from local_core.transfer import snapshot_library,copy_snapshot,verify_backup,merge_backup
from local_core.protocol import CoreError
from local_core.config import LocalConfig

class TransferTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.root=Path(self.temp.name);self.library=Library.open(self.root/'source')
        self.record=self.library.create_record({'title':'Исходник','mime':'audio/wav'})
        data=b'exact original bytes';stage=self.library.root/'.staging'/'audio.part';stage.write_bytes(data)
        self.library.commit_segment(self.record['id'],'original',0,stage,100,hashlib.sha256(data).hexdigest())
        r=self.library.get_record(self.record['id']);self.library.patch_record(r['id'],r['version'],{'transcript':{'segments':[{'start':0,'end':1,'text':'Правка','original':'Оригинал'}]}})
    def tearDown(self):self.library.close();self.temp.cleanup()
    def test_interrupted_copy_resumes_and_preserves_audio_edits_and_source(self):
        snapshot=snapshot_library(self.library);before={f['path']:(self.library.root/f['path']).read_bytes() for f in snapshot['files']};target=self.root/'copy'
        from local_core.transfer import copy_file
        calls=0
        def fail_after_one(*args,**kwargs):
            nonlocal calls
            calls+=1
            if calls==2:raise OSError('injected copy interruption')
            return copy_file(*args,**kwargs)
        with patch('local_core.transfer.copy_file',side_effect=fail_after_one):
            with self.assertRaises(OSError):copy_snapshot(self.library.root,target,snapshot)
        self.assertFalse((target/'backup.json').exists())
        copy_snapshot(self.library.root,target,snapshot);verified=verify_backup(target);self.assertEqual(verified['files'],snapshot['files'])
        copied=Library.open(target)
        try:
            self.assertEqual(copied.recover()['corrupt'],[]);r=copied.get_record(self.record['id']);self.assertEqual(r['transcript']['segments'][0]['text'],'Правка');self.assertEqual(r['transcript']['segments'][0]['original'],'Оригинал')
        finally:copied.close()
        for name,data in before.items():self.assertEqual((self.library.root/name).read_bytes(),data)
        # Completed copies are idempotent, not a second copy of each recording.
        copy_snapshot(self.library.root,target,snapshot)
    def test_modified_file_and_traversal_manifest_are_rejected(self):
        snapshot=snapshot_library(self.library);target=self.root/'copy';copy_snapshot(self.library.root,target,snapshot)
        item=next(f for f in snapshot['files'] if f['path'].endswith('.part'));(target/item['path']).write_bytes(b'changed')
        with self.assertRaises(CoreError):verify_backup(target)
        manifest=json.loads((target/'backup.json').read_text(encoding='utf-8'));manifest['files'][0]['path']='../escape.json';(target/'backup.json').write_text(json.dumps(manifest),encoding='utf-8')
        with self.assertRaises(CoreError):verify_backup(target)
    def test_active_recording_and_overlapping_destination_are_rejected(self):
        r=self.library.get_record(self.record['id']);self.library.patch_record(r['id'],r['version'],{'status':'recording'})
        with self.assertRaisesRegex(CoreError,'LIBRARY_ACTIVE'):snapshot_library(self.library)
        self.library.patch_record(r['id'],r['version']+1,{'status':'saved'});snapshot=snapshot_library(self.library)
        with self.assertRaises(CoreError):copy_snapshot(self.library.root,self.library.root/'nested',snapshot)
        self.assertFalse((self.library.root/'nested').exists())
    def test_move_switches_config_only_after_verified_copy_and_preserves_old_folder(self):
        self.library.close()
        with patch.dict(os.environ,{'MONO_CONFIG_DIR':str(self.root/'config')}):
            config=LocalConfig();config.settings={'libraryRoot':str(self.root/'source')};config.get_library()
            target=self.root/'destination';choice='00000000-0000-4000-8000-000000000001'
            config.choices[choice]={'path':target,'purpose':'move','expires':time.monotonic()+600}
            try:
                operation=config.transfers.start({'kind':'move','choiceId':choice})
                for _ in range(100):
                    status=config.transfers.status(operation['id'])
                    if status['state']!='running':break
                    time.sleep(.02)
                self.assertEqual(status['state'],'completed',status);self.assertTrue(Path(config.status()['libraryPath']).samefile(target))
                self.assertTrue((self.root/'source'/'records'/self.record['id']/'record.json').is_file())
                self.assertEqual(config.get_library().get_record(self.record['id'])['transcript']['segments'][0]['text'],'Правка')
            finally:config.close()
    def test_invalid_relative_paths_are_always_rejected_seed_418723(self):
        import random
        from local_core.transfer import relative
        generator=random.Random(418723);rid=self.record['id']
        for _ in range(300):
            base=f'records/{rid}/original/mic/000000.part'
            bad=generator.choice(['../'+base,'/'+base,base.replace('/','\\'),base+'/../escape.json',base.replace('000000.part','evil.exe'),base.replace(rid,'..'),base+'//','C:/'+base])
            with self.subTest(path=bad):
                with self.assertRaises(CoreError):relative(bad)
    def test_legacy_v1_backup_is_copied_without_changing_source_or_losing_original_text(self):
        source=self.root/'legacy-v1';source.mkdir();rid=str(uuid.uuid4());data=b'legacy opaque audio bytes';audio=rid+'.wav';(source/audio).write_bytes(data)
        record={'id':rid,'title':'Прежняя копия','createdAt':'2026-10-01T10:00:00Z','duration':1,'mime':'audio/wav','size':len(data),'status':'completed','transcript':{'segments':[{'start':0,'end':1,'text':'Правка v1','original':'Оригинал v1'}]}}
        (source/'manifest.json').write_text(json.dumps({'format':'mono-portable-v1','records':[{'audio':audio,'record':record}]},ensure_ascii=False),encoding='utf-8');before={f.name:f.read_bytes() for f in source.iterdir()}
        merge_backup(source,self.library.root);self.library.recover();imported=self.library.get_record(rid)
        self.assertEqual(imported['title'],record['title']);self.assertEqual(imported['transcript']['segments'][0]['original'],'Оригинал v1');self.assertEqual(imported['transcript']['segments'][0]['text'],'Правка v1')
        self.assertEqual(Path(self.library.audio_descriptor(rid)['files'][0]['path']).read_bytes(),data)
        merge_backup(source,self.library.root);self.library.recover();self.assertEqual(len(self.library.list_records()['items']),2)
        for name,content in before.items():self.assertEqual((source/name).read_bytes(),content)
