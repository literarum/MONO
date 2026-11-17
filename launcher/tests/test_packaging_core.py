import importlib.util, tempfile, unittest
from unittest.mock import patch
from pathlib import Path
ROOT=Path(__file__).resolve().parents[2]
spec=importlib.util.spec_from_file_location('bundle_builder',ROOT/'launcher/build_portable.py')
builder=importlib.util.module_from_spec(spec);spec.loader.exec_module(builder)
class PackagingCoreTests(unittest.TestCase):
    def test_existing_stage_is_never_deleted_or_overwritten(self):
        with tempfile.TemporaryDirectory() as temp:
            stage=Path(temp)/'stage';stage.mkdir();sentinel=stage/'keep.txt';sentinel.write_bytes(b'preserve staging work')
            with patch.object(builder.shutil,'rmtree',side_effect=AssertionError('Unsafe existing stage cleanup')) as removal:
                with self.assertRaises(FileExistsError):builder.prepare(stage)
                removal.assert_not_called()
            self.assertEqual(sentinel.read_bytes(),b'preserve staging work')
    def test_existing_output_is_rejected_before_build_process_is_started(self):
        with tempfile.TemporaryDirectory() as temp:
            output=Path(temp)/'output';output.mkdir();sentinel=output/'release.txt';sentinel.write_bytes(b'preserve release')
            with patch.object(builder.subprocess,'run') as run:
                with self.assertRaises(FileExistsError):builder.build(Path(temp)/'stage',output)
                run.assert_not_called()
            self.assertEqual(sentinel.read_bytes(),b'preserve release')
    def test_package_contains_real_server_dependencies_and_private_worker(self):
        with tempfile.TemporaryDirectory() as temp:
            stage=builder.prepare(Path(temp)/'stage')
            self.assertTrue((stage/'backend/backend/local/routes.mjs').is_file(),'Node module dependency omitted')
            self.assertTrue((stage/'launcher/local_core/worker.py').is_file(),'Python worker omitted')
            self.assertTrue((stage/'launcher/local_core/schema.sql').is_file(),'SQLite schema omitted')
    def test_altered_private_worker_is_rejected_by_runtime_integrity_check(self):
        spec=importlib.util.spec_from_file_location('launcher_integrity',ROOT/'launcher/mono_launcher.py');mono=importlib.util.module_from_spec(spec);spec.loader.exec_module(mono)
        with tempfile.TemporaryDirectory() as temp:
            stage=builder.prepare(Path(temp)/'stage');mono.verify_runtime_manifest(stage)
            with (stage/'launcher/local_core/library.py').open('ab') as stream:stream.write(b'\n# unexpected modification\n')
            with self.assertRaises(mono.LaunchError):mono.verify_runtime_manifest(stage)
