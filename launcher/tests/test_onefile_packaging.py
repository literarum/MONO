"""Windows format dispatch only; actual frozen onefile acceptance is separate."""
import importlib.util,json,os,sys,tempfile,unittest
from pathlib import Path
from unittest.mock import Mock,patch

ROOT=Path(__file__).resolve().parents[2]
spec=importlib.util.spec_from_file_location('onefile_builder_test',ROOT/'launcher/build_portable.py');builder=importlib.util.module_from_spec(spec);spec.loader.exec_module(builder)

class OnefilePackagingTests(unittest.TestCase):
    def test_onefile_selects_standard_bootloader_and_keeps_onedir_default(self):
        for onefile in [False,True]:
            with self.subTest(onefile=onefile),tempfile.TemporaryDirectory() as folder:
                base=Path(folder);stage=base/'stage';(stage/'runtime').mkdir(parents=True);(stage/'runtime/manifest.json').write_text('{}')
                with patch.object(builder,'validate_stage') as validate,patch.dict(sys.modules,{'PyInstaller':Mock()}),patch.object(builder.subprocess,'run') as run:
                    if onefile:builder.build(stage,base/'output',onefile=True)
                    else:builder.build(stage,base/'output')
                command=run.call_args.args[0]
                self.assertIn('--onefile' if onefile else '--onedir',command)
                self.assertNotIn('--onedir' if onefile else '--onefile',command)
                self.assertIn('--noupx',command,'Unreviewed ambient executable packers must not enter the build')
                self.assertEqual(validate.call_count,2,'Original snapshot checks must surround both formats')
                self.assertEqual(run.call_args.kwargs,{'check':True})
    def test_onefile_existing_output_is_preserved_before_stage_or_process(self):
        with tempfile.TemporaryDirectory() as folder:
            base=Path(folder);output=base/'output';output.mkdir();sentinel=output/'keep';sentinel.write_bytes(b'keep')
            with patch.object(builder,'validate_stage',side_effect=AssertionError('Stage accessed before output guard')) as validate,patch.object(builder.subprocess,'run',side_effect=AssertionError('Unexpected process')) as run:
                with self.assertRaises(FileExistsError):builder.build(base/'missing-stage',output,onefile=True)
                validate.assert_not_called();run.assert_not_called()
            self.assertEqual(sentinel.read_bytes(),b'keep')
    def test_cli_routes_explicit_flag_and_preserves_existing_output(self):
        with tempfile.TemporaryDirectory() as folder:
            base=Path(folder);stage=base/'stage';(stage/'runtime').mkdir(parents=True);(stage/'runtime/manifest.json').write_text('{}');output=base/'output'
            args=['build_portable.py','--onefile','--stage',str(stage),'--output',str(output)]
            with patch.object(sys,'argv',args),patch.object(builder,'prepare',return_value=stage),patch.object(builder,'build',return_value=output) as build:
                self.assertEqual(builder.main(),0)
                build.assert_called_once_with(stage,output,onefile=True)
            output.mkdir();(output/'keep').write_bytes(b'keep')
            with patch.object(sys,'argv',args),patch.object(builder,'prepare',side_effect=AssertionError('Preparation before output guard')) as prepare:
                with self.assertRaises(FileExistsError):builder.main()
                prepare.assert_not_called()
            self.assertEqual((output/'keep').read_bytes(),b'keep')
    def test_onefile_is_rejected_on_other_platforms_before_stage_creation(self):
        with tempfile.TemporaryDirectory() as folder:
            base=Path(folder)
            with patch.object(builder.sys,'platform','darwin'),patch.object(builder,'validate_stage',side_effect=AssertionError('Unexpected stage access')) as validate:
                with self.assertRaisesRegex(RuntimeError,'Windows'):builder.build(base/'missing',base/'output',onefile=True)
                validate.assert_not_called()
            self.assertFalse((base/'output').exists())

if __name__=='__main__':unittest.main()
