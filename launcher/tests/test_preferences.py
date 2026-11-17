import copy,os,tempfile,unittest
from pathlib import Path
from unittest.mock import patch
from local_core.config import LocalConfig
from local_core.protocol import CoreError
try:from local_core.preferences import Preferences
except ImportError:Preferences=None

class PreferencesTests(unittest.TestCase):
    def test_setup_progress_and_capture_preferences_survive_restart_without_changing_archive_pointer(self):
        self.assertIsNotNone(Preferences)
        with tempfile.TemporaryDirectory() as folder,patch.dict(os.environ,{'MONO_CONFIG_DIR':str(Path(folder)/'config'),'MONO_DEFAULT_LIBRARY_ROOT':str(Path(folder)/'library')}):
            config=LocalConfig();config.configure({'useDefault':True});original=config.settings['libraryRoot'];prefs=Preferences(config)
            self.assertFalse(prefs.get()['onboarding']['completed']);prefs.update({'onboarding':{'keySkipped':True},'capture':{'mode':'both','inputId':'selected-mic','outputId':'selected-output'},'dismissedHints':['meeting-headphones']});config.close();config=LocalConfig()
            try:
                stored=Preferences(config).get();self.assertTrue(stored['onboarding']['keySkipped']);self.assertFalse(stored['onboarding']['soundTested']);self.assertEqual(stored['capture'],{'mode':'both','inputId':'selected-mic','outputId':'selected-output'});self.assertEqual(stored['dismissedHints'],['meeting-headphones']);self.assertEqual(config.settings['libraryRoot'],original)
                before=copy.deepcopy(config.settings)
                for change in [{'libraryRoot':'other'},{'capture':{'mode':'invalid'}},{'onboarding':{'completed':'true'}},{'onboarding':{'arbitrary':True}},{'dismissedHints':['x'*101]},{'key':'gsk_do_not_store_here'},{'capture':{'inputId':'x'*4097}}]:
                    with self.subTest(change=list(change)):
                        with self.assertRaises(CoreError):Preferences(config).update(change)
                        self.assertEqual(config.settings,before)
            finally:config.close()
