import hashlib,importlib.util,io,json,tempfile,unittest,zipfile
from pathlib import Path
from unittest.mock import patch
ROOT=Path(__file__).resolve().parents[2]
path=ROOT/'launcher/fetch_msvc_windows.py'
fetch=None
if path.is_file():
    spec=importlib.util.spec_from_file_location('msvc_input_tests',path);fetch=importlib.util.module_from_spec(spec);spec.loader.exec_module(fetch)

def zipped(name):
    buffer=io.BytesIO()
    # ZipInfo normalizes the host separator on Windows. Write the raw local and
    # central names explicitly so this oracle actually supplies a backslash.
    with zipfile.ZipFile(buffer,'w') as z:z.writestr(name.replace('\\','/'),b'Inert fixture; never execute')
    raw=buffer.getvalue()
    if '\\' in name:raw=raw.replace(name.replace('\\','/').encode(),name.encode())
    with zipfile.ZipFile(io.BytesIO(raw)) as z:
        if z.infolist()[0].orig_filename!=name:raise AssertionError('Oracle ZIP did not preserve the intended raw name')
    return raw

class MsvcInputTests(unittest.TestCase):
    def test_environment_identifies_the_verified_toolset_and_only_private_paths(self):
        self.assertIsNotNone(fetch,'Canonical reviewed MSVC producer is missing')
        with tempfile.TemporaryDirectory() as folder:
            base=Path(folder);lock=fetch.load_lock();environment=fetch.environment_for(base,lock)
            self.assertEqual(environment.get('VCToolsVersion'),'14.51.36231','Nuitka needs the verified toolset version in a portable compiler environment')
            self.assertEqual(environment['VSLANG'],'1033')
            paths=environment['PATH'].split(fetch.os.pathsep)
            self.assertEqual(len(paths),3)
            self.assertTrue(all(Path(p).is_relative_to(base) for p in paths[:2]))
            self.assertIn('msvc-imports',environment['LIB'].split(fetch.os.pathsep)[0])
    def test_existing_output_is_preserved_before_network(self):
        self.assertIsNotNone(fetch,'Canonical reviewed MSVC producer is missing')
        with tempfile.TemporaryDirectory() as folder:
            output=Path(folder)/'output';output.mkdir();(output/'keep').write_bytes(b'keep')
            with patch.object(fetch,'read_input',side_effect=AssertionError('Network before output guard')) as read:
                with self.assertRaises(FileExistsError):fetch.acquire(output)
                read.assert_not_called()
            self.assertEqual((output/'keep').read_bytes(),b'keep')
    def test_raw_paths_have_independent_positive_control_and_reject_windows_escapes(self):
        self.assertIsNotNone(fetch,'Canonical reviewed MSVC producer is missing')
        self.assertEqual(fetch.inspect_archive(zipped('safe/file.txt')),{'safe/file.txt'})
        for name in ['../escape','safe/../escape','/absolute','safe\\escape','safe/CON.txt','safe/file:stream','safe/file.','safe/file ']:
            with self.subTest(path=name),self.assertRaises(RuntimeError):fetch.inspect_archive(zipped(name))
        buffer=io.BytesIO()
        with zipfile.ZipFile(buffer,'w') as z:z.writestr('safe/A',b'a');z.writestr('safe/a',b'b')
        with self.assertRaises(RuntimeError):fetch.inspect_archive(buffer.getvalue())
    def test_wrong_input_hash_never_reaches_extraction(self):
        self.assertIsNotNone(fetch,'Canonical reviewed MSVC producer is missing')
        with tempfile.TemporaryDirectory() as folder:
            base=Path(folder);archives=base/'archives';archives.mkdir();lock=fetch.load_lock()
            for row in [*lock['payloads'],lock['nuitka']]:(archives/row['filename']).write_bytes(b'Wrong archive; never execute')
            with patch.object(fetch,'write_payload',side_effect=AssertionError('Unverified extraction')) as write:
                with self.assertRaisesRegex(RuntimeError,'checksum'):fetch.acquire(base/'output',archives)
                write.assert_not_called()
    def test_extracted_replacement_is_denied_even_after_inventory_rewrite(self):
        self.assertIsNotNone(fetch,'Canonical reviewed MSVC producer is missing')
        with tempfile.TemporaryDirectory() as folder:
            base=Path(folder);archives=base/'archives';archives.mkdir();lock=fetch.load_lock()
            for row in lock['payloads']:
                buffer=io.BytesIO()
                with zipfile.ZipFile(buffer,'w') as z:
                    for name in row['required']:z.writestr(name,b'Inert fixture; never execute')
                raw=buffer.getvalue();row['sha256']=hashlib.sha256(raw).hexdigest();(archives/row['filename']).write_bytes(raw)
            raw=b'Inert Nuitka source fixture';lock['nuitka']['sha256']=hashlib.sha256(raw).hexdigest();(archives/lock['nuitka']['filename']).write_bytes(raw)
            with patch.object(fetch,'load_lock',return_value=lock):output=fetch.acquire(base/'input',archives)
            fetch.verify_input(output,lock)
            first=lock['payloads'][0];file=output/'payloads'/first['id']/first['required'][0];file.write_bytes(b'Replacement; never execute')
            inventory=output/'PROVENANCE.json';value=json.loads(inventory.read_text())
            for row in value['files']:
                if row['path']==file.relative_to(output).as_posix():row.update(size=file.stat().st_size,sha256=hashlib.sha256(file.read_bytes()).hexdigest())
            inventory.write_text(json.dumps(value))
            with self.assertRaisesRegex(RuntimeError,'bytes changed'):fetch.verify_input(output,lock)
    def test_compiler_language_resources_are_adjacent_and_independently_verified(self):
        self.assertIsNotNone(fetch,'Canonical reviewed MSVC producer is missing')
        with tempfile.TemporaryDirectory() as folder:
            base=Path(folder);archives=base/'archives';archives.mkdir();lock=fetch.load_lock()
            for row in lock['payloads']:
                buffer=io.BytesIO()
                with zipfile.ZipFile(buffer,'w') as z:
                    for name in row['required']:z.writestr(name,b'Inert fixture; never execute')
                raw=buffer.getvalue();row['sha256']=hashlib.sha256(raw).hexdigest();(archives/row['filename']).write_bytes(raw)
            raw=b'Inert Nuitka fixture';lock['nuitka']['sha256']=hashlib.sha256(raw).hexdigest();(archives/lock['nuitka']['filename']).write_bytes(raw)
            with patch.object(fetch,'load_lock',return_value=lock):output=fetch.acquire(base/'input',archives)
            resource=output/'payloads/msvc-tools/Contents/VC/Tools/MSVC/14.51.36231/bin/Hostx64/x64/1033/clui.dll'
            self.assertTrue(resource.is_file(),'MSVC cannot load a resource from a separate package directory')
            self.assertEqual(resource.read_bytes(),b'Inert fixture; never execute')
            fetch.verify_input(output,lock)
            resource.write_bytes(b'Altered derived resource; never execute')
            with self.assertRaisesRegex(RuntimeError,'bytes changed'):fetch.verify_input(output,lock)

if __name__=='__main__':unittest.main()
