import contextlib,copy,hashlib,importlib.util,io,json,os,struct,sys,tempfile,types,unittest
from pathlib import Path
from unittest.mock import patch
ROOT=Path(__file__).resolve().parents[2]
def load(name,path):
    spec=importlib.util.spec_from_file_location(name,path);module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module);return module
builder=load('native_package_builder',ROOT/'launcher/build_portable.py');mono=load('native_package_launcher',ROOT/'launcher/mono_launcher.py')
class NativePackagingTests(unittest.TestCase):
    @unittest.skipUnless(sys.platform=='win32' and os.environ.get('MONO_RELEASE_TOOLCHAIN')=='1','Requires the pinned Windows x64 release toolchain (set MONO_RELEASE_TOOLCHAIN=1)')
    def test_frozen_manifest_is_bound_to_the_executable(self):
        with tempfile.TemporaryDirectory() as folder:
            stage=builder.prepare(Path(folder)/'stage');file=stage/'runtime/manifest.json'
            identity=types.ModuleType('_mono_build_identity');identity.EXPECTED_MANIFEST_SHA256=hashlib.sha256(file.read_bytes()).hexdigest()
            with patch.dict(sys.modules,{'_mono_build_identity':identity}),patch.object(mono,'bundled',return_value=True):
                mono.verify_runtime_manifest(stage)
                manifest=json.loads(file.read_text());manifest['application']=[v for v in manifest['application'] if v['path']!='public/app.js'];file.write_text(json.dumps(manifest))
                (stage/'backend/public/app.js').unlink()
                with self.assertRaisesRegex(mono.LaunchError,'identity|Identity'):mono.verify_runtime_manifest(stage)
    @unittest.skipUnless(sys.platform=='win32' and os.environ.get('MONO_RELEASE_TOOLCHAIN')=='1','Requires the pinned Windows x64 release toolchain (set MONO_RELEASE_TOOLCHAIN=1)')
    def test_duplicate_runtime_entry_cannot_replace_a_required_binary(self):
        with tempfile.TemporaryDirectory() as folder:
            stage=builder.prepare(Path(folder)/'stage');file=stage/'runtime/manifest.json';manifest=json.loads(file.read_text())
            manifest['runtime'][2]=copy.deepcopy(manifest['runtime'][0]);file.write_text(json.dumps(manifest))
            with self.assertRaises(mono.LaunchError):mono.verify_runtime_manifest(stage)
    @unittest.skipUnless(sys.platform=='win32' and os.environ.get('MONO_RELEASE_TOOLCHAIN')=='1','Requires the pinned Windows x64 release toolchain (set MONO_RELEASE_TOOLCHAIN=1)')
    def test_packager_freezes_staged_sources_and_rejects_post_prepare_mutation(self):
        with tempfile.TemporaryDirectory() as folder:
            stage=builder.prepare(Path(folder)/'stage');entry=stage/'launcher/mono_launcher.py'
            self.assertEqual(entry.read_bytes(),(ROOT/'launcher/mono_launcher.py').read_bytes())
            with patch.dict(sys.modules,{'PyInstaller':types.ModuleType('PyInstaller')}),patch.object(builder.subprocess,'run') as invoke:
                builder.build(stage,Path(folder)/'output')
            self.assertIn(str(entry),invoke.call_args.args[0]);self.assertNotIn(str(ROOT/'launcher/mono_launcher.py'),invoke.call_args.args[0])
            self.assertIn(str(stage/'launcher')+os.pathsep+'launcher',invoke.call_args.args[0],'All inventoried source/icon audit resources must accompany frozen code')
            entry.write_bytes(entry.read_bytes()+b'\n# post-prepare drift\n')
            with patch.dict(sys.modules,{'PyInstaller':types.ModuleType('PyInstaller')}),patch.object(builder.subprocess,'run') as invoke:
                with self.assertRaisesRegex(RuntimeError,'staged|Staged|snapshot'):builder.build(stage,Path(folder)/'output-drift')
                invoke.assert_not_called()
    def test_verifier_diagnostics_are_utf8_independent_of_windows_code_page(self):
        raw=io.BytesIO();console=io.TextIOWrapper(raw,encoding='cp1251')
        message='Компоненты MONO повреждены: required resource missing'
        try:
            with patch.object(mono.sys,'stderr',console),patch.object(mono,'verify_runtime_manifest',side_effect=mono.LaunchError(message)):
                self.assertEqual(mono.main(['--verify-bundle']),1)
            console.flush()
            self.assertEqual(raw.getvalue().decode('utf-8'),'ERROR: '+message+'\n')
        finally:console.close()
    @unittest.skipUnless(sys.platform=='win32' and os.environ.get('MONO_RELEASE_TOOLCHAIN')=='1','Requires the pinned Windows x64 release toolchain (set MONO_RELEASE_TOOLCHAIN=1)')
    def test_schema_is_available_at_the_frozen_python_package_path(self):
        import local_core.library as implementation
        with tempfile.TemporaryDirectory() as folder:
            stage=builder.prepare(Path(folder)/'stage')
            # PyInstaller modules have _MEIPASS/package/module.py __file__,
            # independent of the audit copy under launcher/local_core.
            with patch.object(implementation,'__file__',str(stage/'local_core/library.py')):
                library=implementation.Library.open(Path(folder)/'library')
                try:self.assertEqual(library.list_records()['items'],[])
                finally:library.close()
    @unittest.skipUnless(sys.platform=='win32' and os.environ.get('MONO_RELEASE_TOOLCHAIN')=='1','Requires the pinned Windows x64 release toolchain (set MONO_RELEASE_TOOLCHAIN=1)')
    def test_windows_stage_requires_native_capture_binary_and_licenses(self):
        with tempfile.TemporaryDirectory() as folder:
            stage=builder.prepare(Path(folder)/'stage');manifest=json.loads((stage/'runtime/manifest.json').read_text())
            if os.name=='nt':
                capture=manifest['capture'];self.assertEqual(capture['rid'],'win-x64')
                names={item['path'] for item in capture['files']};self.assertIn('MonoAudio.exe',names);self.assertIn('DOTNET_LICENSE.txt',names);self.assertIn('DOTNET_THIRD_PARTY_NOTICES.txt',names)
                for item in capture['files']:self.assertTrue((stage/'runtime/native'/item['path']).is_file())
            else:self.assertEqual(manifest['platform'],os.sys.platform)
    def test_missing_explicit_native_build_input_is_rejected_before_complete_stage(self):
        if os.name!='nt':
            self.assertTrue((ROOT/'native/windows/MonoAudio.csproj').is_file());return
        with tempfile.TemporaryDirectory() as folder,patch.dict(os.environ,{'MONO_BUILD_CAPTURE_BUNDLE':str(Path(folder)/'missing')}):
            with self.assertRaisesRegex(RuntimeError,'native|Native|capture|Capture'):builder.prepare(Path(folder)/'stage')
    def test_packaged_launch_never_inherits_an_arbitrary_capture_program(self):
        with tempfile.TemporaryDirectory() as folder:
            with patch.dict(os.environ,{'MONO_AUDIO_HELPER':'untrusted-program.exe'}),patch.object(mono,'bundled',return_value=True),patch.object(mono,'assets_root',return_value=Path(folder)):
                env=mono.server_environment(roots={'data':Path(folder)/'data'},executables={'node':'/runtime/node','ffmpeg':'/runtime/ffmpeg','ffprobe':'/runtime/ffprobe'})
                self.assertNotEqual(env.get('MONO_AUDIO_HELPER'),'untrusted-program.exe')
                self.assertEqual(Path(env['MONO_AUDIO_HELPER']).parent,Path(folder)/'runtime/native')
    @unittest.skipUnless(sys.platform=='win32' and os.environ.get('MONO_RELEASE_TOOLCHAIN')=='1','Requires the pinned Windows x64 release toolchain (set MONO_RELEASE_TOOLCHAIN=1)')
    def test_bundle_verification_cli_does_not_start_the_server_or_open_an_archive(self):
        with tempfile.TemporaryDirectory() as folder:
            stage=builder.prepare(Path(folder)/'stage');output=io.StringIO()
            with patch.object(mono,'assets_root',return_value=stage),patch.object(mono,'run',side_effect=AssertionError('Verification must not start the app')),contextlib.redirect_stdout(output):
                result=mono.main(['--verify-bundle'])
            self.assertEqual(result,0);self.assertTrue(json.loads(output.getvalue())['ok'])
    @unittest.skipUnless(sys.platform not in ('win32','darwin') or os.environ.get('MONO_RELEASE_TOOLCHAIN')=='1','On Windows/macOS packaging requires release inputs (native helper bundle); set MONO_RELEASE_TOOLCHAIN=1')
    def test_capture_inventory_tampering_missing_license_and_consistent_wrong_cpu_are_rejected(self):
        if os.name!='nt':
            from native_bundle import require_amd64
            with tempfile.TemporaryDirectory() as folder:
                file=Path(folder)/'wrong';file.write_bytes(b'not a PE')
                with self.assertRaises(RuntimeError):require_amd64(file)
            return
        from native_bundle import sha256
        with tempfile.TemporaryDirectory() as folder:
            stage=builder.prepare(Path(folder)/'stage');mono.verify_runtime_manifest(stage)
            manifest_file=stage/'runtime/manifest.json';original=json.loads(manifest_file.read_text());native=stage/'runtime/native'
            for mutation in ['missing','duplicate','license','checksum','wrong-cpu']:
                with self.subTest(mutation=mutation):
                    changed=copy.deepcopy(original);saved=None;file=None;position=None
                    if mutation=='missing':changed.pop('capture')
                    elif mutation=='duplicate':changed['capture']['files'][0]=copy.deepcopy(changed['capture']['files'][1])
                    elif mutation=='license':file=native/'DOTNET_LICENSE.txt';saved=file.read_bytes();file.unlink()
                    else:
                        file=native/'MonoAudio.exe'
                        with file.open('r+b') as stream:
                            stream.seek(60);offset=struct.unpack('<I',stream.read(4))[0];position=offset+4 if mutation=='wrong-cpu' else file.stat().st_size-1
                            stream.seek(position);saved=stream.read(2 if mutation=='wrong-cpu' else 1);stream.seek(position);stream.write(b'\x64\xaa' if mutation=='wrong-cpu' else bytes([saved[0]^1]))
                        if mutation=='wrong-cpu':
                            entry=next(v for v in changed['capture']['files'] if v['path']=='MonoAudio.exe');entry['sha256']=sha256(file)
                    manifest_file.write_text(json.dumps(changed))
                    try:
                        with self.assertRaises(mono.LaunchError) as result:mono.verify_runtime_manifest(stage)
                        if mutation=='wrong-cpu':self.assertIn('AMD64',str(result.exception),'CPU oracle must reject architecture independently of checksum')
                    finally:
                        if file and saved is not None:
                            if position is None:file.write_bytes(saved)
                            else:
                                with file.open('r+b') as stream:stream.seek(position);stream.write(saved)
                        manifest_file.write_text(json.dumps(original))
            mono.verify_runtime_manifest(stage)
