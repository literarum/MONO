"""October Node release gate: check bytes before any process execution."""
import hashlib,importlib.util,io,json,struct,tempfile,unittest,zipfile
from pathlib import Path
from unittest.mock import patch
try:import node_windows as node
except ImportError:node=None

def digest(raw):return hashlib.sha256(raw).hexdigest()
def pe(machine=0x8664):
    raw=bytearray(128);raw[:2]=b'MZ';struct.pack_into('<I',raw,60,64)
    raw[64:68]=b'PE\0\0';struct.pack_into('<H',raw,68,machine);struct.pack_into('<H',raw,88,0x20b)
    return bytes(raw)

class NodeWindowsTests(unittest.TestCase):
    def setUp(self):self.assertIsNotNone(node,'Pinned Node security-release input/gate is missing')
    def test_policy_names_the_advisory_fixed_binary_and_license(self):
        self.assertEqual(node.VERSION,'v24.22.1')
        self.assertEqual(node.EXE_SHA256,'d702daa815eabbff763c7d3808e235cf031cf2ca70211b56847bc72f51e240e5')
        self.assertEqual(node.ARCHIVE_SHA256,'d2046d28c2c3dcd211ac5145c0bf30e2047ef9dfb306693c8c6e2eccd8b95fa5')
        self.assertEqual(node.LICENSE_SHA256,'ed34dd8e3f0a78dbaf00d0444ce8e285b015b765379c2e17880455f70370f8e9')
    def test_matching_bytes_are_required_and_file_names_do_not_imply_trust(self):
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp);exe=root/'node.exe';license=root/'LICENSE';exe.write_bytes(pe());license.write_bytes(b'fixture license')
            with patch.object(node,'EXE_SHA256',digest(pe())),patch.object(node,'LICENSE_SHA256',digest(b'fixture license')):
                self.assertEqual(node.verify_files(exe,license)['version'],'v24.22.1')
                for target in [exe,license]:
                    original=target.read_bytes();target.write_bytes(original+b'tampered')
                    with self.assertRaises(RuntimeError):node.verify_files(exe,license)
                    target.write_bytes(original)
                license.unlink()
                with self.assertRaises(RuntimeError):node.verify_files(exe,license)
    def test_unreviewed_bytes_stay_denied_after_adjacent_provenance_rewrite(self):
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp);exe=root/'node.exe';license=root/'LICENSE';exe.write_bytes(pe());license.write_bytes(b'not the selected license')
            (root/'PROVENANCE.json').write_text(json.dumps({'version':'v24.22.1','nodeSha256':digest(pe()),'licenseSha256':digest(license.read_bytes())}),encoding='utf-8')
            with self.assertRaises(RuntimeError):node.verify_files(exe,license)
    def test_even_matching_fixture_hash_cannot_admit_wrong_cpu(self):
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp);raw=pe(0x14c);(root/'node.exe').write_bytes(raw);(root/'LICENSE').write_bytes(b'fixture license')
            with patch.object(node,'EXE_SHA256',digest(raw)),patch.object(node,'LICENSE_SHA256',digest(b'fixture license')):
                with self.assertRaises(RuntimeError):node.verify_files(root/'node.exe',root/'LICENSE')
    def test_existing_output_is_preserved_before_network_or_archive_read(self):
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp);sentinel=root/'keep';sentinel.write_bytes(b'keep')
            with patch.object(node.urllib.request,'urlopen',side_effect=AssertionError('Network reached')):
                with self.assertRaises(FileExistsError):node.acquire(root)
            self.assertEqual(sentinel.read_bytes(),b'keep')
    def test_wrong_archive_never_publishes_an_executable(self):
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp);archive=root/'bad.zip';archive.write_bytes(b'bad archive')
            with self.assertRaises(RuntimeError):node.acquire(root/'output',archive)
            self.assertFalse((root/'output'/'node.exe').exists())
    def test_fixed_name_members_only_are_published_after_all_checks(self):
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp);archive=root/'fixture.zip';license=b'fixture license';raw=pe()
            with zipfile.ZipFile(archive,'w') as writer:
                writer.writestr('node-v24.22.1-win-x64/node.exe',raw);writer.writestr('node-v24.22.1-win-x64/LICENSE',license)
                writer.writestr('../escaped',b'never extracted')
            with patch.object(node,'ARCHIVE_SHA256',digest(archive.read_bytes())),patch.object(node,'EXE_SHA256',digest(raw)),patch.object(node,'LICENSE_SHA256',digest(license)):
                node.acquire(root/'output',archive)
            self.assertEqual({file.name for file in (root/'output').iterdir()},{'node.exe','LICENSE','PROVENANCE.json'})
            self.assertFalse((root/'escaped').exists())
    def test_release_verifier_rejects_wrong_node_before_starting_any_child(self):
        script=Path(__file__).resolve().parents[2]/'scripts/verify-package.py'
        spec=importlib.util.spec_from_file_location('node_release_package_verifier',script)
        verifier=importlib.util.module_from_spec(spec);spec.loader.exec_module(verifier)
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp);assets=root/'_internal';(assets/'runtime/bin').mkdir(parents=True)
            (assets/'runtime/bin/node.exe').write_bytes(pe());(assets/'NODE_LICENSE.txt').write_bytes(b'unreviewed')
            (assets/'runtime/manifest.json').write_text('{}',encoding='utf-8')
            with patch.object(verifier.sys,'argv',[str(script),str(root),'--execute','--require-node-baseline']),patch.object(verifier,'verify_runtime_manifest'),patch.object(verifier.subprocess,'run',side_effect=AssertionError('Unreviewed input reached execution')) as run:
                with self.assertRaisesRegex(RuntimeError,'Node security runtime'):verifier.main()
                run.assert_not_called()

if __name__=='__main__':unittest.main()
