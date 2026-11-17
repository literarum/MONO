import os,tempfile,unittest
from pathlib import Path
from unittest.mock import patch
from local_core.config import LocalConfig
from local_core.protocol import CoreError
class CompletedDialog:
    def __init__(self,path):self.path=path
    def poll(self):return self.path or False
    def close(self):pass
class PendingDialog:
    closed=False
    def poll(self):return None
    def close(self):self.closed=True

class FolderChoices(unittest.TestCase):
    def test_pending_picker_can_be_cancelled_without_blocking_worker_or_config_changes(self):
        with tempfile.TemporaryDirectory() as temp,patch.dict(os.environ,{'MONO_CONFIG_DIR':str(Path(temp)/'config')}):
            config=LocalConfig();dialog=PendingDialog()
            try:
                with patch('local_core.config.choose_folder',return_value=dialog):pending=config.choose({'purpose':'backup'})
                self.assertTrue(pending['pending']);self.assertFalse(config.status()['libraryConfigured'])
                self.assertEqual(config.cancel_choice({'id':pending['id']}),{'cancelled':True});self.assertTrue(dialog.closed);self.assertIsNone(config.picker);self.assertFalse(config.file.exists())
            finally:config.close()
    def test_cancel_is_effect_free_and_selection_is_one_time(self):
        with tempfile.TemporaryDirectory() as temp,patch.dict(os.environ,{'MONO_CONFIG_DIR':str(Path(temp)/'config')}):
            config=LocalConfig()
            try:
                with patch('local_core.config.choose_folder',return_value=CompletedDialog(None)):self.assertEqual(config.choose({'purpose':'create'}),{'cancelled':True})
                self.assertFalse(config.file.exists())
                target=Path(temp)/'Выбранная папка'
                with patch('local_core.config.choose_folder',return_value=CompletedDialog(target)):choice=config.choose({'purpose':'create'})
                self.assertFalse(target.exists());self.assertNotIn('path',choice)
                status=config.configure({'choiceId':choice['choiceId']});self.assertTrue(Path(status['libraryPath']).samefile(target))
                with self.assertRaises(CoreError) as caught:config.configure({'choiceId':choice['choiceId']})
                self.assertEqual(caught.exception.code,'INVALID_CHOICE')
                before=config.file.read_bytes()
                with self.assertRaises(CoreError):config.configure({'choiceId':str(Path(temp)/'arbitrary')})
                self.assertEqual(config.file.read_bytes(),before)
            finally:config.close()
    def test_open_rejects_non_archive_without_creating_files(self):
        with tempfile.TemporaryDirectory() as temp,patch.dict(os.environ,{'MONO_CONFIG_DIR':str(Path(temp)/'config')}):
            config=LocalConfig();target=Path(temp)/'empty';target.mkdir()
            try:
                with patch('local_core.config.choose_folder',return_value=CompletedDialog(target)):choice=config.choose({'purpose':'open'})
                with self.assertRaises(CoreError) as caught:config.configure({'choiceId':choice['choiceId']})
                self.assertEqual(caught.exception.code,'NOT_LIBRARY');self.assertEqual(list(target.iterdir()),[])
            finally:config.close()
