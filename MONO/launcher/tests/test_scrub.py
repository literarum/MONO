import hashlib, sys, tempfile, unittest, uuid
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from local_core.library import Library

class ScrubTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.root=Path(self.tmp.name)/'library';self.lib=Library.open(self.root)
    def tearDown(self):self.lib.close();self.tmp.cleanup()
    def take(self,data):
        rec=self.lib.create_record({'title':'Встреча','mime':'audio/wav'})
        p=self.root/'.staging'/(str(uuid.uuid4())+'.part');p.write_bytes(data)
        self.lib.commit_segment(rec['id'],'mic',0,p,len(data),hashlib.sha256(data).hexdigest());return self.lib._raw(rec['id'])
    def test_bit_rot_is_found_and_marked_while_healthy_records_stay(self):
        good=self.take(b'healthy-audio');bad=self.take(b'audio-that-will-rot')
        (self.root/bad['_segments'][0]['path']).write_bytes(b'audio-that-will-rOt')
        report=self.lib.scrub()
        self.assertTrue(report['complete']);self.assertEqual(report['checked'],2);self.assertEqual(report['damaged'],[bad['id']])
        self.assertEqual(self.lib._raw(bad['id'])['status'],'damaged');self.assertNotEqual(self.lib._raw(good['id'])['status'],'damaged')
        self.assertEqual(self.lib.scrub()['damaged'],[],'an already damaged record is not re-reported')
    def test_missing_part_is_damage(self):
        rec=self.take(b'x'*10);(self.root/rec['_segments'][0]['path']).unlink()
        self.assertEqual(self.lib.scrub()['damaged'],[rec['id']])
    def test_live_recordings_are_never_touched_and_budget_resumes(self):
        a=self.take(b'a');b=self.take(b'b')
        self.lib.patch_record(a['id'],self.lib._raw(a['id'])['version'],{'status':'recording'})
        report=self.lib.scrub()
        self.assertEqual(report['checked'],1)
        first=self.lib.scrub(budget_seconds=1e-9)
        self.assertFalse(first['complete']);self.assertIsNotNone(first['cursor'],'progress even with a tiny budget')
        rest=self.lib.scrub(cursor=first['cursor'],budget_seconds=30)
        self.assertTrue(rest['complete'])
    def test_rejects_bad_parameters(self):
        with self.assertRaises(Exception):self.lib.scrub(budget_seconds=0)
        with self.assertRaises(Exception):self.lib.scrub(cursor=5)

if __name__=='__main__':unittest.main()
