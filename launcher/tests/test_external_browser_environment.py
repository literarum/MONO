"""External browser must not inherit the frozen application's DLL search state."""
import importlib.util
import os
from pathlib import Path
import sys
import tempfile
import threading
import unittest
from unittest.mock import Mock, patch

ROOT=Path(__file__).resolve().parents[2]
SPEC=importlib.util.spec_from_file_location('mono_external_browser_launcher',ROOT/'launcher/mono_launcher.py')
mono=importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(mono)


class LoaderState:
    """Win32 boundary model: nonempty added directory is inherited at spawn."""
    def __init__(self,directory):
        self.current=directory
        self.calls=[]
    def get(self):return self.current
    def set(self,value):
        self.calls.append(value)
        self.current=value


class ExternalBrowserEnvironmentTests(unittest.TestCase):
    def frozen(self,api,bundle):
        import contextlib
        stack=contextlib.ExitStack()
        stack.enter_context(patch.object(mono,'bundled',return_value=True))
        stack.enter_context(patch.object(mono.sys,'platform','win32'))
        stack.enter_context(patch.object(mono.sys,'_MEIPASS',bundle,create=True))
        stack.enter_context(patch.object(mono,'_windows_dll_directory_api',return_value=api,create=True))
        return stack

    @unittest.skipUnless(sys.platform=='win32' and os.environ.get('MONO_RELEASE_TOOLCHAIN')=='1','Requires the pinned Windows x64 release toolchain (set MONO_RELEASE_TOOLCHAIN=1)')

    def test_frozen_windows_chrome_gets_neutral_loader_and_clean_child_path(self):
        with tempfile.TemporaryDirectory() as tmp:
            bundle=str(Path(tmp)/'frozen bundle')
            api=LoaderState(bundle)
            original_path=';'.join([bundle,bundle+'\\plugins',bundle+'-neighbor',r'C:\Windows\System32'])
            environment={'PATH':original_path,'MONO_TEST_SENTINEL':'preserved'}
            expected_process=object()
            def spawn(arguments,**kwargs):
                self.assertIsNone(api.current,'Frozen DLL directory leaked to system Chrome at spawn')
                self.assertEqual(kwargs['env']['PATH'],';'.join([bundle+'-neighbor',r'C:\Windows\System32']))
                self.assertEqual(kwargs['env']['MONO_TEST_SENTINEL'],'preserved')
                self.assertEqual(os.environ['PATH'],original_path,'Parent environment must remain unchanged')
                self.assertFalse(any(a.startswith('--user-data-dir') for a in arguments),'the person\'s own browser profile')
                self.assertIn('--app='+mono.URL+'/?window=mono',arguments)
                self.assertEqual(arguments[0],r'C:\InstalledChrome\chrome.exe')
                return expected_process
            # The factory is an OS boundary, not a replacement for production
            # open_in_browser or its scoped environment logic. It is unused on RED.
            with patch.object(mono,'bundled',return_value=True),patch.object(mono.sys,'platform','win32'),patch.object(mono.sys,'_MEIPASS',bundle,create=True),patch.dict(os.environ,environment,clear=True),patch.object(mono,'_windows_dll_directory_api',return_value=api,create=True),patch.object(mono.subprocess,'Popen',side_effect=spawn):
                mono.open_in_browser(mono.URL,browser=lambda:('chromium',r'C:\InstalledChrome\chrome.exe'))
            self.assertEqual(api.current,bundle,'The frozen loader directory must be restored')
            self.assertEqual(api.calls,[None,bundle])

    def test_developer_launch_keeps_existing_subprocess_contract(self):
        with tempfile.TemporaryDirectory() as tmp:
            with patch.object(mono,'bundled',return_value=False),patch.object(mono.subprocess,'Popen') as spawn:
                mono.open_in_browser(mono.URL,browser=lambda:('chromium','/installed/chrome'))
            self.assertNotIn('env',spawn.call_args.kwargs)

    def test_path_case_quotes_unicode_neighbors_and_other_drives(self):
        bundle=r'C:\Студия\_MEI123'
        entries=[bundle,'"c:/студия/_mei123/plugins"',bundle+'-other',r'C:\Windows\System32',r'D:\Tools',r'\\server\share\tools','']
        expected=';'.join(entries[2:])
        api=LoaderState(bundle)
        with self.frozen(api,bundle),patch.dict(os.environ,{'PATH':';'.join(entries)},clear=True),mono._external_browser_environment() as child:
            self.assertEqual(child['PATH'],expected)
            self.assertEqual(os.environ['PATH'],';'.join(entries))
        self.assertEqual(api.current,bundle)

    def test_absent_path_is_not_added(self):
        api=LoaderState(r'C:\Bundle')
        with self.frozen(api,r'C:\Bundle'),patch.dict(os.environ,{'SENTINEL':'keep'},clear=True),mono._external_browser_environment() as child:
            self.assertNotIn('PATH',child)
            self.assertEqual(child,{'SENTINEL':'keep'})

    def test_nonwindows_frozen_browser_does_not_modify_loader_or_environment(self):
        with patch.object(mono,'bundled',return_value=True),patch.object(mono.sys,'platform','darwin'),patch.object(mono,'_windows_dll_directory_api') as api:
            with mono._external_browser_environment() as child:self.assertIsNone(child)
            api.assert_not_called()

    def test_no_explicit_directory_never_changes_cwd_exclusion_state(self):
        api=LoaderState(None)
        with self.frozen(api,r'C:\Bundle'),mono._external_browser_environment():
            self.assertIsNone(api.current)
        self.assertEqual(api.calls,[])

    def test_query_failure_does_not_start_chrome(self):
        api=LoaderState(r'C:\Bundle')
        api.get=Mock(side_effect=mono.LaunchError('query failure'))
        with tempfile.TemporaryDirectory() as tmp,self.frozen(api,r'C:\Bundle'),patch.object(mono.subprocess,'Popen') as spawn:
            with self.assertRaisesRegex(mono.LaunchError,'query failure'):
                mono.open_in_browser(mono.URL,browser=lambda:('chromium','/installed/chrome'))
            spawn.assert_not_called()
        self.assertEqual(api.calls,[])

    def test_reset_failure_restores_and_does_not_start_chrome(self):
        api=LoaderState(r'C:\Bundle')
        def set_directory(value):
            api.calls.append(value)
            if value is None:raise mono.LaunchError('reset failure')
            api.current=value
        api.set=set_directory
        with tempfile.TemporaryDirectory() as tmp,self.frozen(api,r'C:\Bundle'),patch.object(mono.subprocess,'Popen') as spawn:
            with self.assertRaisesRegex(mono.LaunchError,'reset failure'):
                mono.open_in_browser(mono.URL,browser=lambda:('chromium','/installed/chrome'))
            spawn.assert_not_called()
        self.assertEqual(api.calls,[None,r'C:\Bundle'])

    def test_spawn_failure_restores_original_directory_and_parent_environment(self):
        api=LoaderState(r'C:\Bundle')
        with tempfile.TemporaryDirectory() as tmp,self.frozen(api,r'C:\Bundle'),patch.dict(os.environ,{'PATH':r'C:\Bundle;C:\Windows'},clear=True),patch.object(mono.subprocess,'Popen',side_effect=OSError('spawn failure')):
            with self.assertRaisesRegex(OSError,'spawn failure'):
                mono.open_in_browser(mono.URL,browser=lambda:('chromium','/installed/chrome'))
            self.assertEqual(os.environ['PATH'],r'C:\Bundle;C:\Windows')
        self.assertEqual(api.current,r'C:\Bundle')
        self.assertEqual(api.calls,[None,r'C:\Bundle'])

    def test_failed_restore_aborts_engine_fallback(self):
        api=LoaderState(r'C:\Bundle')
        def set_directory(value):
            if value is not None:raise mono.LaunchError('restore failure')
            api.current=None
        api.set=set_directory
        with tempfile.TemporaryDirectory() as tmp,self.frozen(api,r'C:\Bundle'),patch.object(mono,'default_browser',return_value=('chromium','/installed/chrome')),patch.object(mono.subprocess,'Popen'),patch.object(mono,'launch_native') as native,patch.object(mono,'serve_browser') as served,patch.dict(sys.modules,{'webview':Mock()}):
            with self.assertRaises(mono.LaunchError):
                mono.launch_window(Path(tmp),mono.URL,Mock())
            served.assert_not_called()
            native.assert_not_called()

    def test_overlapping_spawns_are_serialized_and_each_restores(self):
        api=LoaderState(r'C:\Bundle')
        entered=threading.Event();release=threading.Event();second_body=threading.Event()
        errors=[]
        def first():
            try:
                with mono._external_browser_environment():
                    self.assertIsNone(api.current);entered.set()
                    self.assertTrue(release.wait(3))
            except BaseException as error:errors.append(error)
        def second():
            try:
                with mono._external_browser_environment():
                    self.assertIsNone(api.current);second_body.set()
            except BaseException as error:errors.append(error)
        with self.frozen(api,r'C:\Bundle'):
            a=threading.Thread(target=first);b=threading.Thread(target=second)
            a.start()
            try:
                self.assertTrue(entered.wait(3));b.start()
                self.assertFalse(second_body.wait(.05),'Second spawn entered while first loader reset was active')
            finally:
                release.set();a.join(3)
                if b.ident is not None:b.join(3)
            self.assertFalse(a.is_alive());self.assertFalse(b.is_alive())
        if errors:raise errors[0]
        self.assertTrue(second_body.is_set())
        self.assertEqual(api.current,r'C:\Bundle')
        self.assertEqual(api.calls,[None,r'C:\Bundle',None,r'C:\Bundle'])


if __name__=='__main__':unittest.main()
