import hashlib,io,json,tempfile,unittest,zipfile
from pathlib import Path
from unittest.mock import patch
import fetch_ffmpeg_windows as acquire

class ReviewedInputTests(unittest.TestCase):
    def test_existing_output_is_preserved_before_download_or_execution(self):
        with tempfile.TemporaryDirectory() as folder:
            output=Path(folder);sentinel=output/'keep';sentinel.write_bytes(b'unchanged')
            with patch.object(acquire.urllib.request,'urlopen',side_effect=AssertionError('No request permitted')),patch.object(acquire,'inspect_license',side_effect=AssertionError('No execution permitted')):
                with self.assertRaises(FileExistsError):acquire.acquire(output)
            self.assertEqual(sentinel.read_bytes(),b'unchanged')
    def test_wrong_archive_hash_fails_before_extraction_or_execution(self):
        with tempfile.TemporaryDirectory() as folder:
            root=Path(folder);archive=root/'wrong.zip';archive.write_bytes(b'bad input')
            with patch.object(acquire,'inspect_license',side_effect=AssertionError('Unverified code must never run')) as inspect,patch.object(acquire.urllib.request,'urlopen',side_effect=AssertionError('Cached bad input must not cause a request')):
                with self.assertRaisesRegex(RuntimeError,'checksum'):acquire.acquire(root/'output',archive)
                inspect.assert_not_called()
            self.assertFalse((root/'output/bundle').exists())
    def test_checksum_consistent_unsafe_zip_is_rejected_without_extracting_or_executing(self):
        for name in ['../outside','/absolute','top\\bad','top/bin/ffmpeg.exe']:
            with self.subTest(name=name),tempfile.TemporaryDirectory() as folder:
                root=Path(folder);archive=root/'fixture.zip'
                with zipfile.ZipFile(archive,'w') as output:
                    if name=='top/bin/ffmpeg.exe':
                        info=zipfile.ZipInfo(name);info.create_system=3;info.external_attr=0o120777<<16;output.writestr(info,'target')
                    else:
                        # ZipInfo normalizes backslashes on Windows. Craft an
                        # actual raw archive name, not a silently sanitized one.
                        info=zipfile.ZipInfo(name);info.filename=name;output.writestr(info,b'invalid path')
                    output.writestr('top/LICENSE.txt',b'fixture license; never executed')
                with zipfile.ZipFile(archive) as check:self.assertEqual(check.infolist()[0].orig_filename,name)
                lock=json.loads(acquire.LOCK.read_text());lock['asset']='top.zip';lock['sha256']=hashlib.sha256(archive.read_bytes()).hexdigest();file=root/'lock.json';file.write_text(json.dumps(lock))
                with patch.object(acquire,'LOCK',file),patch.object(acquire,'inspect_license',side_effect=AssertionError('No execution permitted')) as inspect,patch.object(acquire.urllib.request,'urlopen',side_effect=AssertionError('No request permitted')):
                    with self.assertRaisesRegex(RuntimeError,'Unsafe'):acquire.acquire(root/'output',archive)
                    inspect.assert_not_called()
                self.assertFalse((root/'outside').exists())
