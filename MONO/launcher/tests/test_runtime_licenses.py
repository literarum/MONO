import sys
import importlib.util,json,os,subprocess,tempfile,unittest
from pathlib import Path
from unittest.mock import patch

ROOT=Path(__file__).resolve().parents[2]
class RuntimeLicenseTests(unittest.TestCase):
    @unittest.skipUnless(os.environ.get('MONO_BUILD_FFMPEG_BUNDLE'),'Requires MONO_BUILD_FFMPEG_BUNDLE (built Windows FFmpeg)')
    def test_shared_input_copies_every_required_library_and_license_and_rejects_missing_or_changed_dll(self):
        from ffmpeg_bundle import read_bundle,stage_support,verify_support
        directory=Path(os.environ['MONO_BUILD_FFMPEG_BUNDLE']);value=read_bundle(directory)
        with tempfile.TemporaryDirectory() as folder:
            runtime=Path(folder)/'runtime';runtime.mkdir()
            support=stage_support(directory,runtime,value);verify_support(runtime,support)
            dlls=[entry for entry in support['files'] if entry['path'].endswith('.dll')]
            self.assertEqual(len(dlls),7);self.assertTrue((runtime/'licenses/ffmpeg/COPYING.LGPLv3').is_file());self.assertTrue((runtime/'licenses/ffmpeg/COPYING.GPLv3').is_file())
            file=runtime/dlls[0]['path'];original=file.read_bytes()
            for data in [None,b'truncated']:
                with self.subTest(data=data):
                    if data is None:file.unlink()
                    else:file.write_bytes(data)
                    with self.assertRaises(RuntimeError):verify_support(runtime,support)
                    file.write_bytes(original)
            # A checksum-consistent ARM64 DLL still cannot enter a win-x64 bundle.
            import copy,hashlib,struct
            changed=copy.deepcopy(support);wrong=bytearray(original);offset=struct.unpack_from('<I',wrong,60)[0];wrong[offset+4:offset+6]=b'\x64\xaa';file.write_bytes(wrong)
            next(v for v in changed['files'] if v['path']==dlls[0]['path'])['sha256']=hashlib.sha256(wrong).hexdigest()
            with self.assertRaises(RuntimeError):verify_support(runtime,changed)
    @unittest.skipUnless(os.environ.get('MONO_BUILD_FFMPEG_BUNDLE'),'Requires MONO_BUILD_FFMPEG_BUNDLE (built Windows FFmpeg)')
    def test_runtime_support_duplicate_and_path_traversal_cannot_replace_a_library(self):
        from ffmpeg_bundle import read_bundle,stage_support,verify_support
        import copy
        directory=Path(os.environ['MONO_BUILD_FFMPEG_BUNDLE'])
        with tempfile.TemporaryDirectory() as folder:
            runtime=Path(folder)/'runtime';runtime.mkdir();support=stage_support(directory,runtime,read_bundle(directory))
            for kind in ['duplicate','traversal']:
                changed=copy.deepcopy(support)
                if kind=='duplicate':changed['files'][0]=copy.deepcopy(changed['files'][1])
                else:changed['files'][0]['path']='../outside.dll'
                with self.assertRaises(RuntimeError):verify_support(runtime,changed)
    def test_known_license_requires_a_positive_declaration_and_rejects_nonfree_even_with_gpl_text(self):
        from runtime_licenses import classify
        self.assertEqual(classify('ffmpeg','ffmpeg version 9\nThis program is free software; you can redistribute it under the terms of the GNU Lesser General Public License as published by the Free Software Foundation; either version 2.1 of the License, or (at your option) any later version.\n'),'LGPL-2.1-or-later')
        self.assertEqual(classify('ffprobe','ffprobe version 9\nThis program is free software; you can redistribute it under the terms of the GNU General Public License as published by the Free Software Foundation; either version 3 of the License, or (at your option) any later version.\n'),'GPL-3.0-or-later')
        invalid=['', 'free software', 'ffmpeg version 9', 'GNU General Public License version 3\nconfiguration: --enable-nonfree', 'This version of ffmpeg has nonfree parts compiled in.\nTherefore it is not legally redistributable.', 'ffmpeg version 9\nGNU Lesser General Public License version 999']
        for output in invalid:
            with self.subTest(output=output):
                with self.assertRaises(RuntimeError):classify('ffmpeg',output)
    def test_inspector_fails_closed_on_exit_timeout_unknown_or_wrong_program(self):
        from runtime_licenses import inspect_license
        for result in [subprocess.CompletedProcess([],1,'GNU Lesser General Public License version 2.1',''),subprocess.CompletedProcess([],0,'unknown',''),subprocess.TimeoutExpired('fixture',20),subprocess.CompletedProcess([],0,'ffprobe version 9\nGNU Lesser General Public License version 2.1','')]:
            with self.subTest(result=str(result)):
                with patch('runtime_licenses.subprocess.run',side_effect=result if isinstance(result,Exception) else None,return_value=result):
                    with self.assertRaises(RuntimeError):inspect_license(Path('ffmpeg.exe'),'ffmpeg')
    @unittest.skipUnless(sys.platform=='win32' and os.environ.get('MONO_RELEASE_TOOLCHAIN')=='1','Requires the pinned Windows x64 release toolchain (set MONO_RELEASE_TOOLCHAIN=1)')
    def test_selected_runtime_is_inspected_before_copying_into_stage(self):
        spec=importlib.util.spec_from_file_location('license_stage_builder',ROOT/'launcher/build_portable.py');builder=importlib.util.module_from_spec(spec);spec.loader.exec_module(builder)
        with tempfile.TemporaryDirectory() as folder:
            output=Path(folder)/'stage'
            with patch.object(builder,'inspect_license',side_effect=RuntimeError('nonfree runtime rejected')) as inspect:
                with self.assertRaisesRegex(RuntimeError,'nonfree'):builder.prepare(output)
            self.assertTrue(inspect.called)
            self.assertFalse((output/'runtime/bin/ffmpeg.exe').exists())
