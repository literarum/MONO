import os,tempfile,unittest
from pathlib import Path
from unittest.mock import patch
from local_core.config import LocalConfig
from local_core.paths import LibraryLock
from local_core.protocol import CoreError

def seed(root):
    root.mkdir()
    for name in ['records','.staging','trash','journal']:(root/name).mkdir()
    (root/'library.sqlite3').write_bytes(b'')
    (root/'.mono-library.lock').write_bytes(b'\0')

def files(root):return {str(p.relative_to(root)):p.read_bytes() for p in root.rglob('*') if p.is_file()}

class EmptyArchiveInitialization(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.base=Path(self.temp.name);self.root=self.base/'archive';seed(self.root)
        self.env=patch.dict(os.environ,{'MONO_CONFIG_DIR':str(self.base/'config'),'MONO_DEFAULT_LIBRARY_ROOT':str(self.root)})
        self.env.start();self.config=LocalConfig()
    def tearDown(self):self.config.close();self.env.stop();self.temp.cleanup()
    def reject_unchanged(self):
        before=files(self.root)
        with self.assertRaises(CoreError) as caught:self.config.configure({'useDefault':True})
        self.assertEqual(caught.exception.code,'NOT_LIBRARY');self.assertEqual(files(self.root),before)
        self.assertFalse(self.config.file.exists())
    def test_resume_exact_empty_interrupted_default_and_reopen(self):
        status=self.config.configure({'useDefault':True})
        self.assertTrue(status['libraryAvailable']);self.assertTrue((self.root/'library.json').is_file())
        self.assertGreater((self.root/'library.sqlite3').stat().st_size,0)
        self.config.close();self.assertEqual((self.root/'.mono-library.lock').read_bytes(),b'\0')
        self.config=LocalConfig();self.assertTrue(self.config.status()['libraryAvailable'])
        self.assertEqual(self.config.get_library().db.execute('SELECT count(*) FROM records').fetchone()[0],0)
    def test_refuse_arbitrary_file(self):
        (self.root/'notes.txt').write_bytes(b'user data');self.reject_unchanged()
    def test_refuse_record_payload(self):
        (self.root/'records'/'existing.wav').write_bytes(b'preserve audio');self.reject_unchanged()
    def test_refuse_nonzero_database(self):
        (self.root/'library.sqlite3').write_bytes(b'database must survive');self.reject_unchanged()
    def test_refuse_incomplete_signature(self):
        (self.root/'.mono-library.lock').unlink();self.reject_unchanged()
    def test_refuse_foreign_lock_signature(self):
        (self.root/'.mono-library.lock').write_bytes(b'x');self.reject_unchanged()
    def test_refuse_database_hardlink_without_writing_external_file(self):
        external=self.base/'external.sqlite3';external.write_bytes(b'')
        (self.root/'library.sqlite3').unlink();os.link(external,self.root/'library.sqlite3')
        self.reject_unchanged();self.assertEqual(external.read_bytes(),b'')
    def test_refuse_lock_hardlink_without_initializing_archive(self):
        external=self.base/'external.lock';external.write_bytes(b'\0')
        (self.root/'.mono-library.lock').unlink();os.link(external,self.root/'.mono-library.lock')
        self.reject_unchanged();self.assertEqual(external.read_bytes(),b'\0')
    def test_open_mode_resumes_an_interrupted_initialization(self):
        # Any folder gesture now works: MONO's own interrupted bootstrap layout is resumed.
        self.config.choices['one-time']={'path':self.root,'purpose':'open','expires':float('inf')}
        self.assertTrue(self.config.configure({'choiceId':'one-time'})['libraryConfigured'])
        self.assertTrue((self.root/'library.json').is_file());self.assertNotIn('one-time',self.config.choices)
    def test_existing_writer_retains_ownership(self):
        before=files(self.root)
        lock=LibraryLock(self.root/'.mono-library.lock')
        try:
            with self.assertRaises(CoreError) as caught:self.config.configure({'useDefault':True})
            self.assertEqual(caught.exception.code,'LIBRARY_BUSY')
        finally:lock.close()
        self.assertEqual(files(self.root),before)
    def test_recheck_after_acquiring_lock_rejects_new_payload(self):
        import local_core.library as module
        original=module.LibraryLock
        def racing_lock(file):
            result=original(file);(self.root/'records'/'race.wav').write_bytes(b'new payload');return result
        with patch.object(module,'LibraryLock',side_effect=racing_lock):
            with self.assertRaises(CoreError) as caught:self.config.configure({'useDefault':True})
        self.assertEqual(caught.exception.code,'NOT_LIBRARY');self.assertEqual((self.root/'records'/'race.wav').read_bytes(),b'new payload')
        self.assertEqual((self.root/'library.sqlite3').stat().st_size,0);self.assertFalse((self.root/'library.json').exists())
