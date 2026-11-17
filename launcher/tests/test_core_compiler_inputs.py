import sys,os
import hashlib,importlib.util,io,json,struct,tarfile,tempfile,unittest,zipfile
from pathlib import Path
from unittest.mock import patch
ROOT=Path(__file__).resolve().parents[2]
def optional(name,path):
    if not path.is_file():return None
    spec=importlib.util.spec_from_file_location(name,path);module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module);return module
fetch=optional('compiler_fetch_test',ROOT/'launcher/fetch_compiler_windows.py')
builder=optional('core_compile_test',ROOT/'launcher/build_core.py')
class CompilerInputTests(unittest.TestCase):
    def test_existing_acquisition_output_is_preserved_before_network(self):
        self.assertIsNotNone(fetch,'Canonical compiler acquisition is missing')
        with tempfile.TemporaryDirectory() as folder:
            output=Path(folder)/'output';output.mkdir();sentinel=output/'keep';sentinel.write_bytes(b'keep')
            with patch.object(fetch.urllib.request,'urlopen',side_effect=AssertionError('Network before output guard')) as network:
                with self.assertRaises(FileExistsError):fetch.acquire(output)
                network.assert_not_called()
            self.assertEqual(sentinel.read_bytes(),b'keep')
    def test_existing_compilation_output_is_preserved_before_subprocess(self):
        self.assertIsNotNone(builder,'Canonical native-core builder is missing')
        with tempfile.TemporaryDirectory() as folder:
            output=Path(folder)/'output';output.mkdir();sentinel=output/'keep';sentinel.write_bytes(b'keep')
            with patch.object(builder.subprocess,'run',side_effect=AssertionError('Process before output guard')) as run:
                with self.assertRaises(FileExistsError):builder.build(output,Path(folder)/'input',Path(folder)/'nuitka')
                run.assert_not_called()
            self.assertEqual(sentinel.read_bytes(),b'keep')
    def test_wrong_compiler_hash_is_refused_before_unpack_or_network(self):
        self.assertIsNotNone(fetch,'Canonical compiler acquisition is missing')
        with tempfile.TemporaryDirectory() as folder:
            base=Path(folder);archive=base/'wrong.zip';archive.write_bytes(b'unverified')
            with patch.object(fetch.urllib.request,'urlopen',side_effect=AssertionError('Unexpected network')) as network:
                with self.assertRaisesRegex(RuntimeError,'checksum|hash|Checksum'):fetch.acquire(base/'output',archive=archive)
                network.assert_not_called()
            self.assertFalse(list((base/'output').rglob('*.exe')))
    def test_checksum_consistent_raw_bad_names_are_rejected(self):
        self.assertIsNotNone(fetch,'Canonical compiler acquisition is missing')
        for bad in ['../escape.exe','mingw64/../escape.exe','/mingw64/absolute.exe','mingw64/bin/evil.exe:stream','mingw64/bin/evil.','mingw64/bin/CON.txt']:
            with self.subTest(name=bad),tempfile.TemporaryDirectory() as folder:
                base=Path(folder);archive=base/'fixture.zip'
                required=['gcc.exe','g++.exe','as.exe','ld.exe','windres.exe']
                with io.BytesIO() as valid:
                    with zipfile.ZipFile(valid,'w') as z:
                        for name in required:z.writestr('mingw64/bin/'+name,b'Inert fixture - never execute')
                    self.assertTrue(fetch.inspect_archive(valid.getvalue()),'Valid fixture must satisfy the independent positive control')
                with zipfile.ZipFile(archive,'w') as z:
                    for name in required:z.writestr('mingw64/bin/'+name,b'Inert fixture - never execute')
                    z.writestr(bad,b'forbidden')
                lock=json.loads((ROOT/'launcher/compiler-windows.lock.json').read_text());lock['compiler']['sha256']=hashlib.sha256(archive.read_bytes()).hexdigest()
                with patch.object(fetch,'load_lock',return_value=lock),patch.object(fetch.urllib.request,'urlopen',side_effect=AssertionError('Unexpected network')),patch.object(fetch,'write_payload',side_effect=AssertionError('Untrusted path reached extraction')) as extract:
                    with self.assertRaises(RuntimeError):fetch.acquire(base/'output',archive=archive)
                    extract.assert_not_called()
                self.assertFalse((base/'escape.exe').exists())
    @unittest.skipUnless(sys.platform=='win32' and os.environ.get('MONO_RELEASE_TOOLCHAIN')=='1','Requires the pinned Windows x64 release toolchain (set MONO_RELEASE_TOOLCHAIN=1)')
    def test_wrong_nuitka_hash_and_unreviewed_version_never_start_compiler(self):
        self.assertIsNotNone(builder,'Canonical native-core builder is missing')
        for version in ['4.3.1','999.0']:
            with self.subTest(version=version),tempfile.TemporaryDirectory() as folder:
                base=Path(folder);archive=base/'wrong.tar.gz';archive.write_bytes(b'bad source')
                with patch.object(builder.metadata,'version',return_value=version),patch.object(builder.subprocess,'run',side_effect=AssertionError('Unverified compiler execution')) as run:
                    with self.assertRaisesRegex(RuntimeError,'Nuitka|nuitka|checksum|version'):builder.build(base/'output',base/'missing-input',archive)
                    run.assert_not_called()
    def test_modified_compiler_and_rewritten_manifest_still_fail_archive_comparison(self):
        self.assertIsNotNone(fetch,'Canonical compiler acquisition is missing')
        with tempfile.TemporaryDirectory() as folder:
            base=Path(folder);archive=base/'compiler.zip';nuitka=base/'source.tar.gz';nuitka.write_bytes(b'Inert source fixture')
            with zipfile.ZipFile(archive,'w') as z:
                for name in ['gcc.exe','g++.exe','as.exe','ld.exe','windres.exe']:z.writestr('mingw64/bin/'+name,b'Inert compiler fixture - never execute')
            lock=json.loads((ROOT/'launcher/compiler-windows.lock.json').read_text())
            lock['compiler']['sha256']=hashlib.sha256(archive.read_bytes()).hexdigest();lock['nuitka']['sha256']=hashlib.sha256(nuitka.read_bytes()).hexdigest()
            with patch.object(fetch,'load_lock',return_value=lock),patch.object(fetch.urllib.request,'urlopen',side_effect=AssertionError('Unexpected network')):
                output=fetch.acquire(base/'input',archive,nuitka)
            gcc=fetch.verify_input(output,lock);self.assertEqual(gcc.read_bytes(),b'Inert compiler fixture - never execute')
            gcc.write_bytes(b'Altered compiler - never execute')
            provenance=output/'PROVENANCE.json';value=json.loads(provenance.read_text())
            row=next(v for v in value['files'] if v['path']=='mingw64/bin/gcc.exe');row.update(size=gcc.stat().st_size,sha256=hashlib.sha256(gcc.read_bytes()).hexdigest());provenance.write_text(json.dumps(value))
            with self.assertRaisesRegex(RuntimeError,'bytes changed'):fetch.verify_input(output,lock)
    def test_similar_package_prefix_is_not_an_allowlisted_local_namespace(self):
        from core_bundle import source_inventory
        with tempfile.TemporaryDirectory() as folder:
            root=Path(folder);(root/'schema.sql').write_text('SELECT 1;');(root/'worker.py').write_text('import local_core_unreviewed_dependency\n')
            with self.assertRaisesRegex(ValueError,'dependency'):source_inventory(root)
    @unittest.skipUnless(sys.platform=='win32' and os.environ.get('MONO_RELEASE_TOOLCHAIN')=='1','Requires the pinned Windows x64 release toolchain (set MONO_RELEASE_TOOLCHAIN=1)')
    def test_source_set_or_snapshot_drift_cannot_emit_a_capsule(self):
        self.assertIsNotNone(builder,'Canonical native-core builder is missing')
        for change in ['added-source','changed-snapshot']:
            with self.subTest(change=change),tempfile.TemporaryDirectory() as folder:
                base=Path(folder);project=base/'project';source=project/'launcher/local_core';source.mkdir(parents=True)
                (source/'worker.py').write_text('value = 1\n');(source/'schema.sql').write_text('SELECT 1;')
                with io.BytesIO() as buf:
                    with tarfile.open(fileobj=buf,mode='w:gz') as tar:
                        for name in ['LICENSE.txt','LICENSE-RUNTIME.txt']:
                            data=b'Inert unit notice';info=tarfile.TarInfo('nuitka-4.3.1/'+name);info.size=len(data);tar.addfile(info,io.BytesIO(data))
                    raw=buf.getvalue()
                archive=base/'source.tar.gz';archive.write_bytes(raw);lock=json.loads((ROOT/'launcher/compiler-msvc-windows.lock.json').read_text());lock['nuitka']['sha256']=hashlib.sha256(raw).hexdigest()
                def mutate_after_compile(command,**kwargs):
                    self.assertNotIn('--mingw64',command,'The maintained interpreter requires the reviewed MSVC toolchain')
                    for name in ['CL','_CL_','LINK','_LINK_']:self.assertTrue(name not in kwargs['env'],'Ambient compiler option entered the native build: '+name)
                    snapshot=Path(command[-1]);output=snapshot.parent.parent;native=output/'native';native.mkdir()
                    pe=bytearray(128);pe[:2]=b'MZ';struct.pack_into('<I',pe,60,64);pe[64:68]=b'PE\0\0';struct.pack_into('<H',pe,68,0x8664);struct.pack_into('<H',pe,88,0x20b);(native/'local_core.cp314-win_amd64.pyd').write_bytes(pe)
                    if change=='added-source':(source/'unexpected.py').write_text('value = 2\n')
                    else:(snapshot/'worker.py').write_text('value = 2\n')
                with patch.dict(builder.os.environ,{'CL':'injected-option','_CL_':'injected-option','LINK':'injected-option','_LINK_':'injected-option'}),patch.object(builder,'PROJECT',project),patch.object(builder,'load_lock',return_value=lock),patch.object(builder.metadata,'version',return_value='4.3.1'),patch.object(builder,'verify_input',return_value=base/'never-execute-compiler'),patch.object(builder.subprocess,'run',side_effect=mutate_after_compile) as run:
                    with self.assertRaises(RuntimeError):builder.build(base/'output',base/'sdk',archive)
                    run.assert_called_once()
                self.assertFalse((base/'output/bundle').exists(),'Source drift must fail before emitting a payload')
if __name__=='__main__':unittest.main()
