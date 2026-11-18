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
    def test_open_on_an_empty_folder_starts_an_archive_there(self):
        # Was: refused with NOT_LIBRARY — exactly what a person creating a fresh folder hit.
        with tempfile.TemporaryDirectory() as temp,patch.dict(os.environ,{'MONO_CONFIG_DIR':str(Path(temp)/'config')}):
            config=LocalConfig();target=Path(temp)/'empty';target.mkdir()
            try:
                with patch('local_core.config.choose_folder',return_value=CompletedDialog(target)):choice=config.choose({'purpose':'open'})
                self.assertTrue(config.configure({'choiceId':choice['choiceId']})['libraryConfigured']);self.assertTrue((target/'library.json').is_file())
            finally:config.close()

class SmartArchiveFolder(unittest.TestCase):
    """Reported: a just-created empty folder was refused with 'В этой папке нет архива MONO'."""
    def pick(self,config,path,purpose):
        with patch('local_core.config.choose_folder',return_value=CompletedDialog(str(path))):return config.choose({'purpose':purpose})['choiceId']
    def test_any_folder_is_accepted_whatever_the_button_asked_for(self):
        with tempfile.TemporaryDirectory() as temp,patch.dict(os.environ,{'MONO_CONFIG_DIR':str(Path(temp)/'config')}):
            config=LocalConfig()
            try:
                empty=Path(temp)/'Новая папка';empty.mkdir();(empty/'desktop.ini').write_text('[.ShellClassInfo]')
                status=config.configure({'choiceId':self.pick(config,empty,'open')})
                self.assertTrue(status['libraryConfigured']);self.assertTrue((empty/'library.json').is_file())
                busy=Path(temp)/'Мои документы';busy.mkdir();(busy/'отчёт.docx').write_text('x')
                status=config.configure({'choiceId':self.pick(config,busy,'open')})
                self.assertTrue((busy/'MONO Library'/'library.json').is_file());self.assertEqual((busy/'отчёт.docx').read_text(),'x')
                # Choosing the existing archive again simply reconnects it.
                status=config.configure({'choiceId':self.pick(config,empty,'create')})
                self.assertEqual(Path(status['libraryPath']).resolve(),empty.resolve())
            finally:config.close()
