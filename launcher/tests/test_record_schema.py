import copy,json,random,tempfile,unittest
from pathlib import Path
from local_core.library import Library
from local_core.protocol import CoreError

class RecordSchemaTests(unittest.TestCase):
    def test_invalid_metadata_never_changes_manifest_or_original_transcript_seed_1705(self):
        with tempfile.TemporaryDirectory() as temp:
            library=Library.open(Path(temp))
            try:
                record=library.create_record({'title':'Safe'})
                library.patch_record(record['id'],record['version'],{'transcript':{'segments':[{'start':0,'end':1,'text':'Edit','original':'Original'}]}})
                record=library.get_record(record['id']);folder=Path(temp)/'records'/record['id'];before={p.relative_to(folder).as_posix():p.read_bytes() for p in folder.rglob('*') if p.is_file()}
                invalid=[{'status':{}},{'status':'invented'},{'source':['invalid']},{'mime':'audio/wav\r\nInjected: true'},{'job':{'stage':'x','total':-1}},{'peaks':[float('nan')]},{'chunkCount':True},{'lastChunkAt':-1},{'estimatedUSD':float('inf')},{'transcript':{'segments':[{'start':True,'end':1,'text':'x'}]}},{'transcript':{'segments':[{'start':0,'end':1,'text':'x'}]},'status':{}}]
                generator=random.Random(1705)
                for _ in range(120):
                    changes=copy.deepcopy(generator.choice(invalid))
                    with self.subTest(patch=repr(changes)):
                        with self.assertRaises(CoreError):library.patch_record(record['id'],record['version'],changes)
                        self.assertEqual(library.get_record(record['id']),record)
                        self.assertEqual({p.relative_to(folder).as_posix():p.read_bytes() for p in folder.rglob('*') if p.is_file()},before)
            finally:library.close()
    def test_new_record_rejects_unusable_dates_and_mime_without_creating_a_manifest(self):
        with tempfile.TemporaryDirectory() as temp:
            library=Library.open(Path(temp))
            try:
                for changes in [{'createdAt':{}},{'createdAt':'not a date'},{'mime':{'type':'wav'}},{'source':False}]:
                    with self.subTest(changes=changes):
                        with self.assertRaises(CoreError):library.create_record({'title':'Invalid',**changes})
                self.assertEqual(list((Path(temp)/'records').iterdir()),[])
            finally:library.close()
