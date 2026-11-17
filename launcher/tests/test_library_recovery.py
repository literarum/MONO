import json, os, subprocess, sys, tempfile, unittest
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from local_core.library import Library
LAUNCHER=Path(__file__).resolve().parents[1]
CHILD=r'''
import hashlib,json,os,sys,uuid
from pathlib import Path
sys.path.insert(0,sys.argv[1])
from local_core.library import Library
import local_core.paths as paths
import local_core.library as library
lib=Library.open(Path(sys.argv[2]));rec=lib.create_record({'title':'Crash fixture'})
print(json.dumps({'id':rec['id']}),flush=True)
data=b'durable-before-ack';p=lib.root/'.staging'/(str(uuid.uuid4())+'.part');p.write_bytes(data)
phase=sys.argv[3];original=paths.publish
def fault(source,target):
 original(source,target)
 if phase=='audio' and target.suffix=='.part':os._exit(23)
 if phase=='manifest' and target.name=='record.json':os._exit(24)
paths.publish=fault;library.publish=fault
receipt=lib.commit_segment(rec['id'],'mic',0,p,96000,hashlib.sha256(data).hexdigest())
print(json.dumps({'ack':receipt}),flush=True)
sys.stdin.read()
'''
class LibraryRecoveryTests(unittest.TestCase):
    def crash(self,root,phase):
        p=subprocess.Popen([sys.executable,'-c',CHILD,str(LAUNCHER),str(root),phase],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,encoding='utf-8')
        try:
            rid=json.loads(p.stdout.readline())['id']
            if phase=='ack':
                ack=json.loads(p.stdout.readline())['ack'];self.assertEqual(ack['committedFrames'],96000);p.kill()
            p.wait(timeout=8)
            self.assertIn(p.returncode,[-9,1,23,24])
            return rid
        finally:
            if p.poll() is None:p.kill();p.wait()
            p.stdin.close();p.stdout.close();p.stderr.close()
    def test_unacknowledged_orphan_is_reported_without_false_saved_data(self):
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp)/'archive';rid=self.crash(root,'audio');lib=Library.open(root)
            try:
                report=lib.recover();self.assertEqual(report['orphans'],1);self.assertEqual(lib.get_record(rid)['size'],0)
            finally:lib.close()
    def test_manifest_ahead_of_sqlite_is_recovered_after_process_crash(self):
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp)/'archive';rid=self.crash(root,'manifest');lib=Library.open(root)
            try:
                self.assertIn(rid,lib.recover()['recovered']);self.assertEqual(lib.get_record(rid)['size'],18)
            finally:lib.close()
    def test_acknowledged_frames_survive_actual_process_kill(self):
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp)/'archive';rid=self.crash(root,'ack');lib=Library.open(root)
            try:
                self.assertEqual(lib.recover()['corrupt'],[]);self.assertEqual(lib.get_record(rid)['tracks'][0]['frames'],96000)
            finally:lib.close()
