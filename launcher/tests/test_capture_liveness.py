"""Capture liveness must survive worker stalls and unrelated staged uploads."""
import os,tempfile,unittest
from unittest import mock
from local_core.config import LocalConfig

class CaptureLivenessTests(unittest.TestCase):
    def setUp(self):
        self.folder=tempfile.TemporaryDirectory();root=self.folder.name
        self.env=mock.patch.dict(os.environ,{'MONO_CONFIG_DIR':root+'/config','MONO_DEFAULT_LIBRARY_ROOT':root+'/library'});self.env.start()
        self.config=LocalConfig();self.config.configure({'useDefault':True});self.service=self.config.capture_service()
    def tearDown(self):self.config.close();self.env.stop();self.folder.cleanup()
    def start(self):
        self.service.browser_start({'sampleRate':16000,'inputId':None,'test':False})
        clock=[0];self.service.browser.clock=lambda:clock[0];self.service.browser.last_seen=self.service.browser.last_audio=0;return clock
    def test_long_worker_request_is_not_reported_as_lost_microphone(self):
        clock=self.start();clock[0]=9_000_000_000;self.service.grace(9.0);self.service.tick()
        self.assertEqual(self.service.status()['state'],'recording')
    def test_real_silence_still_interrupts(self):
        clock=self.start();clock[0]=6_000_000_000;self.service.tick()
        self.assertEqual(self.service.status()['state'],'interrupted');self.assertEqual(self.service.status()['errorCode'],'BROWSER_CAPTURE_LOST')
    def test_pending_unrelated_stage_does_not_block_recording(self):
        self.config.allocate_stage()
        self.assertEqual(self.service.browser_start({'sampleRate':16000,'inputId':None,'test':False})['state'],'recording')
    def test_archive_transfer_still_blocks_recording(self):
        with mock.patch.object(type(self.config.transfers),'active',new_callable=mock.PropertyMock,return_value=True):
            with self.assertRaises(Exception) as caught:self.service.browser_start({'sampleRate':16000,'inputId':None,'test':False})
        self.assertEqual(caught.exception.code,'LIBRARY_BUSY')

if __name__=='__main__':unittest.main()
