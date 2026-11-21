import hashlib, importlib.util, json, sys, tempfile, unittest, uuid
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
try:
    from local_core.library import Library
except ImportError:Library=None

class LibraryTests(unittest.TestCase):
    def setUp(self):
        self.assertIsNotNone(Library,'Durable library is missing')
        self.tmp=tempfile.TemporaryDirectory();self.root=Path(self.tmp.name)/'library';self.lib=Library.open(self.root)
    def tearDown(self):
        if hasattr(self,'lib'):self.lib.close()
        if hasattr(self,'tmp'):self.tmp.cleanup()
    def stage(self,data):
        p=self.root/'.staging'/(str(uuid.uuid4())+'.part');p.write_bytes(data);return p
    def test_committed_segment_survives_reopen_and_duplicate_is_idempotent(self):
        rec=self.lib.create_record({'title':'Запись встречи','mime':'audio/wav'})
        data=b'original-audio-sentinel';sha=hashlib.sha256(data).hexdigest()
        receipt=self.lib.commit_segment(rec['id'],'mic',0,self.stage(data),96000,sha)
        self.assertEqual(receipt['committedFrames'],96000)
        duplicate=self.lib.commit_segment(rec['id'],'mic',0,self.stage(data),96000,sha)
        self.assertEqual(duplicate['version'],receipt['version'])
        self.lib.close();self.lib=Library.open(self.root)
        self.assertEqual(self.lib.get_record(rec['id'])['size'],len(data))
        files=list((self.root/'records'/rec['id']/'original'/'mic').glob('*'))
        self.assertEqual(len(files),1);self.assertEqual(files[0].read_bytes(),data)
    def test_conflict_stale_edit_and_trash_cannot_overwrite_original(self):
        rec=self.lib.create_record({'title':'First'})
        changed=self.lib.patch_record(rec['id'],1,{'title':'Edited'})
        self.assertEqual(changed['version'],2)
        with self.assertRaisesRegex(Exception,'VERSION_CONFLICT'):self.lib.patch_record(rec['id'],1,{'title':'Stale'})
        trashed=self.lib.trash(rec['id'],2)
        self.assertEqual(self.lib.list_records()['items'],[])
        with self.assertRaisesRegex(Exception,'TRASHED'):self.lib.patch_record(rec['id'],trashed['version'],{'title':'Late result'})
        self.lib.restore(rec['id'],trashed['version']);self.assertEqual(self.lib.list_records()['items'][0]['title'],'Edited')
    def test_wrong_hash_missing_sequence_and_unsafe_paths_fail_without_commit(self):
        rec=self.lib.create_record({'title':'Safe'})
        data=b'abc';sha=hashlib.sha256(data).hexdigest()
        with self.assertRaisesRegex(Exception,'CHECKSUM'):self.lib.commit_segment(rec['id'],'mic',0,self.stage(data),3,'0'*64)
        with self.assertRaisesRegex(Exception,'SEQUENCE'):self.lib.commit_segment(rec['id'],'mic',1,self.stage(data),3,sha)
        with self.assertRaises(Exception):self.lib.commit_segment('../outside','mic',0,self.stage(data),3,sha)
        outside=Path(self.tmp.name)/'outside';outside.write_bytes(data)
        with self.assertRaisesRegex(Exception,'UNSAFE_PATH'):self.lib.commit_segment(rec['id'],'mic',0,outside,3,sha)
        self.assertEqual(self.lib.get_record(rec['id'])['size'],0)
    def test_second_writer_rejected_and_manifest_rebuild_preserves_edits(self):
        rec=self.lib.create_record({'title':'Манифест'})
        self.lib.patch_record(rec['id'],1,{'transcript':{'segments':[{'start':0,'end':1,'text':'Правка','original':'Оригинал'}]}})
        with self.assertRaisesRegex(Exception,'LIBRARY_BUSY'):Library.open(self.root)
        self.lib.close()
        (self.root/'library.sqlite3').unlink()
        self.lib=Library.open(self.root);self.lib.recover()
        rebuilt=self.lib.get_record(rec['id']);self.assertEqual(rebuilt['title'],'Манифест');self.assertEqual(rebuilt['transcript']['segments'][0]['original'],'Оригинал')
    def test_same_size_audio_corruption_is_reported_and_cannot_be_served_as_healthy(self):
        rec=self.lib.create_record({'title':'Integrity'})
        self.lib.commit_segment(rec['id'],'mic',0,self.stage(b'good'),4,hashlib.sha256(b'good').hexdigest())
        file=next((self.root/'records'/rec['id']/'original'/'mic').glob('*.part'));file.write_bytes(b'evil')
        self.assertIn(rec['id'],self.lib.recover()['corrupt'])
        self.assertEqual(self.lib.get_record(rec['id'])['status'],'damaged')
        with self.assertRaisesRegex(Exception,'AUDIO_DAMAGED'):self.lib.audio_descriptor(rec['id'])
        file.write_bytes(b'good');self.lib.recover();self.assertEqual(self.lib.get_record(rec['id'])['status'],'saved')
