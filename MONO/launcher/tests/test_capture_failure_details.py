import os, tempfile, time, unittest
from pathlib import Path
from unittest.mock import patch
from local_core.config import LocalConfig
from local_core.capture import CaptureService

class CaptureFailureDetailsTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory()
        self.env=patch.dict(os.environ,{'MONO_CONFIG_DIR':str(Path(self.temp.name)/'config'),'MONO_DEFAULT_LIBRARY_ROOT':str(Path(self.temp.name)/'library')})
        self.env.start();self.config=LocalConfig();self.config.configure({'useDefault':True})
        self.service=CaptureService(self.config)
        self.service.session_id='current';self.service.state='requesting'
    def tearDown(self):
        self.service.close();self.config.close();self.env.stop();self.temp.cleanup()
    def error(self,**fields):
        self.service._event({'v':1,'seq':self.service.last_seq+1,'event':'error','sessionId':'current','code':'INTERNAL',**fields})
    def test_windows_failure_retains_exact_safe_details_and_original_error(self):
        self.error(stage='capture-mic/initialize',nativeCode='80070057')
        value=self.service.status()
        self.assertEqual(value['errorCode'],'INTERNAL')
        self.assertEqual(value.get('failureDetails'),{'stage':'capture-mic/initialize','nativeCode':'80070057'})
        self.assertEqual(value['savedBytes'],0)
    def test_optional_details_never_turn_a_real_failure_into_protocol_error(self):
        for fields in [{},{'stage':None,'nativeCode':None},{'stage':'private-device-key','nativeCode':'private-message'},{'stage':[], 'nativeCode':{}},{'stage':'capture-mic/initialize','nativeCode':'80070057\nPRIVATE'}]:
            with self.subTest(fields=fields):
                self.service.state='requesting';self.service.error=None
                self.error(**fields)
                self.assertEqual(self.service.status()['errorCode'],'INTERNAL')
                self.assertIsNone(self.service.status().get('failureDetails'))
    def test_foreign_session_cannot_set_details(self):
        self.error(sessionId='foreign',stage='capture-mic/initialize',nativeCode='80070057')
        self.assertIsNone(self.service.status().get('failureDetails'))
        self.assertIsNone(self.service.status()['errorCode'])
    def test_safe_stage_without_hresult_is_retained_for_native_non_com_failures(self):
        self.error(stage='coordinator',nativeCode=None)
        self.assertEqual(self.service.status().get('failureDetails'),{'stage':'coordinator','nativeCode':None})
    def test_generic_fault_clears_previous_native_details(self):
        self.error(stage='capture-system/initialize',nativeCode='80070057')
        self.service.state='requesting';self.service._interrupt('ARCHIVE_IO_ERROR')
        self.assertIsNone(self.service.status().get('failureDetails'))
    def test_snapshot_cannot_modify_supervisor_details(self):
        self.error(stage='capture-mic/initialize',nativeCode='80070057')
        self.service.status()['failureDetails']['stage']='private-tampered-value'
        self.assertEqual(self.service.status()['failureDetails']['stage'],'capture-mic/initialize')
    def test_old_generation_cannot_supply_details_to_current_session(self):
        self.service.events.put((self.service.generation-1,'event',{'v':1,'seq':0,'event':'error','sessionId':'current','code':'INTERNAL','stage':'capture-mic/initialize','nativeCode':'80070057'}))
        self.service.last_seen=time.monotonic();self.service.tick()
        self.assertIsNone(self.service.status().get('failureDetails'))
        self.assertIsNone(self.service.status()['errorCode'])
