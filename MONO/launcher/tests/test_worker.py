import json, subprocess, sys, unittest
from pathlib import Path
ROOT=Path(__file__).resolve().parents[2]

class WorkerTests(unittest.TestCase):
    def test_protocol_rejects_unknown_methods_and_recovers_after_bad_input(self):
        worker=ROOT/'launcher/local_core/worker.py'
        self.assertTrue(worker.is_file(),'Local worker is missing')
        proc=subprocess.Popen([sys.executable,str(worker)],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,encoding='utf-8')
        try:
            self.assertEqual(json.loads(proc.stdout.readline())['event'],'ready')
            for payload in ['not-json',json.dumps({'v':1,'id':'a','method':'execute','params':{}}),json.dumps({'v':1,'id':'b','method':'ping','params':{}})]:
                proc.stdin.write(payload+'\n');proc.stdin.flush()
                reply=json.loads(proc.stdout.readline())
                if payload.startswith('{"v": 1, "id": "b"'):self.assertEqual(reply['result']['protocol'],1)
                else:self.assertIn('error',reply)
            proc.stdin.close();self.assertEqual(proc.wait(timeout=5),0)
        finally:
            if proc.poll() is None:proc.kill();proc.wait()
            proc.stdout.close();proc.stderr.close()
    def test_replayed_request_id_is_rejected_without_breaking_next_request(self):
        proc=subprocess.Popen([sys.executable,str(ROOT/'launcher/local_core/worker.py')],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,encoding='utf-8')
        try:
            proc.stdout.readline()
            for request_id,want_error in [('once',False),('once',True),('next',False)]:
                proc.stdin.write(json.dumps({'v':1,'id':request_id,'method':'ping','params':{}})+'\n');proc.stdin.flush();reply=json.loads(proc.stdout.readline())
                if want_error:self.assertEqual(reply.get('error',{}).get('code'),'DUPLICATE_REQUEST')
                else:self.assertEqual(reply['result']['protocol'],1)
            proc.stdin.close();self.assertEqual(proc.wait(timeout=5),0)
        finally:
            if proc.poll() is None:proc.kill();proc.wait()
            proc.stdout.close();proc.stderr.close()
