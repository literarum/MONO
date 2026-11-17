import ctypes,errno,os,tempfile,threading,time,unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch
from local_core.paths import publish

def reader_without_delete_share(file):
    kernel=ctypes.WinDLL('kernel32',use_last_error=True);open_file=kernel.CreateFileW
    open_file.argtypes=[ctypes.c_wchar_p,ctypes.c_uint32,ctypes.c_uint32,ctypes.c_void_p,ctypes.c_uint32,ctypes.c_uint32,ctypes.c_void_p];open_file.restype=ctypes.c_void_p
    handle=open_file(str(file),0x80000000,0x1|0x2,None,3,0,None)
    if handle in [None,ctypes.c_void_p(-1).value]:raise ctypes.WinError(ctypes.get_last_error())
    close=kernel.CloseHandle;close.argtypes=[ctypes.c_void_p];close.restype=ctypes.c_int
    return lambda:close(handle)

class PublicationTests(unittest.TestCase):
    def test_transient_reader_does_not_interrupt_atomic_publication(self):
        with tempfile.TemporaryDirectory() as tmp:
            source,target=Path(tmp)/'source',Path(tmp)/'record.json';source.write_bytes(b'new');target.write_bytes(b'old')
            if os.name=='nt':
                close=reader_without_delete_share(target);release=threading.Timer(.075,close);release.start()
                try:publish(source,target)
                finally:release.join()
            else:
                with target.open('rb') as reader:publish(source,target);self.assertEqual(reader.read(),b'old')
            self.assertEqual(target.read_bytes(),b'new');self.assertFalse(source.exists())

    def test_permanent_conflict_preserves_both_files_and_has_a_deadline(self):
        with tempfile.TemporaryDirectory() as tmp:
            source,target=Path(tmp)/'source',Path(tmp)/'record.json';source.write_bytes(b'new');target.write_bytes(b'old');start=time.monotonic()
            if os.name=='nt':
                close=reader_without_delete_share(target)
                try:
                    with self.assertRaises(OSError):publish(source,target)
                finally:close()
            else:
                with patch('local_core.paths.os.replace',side_effect=PermissionError(errno.EACCES,'denied')):
                    with self.assertRaises(OSError):publish(source,target)
            self.assertLess(time.monotonic()-start,2);self.assertEqual(source.read_bytes(),b'new');self.assertEqual(target.read_bytes(),b'old')

    def test_disk_full_is_never_retried_or_reported_successful(self):
        with tempfile.TemporaryDirectory() as tmp:
            source,target=Path(tmp)/'source',Path(tmp)/'record.json';source.write_bytes(b'new');target.write_bytes(b'old')
            if os.name=='nt':
                calls=[]
                def move(*args):calls.append(args);return 0
                with patch('local_core.paths.ctypes.WinDLL',return_value=SimpleNamespace(MoveFileExW=move)),patch('local_core.paths.ctypes.get_last_error',return_value=112):
                    with self.assertRaises(OSError) as result:publish(source,target)
                self.assertEqual(result.exception.winerror,112);self.assertEqual(len(calls),1)
            else:
                with patch('local_core.paths.os.replace',side_effect=OSError(errno.ENOSPC,'full')) as move:
                    with self.assertRaises(OSError):publish(source,target)
                    self.assertEqual(move.call_count,1)
            self.assertEqual(source.read_bytes(),b'new');self.assertEqual(target.read_bytes(),b'old')
