import os,tempfile,unittest
from pathlib import Path
from unittest.mock import patch
from local_core.config import LocalConfig
from local_core.protocol import CoreError

class BrowserSupervisorTests(unittest.TestCase):
 def setUp(self):
  self.temp=tempfile.TemporaryDirectory();self.env=patch.dict(os.environ,{'MONO_CONFIG_DIR':str(Path(self.temp.name)/'config'),'MONO_DEFAULT_LIBRARY_ROOT':str(Path(self.temp.name)/'library')});self.env.start();self.config=LocalConfig();self.config.configure({'useDefault':True});self.service=self.config.capture_service()
 def tearDown(self):self.config.close();self.env.stop();self.temp.cleanup()
 def test_browser_and_native_share_one_exclusive_supervisor(self):
  first=self.service.browser_start({'sampleRate':16000});self.assertTrue(self.service.active);self.assertEqual(self.service.status()['recordId'],first['recordId'])
  with self.assertRaises(CoreError) as caught:self.service.start({'mode':'mic'})
  self.assertEqual(caught.exception.code,'CAPTURE_BUSY')
  self.service.capabilities();self.assertEqual(self.service.status()['recordId'],first['recordId']);self.assertIsNone(self.service.child)
 def test_other_window_can_request_stop_without_claiming_saved(self):
  first=self.service.browser_start({'sampleRate':16000});stopping=self.service.stop();self.assertEqual(stopping['state'],'stopping')
  result=self.service.browser_call('finish',{'sessionId':first['sessionId'],'frames':0});self.assertEqual(result['state'],'interrupted');self.assertFalse(self.service.active)
 def test_close_marks_browser_session_interrupted(self):
  first=self.service.browser_start({'sampleRate':16000});self.service.close();self.assertFalse(self.service.active);self.assertEqual(self.config.get_library().get_record(first['recordId'])['status'],'interrupted')

if __name__=='__main__':unittest.main(verbosity=2)
