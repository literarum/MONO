"""Real abrupt-process loss at durable native-segment boundaries; synthetic audio."""
import hashlib,io,json,os,subprocess,sys,tempfile,time,unittest,wave
from pathlib import Path
from local_core.config import LocalConfig
from local_core.library import Library
from local_core import capture

def crash_child(phase,root):
    os.environ['MONO_CONFIG_DIR']=str(root/'config');os.environ['MONO_DEFAULT_LIBRARY_ROOT']=str(root/'library')
    config=LocalConfig();config.configure({'useDefault':True})
    original_publish=capture.publish;original_commit=Library._commit
    def publish(source,target):
        if phase=='before-move':os._exit(73)
        original_publish(source,target)
        if phase=='after-move':os._exit(73)
    def commit(self,record,*args):
        if record.get('_segments') and phase=='before-manifest':os._exit(73)
        result=original_commit(self,record,*args)
        if record.get('_segments') and phase=='after-manifest':os._exit(73)
        return result
    capture.publish=publish;Library._commit=commit
    fixture=Path(__file__).resolve().parents[2]/'tests/fixtures/audio-helper.py'
    service=capture.CaptureService(config,helper_command=[sys.executable,str(fixture)])
    deadline=time.monotonic()+8
    while not service.capabilities().get('ready'):
        if time.monotonic()>deadline:raise RuntimeError('Fixture startup deadline')
        time.sleep(.01)
    service.start({'mode':'mic'})
    while time.monotonic()<deadline:service.tick();time.sleep(.01)
    raise RuntimeError('Did not reach the real publication boundary')

class CaptureProcessRecoveryTests(unittest.TestCase):
    def test_abrupt_process_exit_preserves_each_unacknowledged_segment_exactly_once(self):
        expected=io.BytesIO()
        with wave.open(expected,'wb') as output:output.setnchannels(1);output.setsampwidth(2);output.setframerate(16000);output.writeframes(b'\0\0'*32000)
        expected_hash=hashlib.sha256(expected.getvalue()).hexdigest()
        for phase in ['before-move','after-move','before-manifest','after-manifest']:
            with self.subTest(phase=phase),tempfile.TemporaryDirectory() as folder:
                root=Path(folder);child=subprocess.run([sys.executable,__file__,'--crash-child',phase,str(root)],capture_output=True,timeout=12,env={**os.environ,'PYTHONUTF8':'1'})
                self.assertEqual(child.returncode,73,child.stderr.decode('utf-8',errors='replace'))
                library=Library.open(root/'library')
                try:
                    report=library.recover();records=library.list_records()['items'];self.assertEqual(len(records),1)
                    raw=library._raw(records[0]['id']);self.assertEqual(raw['status'],'interrupted');self.assertEqual(raw['duration'],2);self.assertEqual(len(raw['_segments']),1);self.assertEqual(raw['_segments'][0]['sha256'],expected_hash);self.assertEqual((library.root/raw['_segments'][0]['path']).read_bytes(),expected.getvalue());self.assertEqual(report['captureRecoveryErrors'],[])
                    version=raw['version'];library.recover();self.assertEqual(library._raw(raw['id'])['version'],version)
                finally:library.close()

if __name__=='__main__':
    if len(sys.argv)==4 and sys.argv[1]=='--crash-child':crash_child(sys.argv[2],Path(sys.argv[3]))
    else:unittest.main()
