import os
import builtins,contextlib,importlib.util,io,json,socket,sys,threading,unittest
from pathlib import Path
from unittest.mock import Mock,patch

ROOT=Path(__file__).resolve().parents[2]
spec=importlib.util.spec_from_file_location('picker_packaging_launcher',ROOT/'launcher/mono_launcher.py')
mono=importlib.util.module_from_spec(spec);spec.loader.exec_module(mono)

class FolderPickerPackagingTests(unittest.TestCase):
    def test_health_probe_rejects_malformed_http_and_non_object_json(self):
        # A real unrelated loopback listener must never become a healthy MONO
        # instance, nor crash the launcher while it is checking availability.
        for payload in [b'GET /api/health HTTP/1.1\r\n\r\n',b'HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\n[]']:
            with self.subTest(payload=payload),socket.socket() as listener:
                listener.bind(('127.0.0.1',0));listener.listen();listener.settimeout(3)
                errors=[]
                def serve():
                    try:
                        with listener.accept()[0] as connection:
                            connection.settimeout(3);connection.recv(8192);connection.sendall(payload)
                    except Exception as error:errors.append(error)
                thread=threading.Thread(target=serve);thread.start()
                try:self.assertFalse(mono.healthy(url=f'http://127.0.0.1:{listener.getsockname()[1]}',timeout=2))
                finally:thread.join(4)
                self.assertFalse(thread.is_alive());self.assertEqual(errors,[])

    @unittest.skipUnless(importlib.util.find_spec('tkinter'),'Requires tkinter for the native folder dialog')

    def test_real_dialog_dependency_import_does_not_create_a_window(self):
        import tkinter
        with patch.object(tkinter,'Tk',side_effect=AssertionError('No UI in dependency check')) as root:
            self.assertTrue(mono.verify_folder_picker_dependencies())
        root.assert_not_called()

    def test_dependency_import_error_is_a_controlled_launcher_error(self):
        original=builtins.__import__
        def missing(name,*args,**kwargs):
            if name=='tkinter.filedialog':raise ImportError('Synthetic missing bundled child')
            return original(name,*args,**kwargs)
        with patch('builtins.__import__',side_effect=missing),self.assertRaises(mono.LaunchError):
            mono.verify_folder_picker_dependencies()

    def test_failed_picker_dependency_never_dispatches_ui_and_returns_protocol_error(self):
        child=Mock();output=io.StringIO()
        with patch.dict(sys.modules,{'local_core.folders':child}),patch.object(mono,'verify_folder_picker_dependencies',side_effect=mono.LaunchError('Missing dialog')),contextlib.redirect_stdout(output):
            self.assertEqual(mono.main(['--folder-picker','create']),1)
        self.assertEqual(json.loads(output.getvalue()),{'error':'PICKER_UNAVAILABLE'})
        child.main.assert_not_called()

    def test_bundle_verification_includes_dialog_imports(self):
        output=io.StringIO()
        with patch.object(mono,'verify_runtime_manifest'),patch.object(mono,'verify_folder_picker_dependencies',return_value=True) as check,contextlib.redirect_stdout(output):
            self.assertEqual(mono.main(['--verify-bundle']),0)
        check.assert_called_once_with()
        self.assertIs(json.loads(output.getvalue())['folderPickerImports'],True)

    def test_failed_dialog_check_fails_bundle_verification(self):
        output=io.StringIO();errors=io.StringIO()
        with patch.object(mono,'verify_runtime_manifest'),patch.object(mono,'verify_folder_picker_dependencies',side_effect=mono.LaunchError('Missing dialog')),contextlib.redirect_stdout(output),contextlib.redirect_stderr(errors):
            self.assertEqual(mono.main(['--verify-bundle']),1)
        self.assertEqual(output.getvalue(),'');self.assertIn('Missing dialog',errors.getvalue())

if __name__=='__main__':unittest.main()
