"""Exact notices and fail-closed package resources, independent of legal clearance."""
import hashlib,importlib.util,json,os,shutil,subprocess,sys,tempfile,unittest
from importlib import metadata
from pathlib import Path
from unittest.mock import patch
ROOT=Path(__file__).resolve().parents[2]
spec=importlib.util.spec_from_file_location('dependency_notice_builder',ROOT/'launcher/build_portable.py')
builder=importlib.util.module_from_spec(spec);spec.loader.exec_module(builder)
spec=importlib.util.find_spec('notice_bundle')
if spec:
    import notice_bundle as notices
else:notices=None
from mono_launcher import verify_runtime_manifest,LaunchError
SOURCE=ROOT/'launcher/licenses/windows-python-dependencies'

class DependencyNoticeTests(unittest.TestCase):
    def require_validator(self):self.assertIsNotNone(notices,'Shared dependency-notice validator is missing')
    def test_prepare_delivers_the_complete_reviewed_corpus(self):
        with tempfile.TemporaryDirectory() as folder:
            stage=builder.prepare(Path(folder)/'stage');manifest=json.loads((stage/'runtime/manifest.json').read_text())
            self.assertIn('pythonNotices',manifest,'Frozen package omits dependency-notice inventory')
            data=stage/'runtime/licenses/python-dependencies';index=json.loads((data/'INDEX.json').read_text())
            self.assertEqual(len(index['components']),13);self.assertEqual(len(index['files']),33)
            self.assertEqual({c['id'] for c in index['components']},{'bottle','cffi','clr_loader','packaging','proxy_tools','pycparser','pyinstaller','pythonnet','pywebview','setuptools','typing_extensions','wheel','webview2-sdk'})
            by_component={c['id']:[r for r in index['files'] if r['component']==c['id']] for c in index['components']}
            self.assertEqual(by_component['proxy_tools'][0]['sha256'],'a428fb8a2e762af3eb0a6edbbb88e9b42ccfee80fd9b423958bcacf9b9abbfe4')
            self.assertEqual({r['sha256'] for r in by_component['webview2-sdk']},{'0af8f1b807512aae39c2ac1aa4d0cae65cabecb6fd554b8439a5162a0d6eca55','106423785c5b7eba0a8e61d1837f2132e9c828e20ad530f565d981c1df60dd90'})
            verify_runtime_manifest(stage)
            for case in ['missing-file','changed-file','missing-descriptor','rewritten-index']:
                with self.subTest(case=case):
                    entry=data/index['files'][0]['path'];original=entry.read_bytes();index_file=data/'INDEX.json';index_bytes=index_file.read_bytes();manifest_bytes=(stage/'runtime/manifest.json').read_bytes()
                    try:
                        if case=='missing-file':entry.unlink()
                        elif case=='changed-file':entry.write_bytes(original[:-1]+bytes([original[-1]^1]))
                        elif case=='missing-descriptor':
                            v=json.loads(manifest_bytes);del v['pythonNotices'];(stage/'runtime/manifest.json').write_text(json.dumps(v))
                        else:
                            entry.write_bytes(b'not the upstream license');v=json.loads(index_bytes);v['files'][0].update(size=entry.stat().st_size,sha256=hashlib.sha256(entry.read_bytes()).hexdigest());index_file.write_text(json.dumps(v))
                        with self.assertRaises(LaunchError):verify_runtime_manifest(stage)
                    finally:entry.write_bytes(original);index_file.write_bytes(index_bytes);(stage/'runtime/manifest.json').write_bytes(manifest_bytes)
    def test_source_corpus_has_no_uninventoried_files_or_changed_text(self):
        self.require_validator()
        with tempfile.TemporaryDirectory() as folder:
            copied=Path(folder)/'input';shutil.copytree(SOURCE,copied);value=notices.inspect_input(copied)
            first=copied/value['files'][0]['path'];original=first.read_bytes()
            first.write_bytes(b'wrong text')
            with self.assertRaises(RuntimeError):notices.inspect_input(copied)
            first.write_bytes(original);(copied/'unreviewed.txt').write_bytes(b'extra')
            with self.assertRaises(RuntimeError):notices.inspect_input(copied)
    def test_rewritten_source_index_cannot_authorize_replaced_notice(self):
        self.require_validator()
        with tempfile.TemporaryDirectory() as folder:
            copied=Path(folder)/'input';shutil.copytree(SOURCE,copied);index=copied/'INDEX.json';value=json.loads(index.read_text());file=copied/value['files'][0]['path'];file.write_bytes(b'replacement')
            value['files'][0].update(size=file.stat().st_size,sha256=hashlib.sha256(file.read_bytes()).hexdigest());index.write_text(json.dumps(value))
            with self.assertRaisesRegex(RuntimeError,'index|Index'):notices.inspect_input(copied)
    def test_build_environment_rejects_stale_dependency_or_sdk_bytes(self):
        self.require_validator();value=notices.inspect_input(SOURCE);notices.verify_build_environment(value)
        original=metadata.version
        with patch('importlib.metadata.version',side_effect=lambda name:'0.0.0' if name=='pywebview' else original(name)):
            with self.assertRaisesRegex(RuntimeError,'version'):notices.verify_build_environment(value)
        from importlib.metadata import distribution
        dist=distribution('pywebview')
        with tempfile.TemporaryDirectory() as folder:
            fake=Path(folder);(fake/'webview/lib').mkdir(parents=True)
            with patch.object(type(dist),'locate_file',return_value=fake/'missing.dll'):
                with self.assertRaises(RuntimeError):notices.verify_build_environment(value)
    def test_old_interpreter_cannot_ship_the_selected_runtime_notice(self):
        self.require_validator();value=notices.inspect_input(SOURCE)
        with patch.object(sys,'version_info',(3,12,10)):
            with self.assertRaisesRegex(RuntimeError,'runtime|Python'):notices.verify_build_environment(value)
    def test_linked_notice_cannot_escape_inventory(self):
        self.require_validator()
        with tempfile.TemporaryDirectory() as folder:
            base=Path(folder);copied=base/'input';shutil.copytree(SOURCE,copied);value=notices.inspect_input(copied);file=copied/value['files'][0]['path'];original=file.read_bytes();link=file.parent;external=base/'external';link.rename(external)
            if os.name=='nt':
                self.assertTrue(all(not any(c in str(p) for c in '&|<>^%!\r\n') for p in [link,external]),'Invalid command fixture path')
                result=subprocess.run([str(Path(os.environ['SYSTEMROOT'])/'System32/cmd.exe'),'/d','/c','mklink','/J',str(link),str(external)],capture_output=True)
                self.assertEqual(result.returncode,0,'Private junction fixture creation failed');self.assertTrue(link.is_junction())
            else:link.symlink_to(external,target_is_directory=True)
            try:
                self.assertEqual(file.read_bytes(),original,'Link must resolve to an otherwise byte-valid positive control')
                with self.assertRaises(RuntimeError):notices.inspect_input(copied)
            finally:
                if os.name=='nt':link.rmdir()
                else:link.unlink()
            self.assertEqual((external/file.name).read_bytes(),original,'External fixture bytes must remain untouched')
    def test_existing_notice_destination_is_preserved(self):
        self.require_validator()
        with tempfile.TemporaryDirectory() as folder:
            stage=Path(folder)/'stage';target=stage/'runtime/licenses/python-dependencies';target.mkdir(parents=True);sentinel=target/'keep';sentinel.write_bytes(b'keep')
            with self.assertRaises(FileExistsError):notices.stage_bundle(SOURCE,stage)
            self.assertEqual(sentinel.read_bytes(),b'keep')

if __name__=='__main__':unittest.main()
