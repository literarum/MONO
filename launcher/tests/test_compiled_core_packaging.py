import ast,copy,hashlib,importlib.util,io,json,os,struct,sys,tempfile,unittest
from pathlib import Path
from unittest.mock import patch,Mock

ROOT=Path(__file__).resolve().parents[2]
def load(name,path):
    spec=importlib.util.spec_from_file_location(name,path);module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module);return module
builder=load('compiled_core_test_builder',ROOT/'launcher/build_portable.py')
mono=load('compiled_core_test_launcher',ROOT/'launcher/mono_launcher.py')
BINARY='local_core.cp314-win_amd64.pyd'
def digest(file):return hashlib.sha256(file.read_bytes()).hexdigest()
def inputs():
    rows=[];imports=set()
    for p in sorted((ROOT/'launcher/local_core').iterdir()):
        if p.suffix not in ['.py','.sql']:continue
        rows.append({'path':p.name,'sha256':digest(p)})
        if p.suffix=='.py':
            for node in ast.walk(ast.parse(p.read_text(encoding='utf-8'))):
                if isinstance(node,ast.Import):imports.update(n.name for n in node.names)
                elif isinstance(node,ast.ImportFrom) and node.module:imports.add(node.module)
    imports=sorted(x for x in imports if not x.startswith('local_core'))
    return rows,hashlib.sha256(json.dumps(rows,sort_keys=True,separators=(',',':')).encode()).hexdigest(),imports
def capsule(root):
    root.mkdir();pe=bytearray(128);pe[:2]=b'MZ';struct.pack_into('<I',pe,60,64);pe[64:68]=b'PE\0\0';struct.pack_into('<H',pe,68,0x8664);struct.pack_into('<H',pe,88,0x20b)
    (root/BINARY).write_bytes(pe)
    for name in ['NUITKA_LICENSE.txt','NUITKA_RUNTIME_EXCEPTION.txt']:(root/name).write_text('Synthetic unit notice; never execute or release this PE fixture',encoding='utf-8')
    sources,source_hash,imports=inputs()
    value={'schema':1,'module':'local_core','pythonTag':'cp314-win_amd64','sourceFiles':sources,'sourceHash':source_hash,'stdlibImports':imports,'compiler':{'nuitka':'4.3.1','msvc':'14.51.36260','windowsSdk':'10.0.26100.9169'},'files':[{'path':p.name,'size':p.stat().st_size,'sha256':digest(p)} for p in sorted(root.iterdir())]}
    (root/'PROVENANCE.json').write_text(json.dumps(value),encoding='utf-8');return value

class CompiledCorePackagingTests(unittest.TestCase):
    @unittest.skipUnless(sys.platform=='win32' and os.environ.get('MONO_RELEASE_TOOLCHAIN')=='1','Requires the pinned Windows x64 release toolchain (set MONO_RELEASE_TOOLCHAIN=1)')
    def test_explicit_compiled_input_stages_active_binary_and_omits_core_python_source(self):
        with tempfile.TemporaryDirectory() as folder:
            base=Path(folder);capsule(base/'input')
            with patch.dict(os.environ,{'MONO_BUILD_CORE_BUNDLE':str(base/'input')}):stage=builder.prepare(base/'stage')
            self.assertTrue((stage/BINARY).is_file(),'Active compiled module omitted')
            self.assertFalse(list((stage/'launcher/local_core').glob('*.py')),'Compiled input silently replaced by source audit copy')
            manifest=json.loads((stage/'runtime/manifest.json').read_text());self.assertEqual(manifest['compiledCore']['pythonTag'],'cp314-win_amd64')
            for name in ['NUITKA_LICENSE.txt','NUITKA_RUNTIME_EXCEPTION.txt','PROVENANCE.json']:self.assertTrue((stage/'runtime/licenses/core'/name).is_file())
            mono.verify_runtime_manifest(stage)
    def test_explicit_missing_compiled_input_cannot_fall_back_to_source(self):
        with tempfile.TemporaryDirectory() as folder,patch.dict(os.environ,{'MONO_BUILD_CORE_BUNDLE':str(Path(folder)/'missing')}):
            with self.assertRaisesRegex(RuntimeError,'core|Core|compiled'):builder.prepare(Path(folder)/'stage')
    @unittest.skipUnless(sys.platform=='win32' and os.environ.get('MONO_RELEASE_TOOLCHAIN')=='1','Requires the pinned Windows x64 release toolchain (set MONO_RELEASE_TOOLCHAIN=1)')
    def test_active_binary_checksum_and_cpu_are_verified(self):
        with tempfile.TemporaryDirectory() as folder:
            base=Path(folder);capsule(base/'input')
            with patch.dict(os.environ,{'MONO_BUILD_CORE_BUNDLE':str(base/'input')}):stage=builder.prepare(base/'stage')
            active=stage/BINARY;self.assertTrue(active.is_file(),'Active compiled module omitted')
            original=active.read_bytes();active.write_bytes(b'bad')
            with self.assertRaises(mono.LaunchError):mono.verify_runtime_manifest(stage)
            active.write_bytes(original);bad=bytearray(original);struct.pack_into('<H',bad,68,0xaa64);active.write_bytes(bad)
            file=stage/'runtime/manifest.json';value=json.loads(file.read_text());entry=next(v for v in value['compiledCore']['files'] if v['path']==BINARY);entry['sha256']=digest(active);file.write_text(json.dumps(value))
            with self.assertRaises(mono.LaunchError):mono.verify_runtime_manifest(stage)
    def test_invalid_capsule_inventory_and_source_are_refused(self):
        for case in ['duplicate','traversal','missing-notice','stale-source','extra-file','null-root']:
            with self.subTest(case=case),tempfile.TemporaryDirectory() as folder:
                base=Path(folder);value=capsule(base/'input');file=base/'input/PROVENANCE.json'
                if case=='duplicate':value['files'][1]=copy.deepcopy(value['files'][0])
                elif case=='traversal':value['files'][0]['path']='../outside.pyd'
                elif case=='missing-notice':(base/'input/NUITKA_LICENSE.txt').unlink()
                elif case=='stale-source':value['sourceFiles'][0]['sha256']='0'*64
                elif case=='extra-file':(base/'input/raw-source.py').write_text('unwanted')
                elif case=='null-root':value=None
                file.write_text(json.dumps(value),encoding='utf-8')
                with patch.dict(os.environ,{'MONO_BUILD_CORE_BUNDLE':str(base/'input')}),self.assertRaises(RuntimeError):builder.prepare(base/'stage')
    @unittest.skipUnless(sys.platform=='win32' and os.environ.get('MONO_RELEASE_TOOLCHAIN')=='1','Requires the pinned Windows x64 release toolchain (set MONO_RELEASE_TOOLCHAIN=1)')
    def test_compiled_build_selects_native_module_and_explicit_standard_library_imports(self):
        with tempfile.TemporaryDirectory() as folder:
            base=Path(folder);capsule(base/'input')
            with patch.dict(os.environ,{'MONO_BUILD_CORE_BUNDLE':str(base/'input')}):stage=builder.prepare(base/'stage')
            with patch.dict(sys.modules,{'PyInstaller':Mock()}),patch.object(builder.subprocess,'run') as run:
                builder.build(stage,base/'output')
            command=run.call_args.args[0];self.assertIn(str(stage/BINARY)+os.pathsep+'.',command)
            self.assertIn('--hidden-import=sqlite3',command);self.assertIn('--hidden-import=ctypes',command)
    def test_frozen_private_entries_refuse_before_worker_or_picker_execution(self):
        for option,module in [('--core-worker','local_core.worker'),('--folder-picker','local_core.folders')]:
            with self.subTest(option=option):
                fake=Mock();fake.main.return_value=17;errors=io.StringIO()
                with patch.dict(sys.modules,{module:fake}),patch.object(mono,'bundled',return_value=True),patch.object(mono,'assets_root',return_value=ROOT),patch.object(mono,'verify_runtime_manifest',side_effect=mono.LaunchError('Compiled core damaged')) as verify,patch.object(mono.sys,'stderr',errors):
                    self.assertEqual(mono.main([option]),1)
                verify.assert_called_once();fake.main.assert_not_called()
    @unittest.skipUnless(sys.platform=='win32' and os.environ.get('MONO_RELEASE_TOOLCHAIN')=='1','Requires the pinned Windows x64 release toolchain (set MONO_RELEASE_TOOLCHAIN=1)')
    def test_extra_python_package_cannot_shadow_the_native_import(self):
        with tempfile.TemporaryDirectory() as folder:
            base=Path(folder);capsule(base/'input')
            with patch.dict(os.environ,{'MONO_BUILD_CORE_BUNDLE':str(base/'input')}):stage=builder.prepare(base/'stage')
            (stage/'local_core/__init__.py').write_text('raise AssertionError("Unverified replacement package executed")',encoding='utf-8')
            with self.assertRaises(mono.LaunchError):mono.verify_runtime_manifest(stage)

if __name__=='__main__':unittest.main()
