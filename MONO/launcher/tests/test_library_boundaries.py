import hashlib,json,os,sqlite3,tempfile,unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch
from local_core.library import Library
from local_core.config import LocalConfig
from local_core.protocol import CoreError

def inventory(root):return {str(p.relative_to(root)):hashlib.sha256(p.read_bytes()).hexdigest() if p.is_file() else 'directory' for p in root.rglob('*')}

class LibraryBoundaries(unittest.TestCase):
    def test_invalid_native_format_is_rejected_before_any_audio_publication(self):
        with tempfile.TemporaryDirectory() as temp:
            library=Library.open(Path(temp));record=library.create_record({'title':'Keep staged source'});stage=Path(temp)/'.staging'/'test.part';data=b'unchanged native bytes';stage.write_bytes(data)
            try:
                with self.assertRaises(CoreError):library.commit_segment(record['id'],'mic',0,stage,1,hashlib.sha256(data).hexdigest(),format_info={'channels':0})
                self.assertEqual(library.get_record(record['id']),record);self.assertTrue(stage.exists());self.assertEqual(stage.read_bytes(),data);self.assertEqual(list((Path(temp)/'records'/record['id']).glob('original/*/*.part')),[])
            finally:library.close()
    def test_newer_manifest_rejected_without_creating_or_changing_files(self):
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp);(root/'library.json').write_text(json.dumps({'schema':2,'future':'preserve'}),encoding='utf-8');before=inventory(root)
            with self.assertRaises(CoreError) as error:Library.open(root)
            self.assertEqual(error.exception.code,'NEWER_LIBRARY_VERSION');self.assertEqual(inventory(root),before)
    def test_newer_database_rejected_without_creating_or_changing_files(self):
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp);connection=sqlite3.connect(root/'library.sqlite3');connection.execute('PRAGMA user_version=2');connection.close();before=inventory(root)
            with self.assertRaises(CoreError) as error:Library.open(root)
            self.assertEqual(error.exception.code,'NEWER_LIBRARY_VERSION');self.assertEqual(inventory(root),before)
    def test_missing_configured_drive_is_not_replaced_with_empty_archive(self):
        with tempfile.TemporaryDirectory() as temp,patch.dict(os.environ,{'MONO_CONFIG_DIR':str(Path(temp)/'config')}):
            config=LocalConfig();missing=Path(temp)/'missing-drive'/'archive';config.settings={'schema':1,'libraryRoot':str(missing)}
            try:
                self.assertFalse(config.status()['libraryAvailable'])
                with self.assertRaises(CoreError) as error:config.get_library()
                self.assertEqual(error.exception.code,'LIBRARY_MISSING');self.assertFalse(missing.parent.exists())
            finally:config.close()
    def test_disk_full_before_audio_publication_does_not_acknowledge_or_change_record(self):
        with tempfile.TemporaryDirectory() as temp:
            library=Library.open(Path(temp));record=library.create_record({'title':'Full disk'});data=b'untouched';stage=Path(temp)/'.staging'/'test.part';stage.write_bytes(data)
            try:
                with patch('local_core.library.shutil.disk_usage',return_value=SimpleNamespace(free=0)):
                    with self.assertRaises(CoreError) as error:library.commit_segment(record['id'],'original',0,stage,0,hashlib.sha256(data).hexdigest())
                self.assertEqual(error.exception.code,'DISK_FULL');self.assertEqual(library.get_record(record['id']),record);self.assertEqual(stage.read_bytes(),data)
            finally:library.close()
