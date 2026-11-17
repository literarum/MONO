"""Pinned maintained Windows interpreter/ABI; no foreign runtime execution."""
import json,sys,tempfile,unittest
from pathlib import Path
from unittest.mock import patch
import build_core,core_bundle
ROOT=Path(__file__).resolve().parents[2]

class RuntimeSecurityBaselineTests(unittest.TestCase):
    def test_production_interpreter_and_core_abi_are_the_reviewed_security_baseline(self):
        lock=json.loads((ROOT/'launcher/compiler-msvc-windows.lock.json').read_text())
        self.assertEqual(lock['python'],'3.14.8')
        self.assertEqual(core_bundle.TAG,'cp314-win_amd64')
        self.assertEqual(core_bundle.BINARY,'local_core.cp314-win_amd64.pyd')
        gui=(ROOT/'launcher/requirements-build-windows.lock').read_text()
        self.assertIn('3222ba5d678f80a030e6afbcc33dc1ae5cb45facabb61cee2c7016b8432fde48',gui)
        self.assertNotIn('f53e442b08449d42821fa4a4fba000095af9f62742a500f978a9f557ec44339a',gui)
    def test_old_and_unreviewed_python_are_denied_before_compiler_input_or_subprocess(self):
        for version in [(3,12,10),(3,14,7),(3,14,9)]:
            with self.subTest(version=version),tempfile.TemporaryDirectory() as folder:
                with patch.object(build_core.sys,'version_info',version),patch.object(build_core.metadata,'version',return_value='4.3.1'),patch.object(build_core,'read_input',side_effect=AssertionError('Wrong interpreter reached compiler inputs')) as read,patch.object(build_core.subprocess,'run',side_effect=AssertionError('Wrong interpreter started compiler')) as run:
                    with self.assertRaisesRegex(RuntimeError,'pinned Python'):build_core.build(Path(folder)/'output',Path(folder)/'compiler',Path(folder)/'nuitka')
                    read.assert_not_called();run.assert_not_called()
                self.assertFalse((Path(folder)/'output').exists())
    def test_previous_abi_capsule_cannot_be_reused(self):
        from test_compiled_core_packaging import capsule
        with tempfile.TemporaryDirectory() as folder:
            base=Path(folder);value=capsule(base/'input');value['pythonTag']='cp312-win_amd64'
            (base/'input/PROVENANCE.json').write_text(json.dumps(value),encoding='utf-8')
            with patch.object(core_bundle.sys,'version_info',(3,12,10)):
                with self.assertRaises(RuntimeError):core_bundle.read_build_bundle(base/'input',ROOT/'launcher/local_core')
    def test_free_threaded_abi_is_denied_before_input_or_import(self):
        from test_compiled_core_packaging import capsule
        with tempfile.TemporaryDirectory() as folder:
            base=Path(folder);capsule(base/'input')
            with patch('sysconfig.get_config_var',return_value=1),patch.object(build_core.metadata,'version',return_value='4.3.1'),patch.object(build_core,'read_input',side_effect=AssertionError('Free-threaded runtime reached compiler inputs')) as read:
                with self.assertRaisesRegex(RuntimeError,'pinned Python'):build_core.build(base/'output',base/'compiler',base/'nuitka')
                read.assert_not_called()
                with self.assertRaises(RuntimeError):core_bundle.read_build_bundle(base/'input',ROOT/'launcher/local_core')
    def test_same_abi_with_unreviewed_patch_version_is_not_a_release_input(self):
        from test_compiled_core_packaging import capsule
        with tempfile.TemporaryDirectory() as folder:
            base=Path(folder);capsule(base/'input')
            for version in [(3,14,7),(3,14,9)]:
                with self.subTest(version=version),patch.object(core_bundle.sys,'version_info',version):
                    with self.assertRaises(RuntimeError):core_bundle.read_build_bundle(base/'input',ROOT/'launcher/local_core')

if __name__=='__main__':unittest.main()
