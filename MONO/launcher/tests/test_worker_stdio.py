import json,os,subprocess,sys,tempfile,unittest
from pathlib import Path

class WorkerStdioTests(unittest.TestCase):
    def test_private_worker_uses_inherited_pipes_including_windows_gui_interpreter(self):
        root=Path(__file__).resolve().parents[2];executable=Path(sys.executable).with_name('pythonw.exe') if sys.platform=='win32' else Path(sys.executable)
        self.assertTrue(executable.is_file(),'Required GUI interpreter for the packaging regression is unavailable')
        with tempfile.TemporaryDirectory() as folder:
            requests='\n'.join(json.dumps({'v':1,'id':str(i),'method':method,'params':{}}) for i,method in enumerate(['ping','credentials.status','preferences.get']))+'\n'
            result=subprocess.run([str(executable),str(root/'launcher/mono_launcher.py'),'--core-worker'],input=requests,capture_output=True,text=True,encoding='utf-8',timeout=10,env={**os.environ,'MONO_CONFIG_DIR':str(Path(folder)/'config'),'PYTHONUTF8':'1'})
            self.assertEqual(result.returncode,0,result.stderr);replies=[json.loads(line) for line in result.stdout.splitlines()];self.assertTrue(replies,'GUI worker silently lost the inherited stdout pipe');self.assertEqual(replies[0],{'event':'ready','protocol':1});self.assertEqual(replies[1]['result']['protocol'],1);self.assertIn('configured',replies[2]['result']);self.assertFalse(replies[3]['result']['onboarding']['completed'])
