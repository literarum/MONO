"""Exact selected-runtime notice, not a claim of complete legal clearance."""
import hashlib,importlib.util,json,os,sys,tempfile,unittest
from pathlib import Path
from unittest.mock import Mock,patch

ROOT=Path(__file__).resolve().parents[2]
spec=importlib.util.spec_from_file_location('python_notice_builder',ROOT/'launcher/build_portable.py')
builder=importlib.util.module_from_spec(spec);spec.loader.exec_module(builder)
from mono_launcher import verify_runtime_manifest,LaunchError
NOTICE_SHA='935cf13e19f8c31b497d20b05d73623431a226b230c3599bc30fa3348979bc68'

class PythonNoticeTests(unittest.TestCase):
    def test_prepare_inventories_the_exact_full_python_notice(self):
        with tempfile.TemporaryDirectory() as folder:
            stage=builder.prepare(Path(folder)/'stage');notice=stage/'PYTHON_LICENSE.txt'
            self.assertTrue(notice.is_file(),'Full Python runtime license omitted from stage')
            data=notice.read_bytes();self.assertEqual(hashlib.sha256(data).hexdigest(),NOTICE_SHA)
            manifest=json.loads((stage/'runtime/manifest.json').read_text())
            rows=[row for row in manifest['resources'] if row['path']=='PYTHON_LICENSE.txt']
            self.assertEqual(rows,[{'path':'PYTHON_LICENSE.txt','size':35407,'sha256':NOTICE_SHA}])
            verify_runtime_manifest(stage)

    def test_missing_or_changed_reviewed_input_is_refused(self):
        with tempfile.TemporaryDirectory() as folder:
            base=Path(folder)
            for case,data in [('missing',None),('changed',b'Python license checklist is not the license')]:
                with self.subTest(case=case):
                    source=base/(case+'.txt')
                    if data is not None:source.write_bytes(data)
                    with patch.object(builder,'PYTHON_LICENSE_SOURCE',source,create=True):
                        with self.assertRaisesRegex(RuntimeError,'Python.*license|Python.*notice'):
                            builder.prepare(base/('stage-'+case))

    def test_runtime_rejects_missing_changed_and_removed_inventory(self):
        with tempfile.TemporaryDirectory() as folder:
            stage=builder.prepare(Path(folder)/'stage');notice=stage/'PYTHON_LICENSE.txt'
            self.assertTrue(notice.is_file(),'Full Python runtime license omitted from stage')
            original=notice.read_bytes();file=stage/'runtime/manifest.json';manifest=file.read_bytes()
            for case in ['missing','changed','removed-inventory']:
                with self.subTest(case=case):
                    notice.write_bytes(original);file.write_bytes(manifest)
                    if case=='changed':notice.write_bytes(original[:-1]+bytes([original[-1]^1]))
                    else:notice.unlink()
                    if case=='removed-inventory':
                        value=json.loads(manifest);value['resources']=[r for r in value['resources'] if r['path']!='PYTHON_LICENSE.txt'];file.write_text(json.dumps(value))
                    with self.assertRaises(LaunchError):verify_runtime_manifest(stage)

    def test_both_formats_include_the_inventoried_notice(self):
        with tempfile.TemporaryDirectory() as folder:
            base=Path(folder);stage=builder.prepare(base/'stage')
            for onefile in [False,True]:
                with self.subTest(onefile=onefile),patch.dict(sys.modules,{'PyInstaller':Mock()}),patch.object(builder.subprocess,'run') as run:
                    builder.build(stage,base/('onefile' if onefile else 'onedir'),onefile=onefile)
                    command=run.call_args.args[0]
                    self.assertIn(str(stage/'PYTHON_LICENSE.txt')+os.pathsep+'.',command,'Frozen package omits required Python notice')

if __name__=='__main__':unittest.main()
