import hashlib,json,tempfile,unittest,uuid,wave
from pathlib import Path
from local_core.library import Library
from local_core.paths import atomic_json,publish

class CaptureRecoveryTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.root=Path(self.temp.name)/'library';self.lib=Library.open(self.root)
    def tearDown(self):self.lib.close();self.temp.cleanup()
    def pending(self,phase='native',**changes):
        record=self.lib.create_record({'title':'Interrupted capture','mime':'audio/wav','status':'recording'});rid=record['id'];session=str(uuid.uuid4());stage=str(uuid.uuid4())
        directory='.staging/capture-'+str(uuid.uuid4());native=self.root/directory/'mic-000000.wav';native.parent.mkdir()
        with wave.open(str(native),'wb') as output:
            output.setnchannels(1);output.setsampwidth(2);output.setframerate(16000);output.writeframes(bytes(range(256))*250)
        content=native.read_bytes();sha=hashlib.sha256(content).hexdigest()
        raw=self.lib._raw(rid);raw['_capture']={'sessionId':session,'mode':'mic','sessionDirectory':directory,'originMonotonicNs':10_000_000_000};raw['version']+=1;self.lib._commit(raw)
        metadata={'sampleRate':16000,'channels':1,'bitsPerSample':16,'formatTag':1,'startMonotonicNs':10_000_000_000,'endMonotonicNs':12_000_000_000}
        journal=self.root/'journal'/f'capture-{session}-mic-0.json';value={'recordId':rid,'sessionId':session,'track':'mic','index':0,'stagingId':stage,'sha256':sha,'frames':32000,'metadata':metadata};value.update(changes);atomic_json(journal,value)
        staged=self.root/'.staging'/(stage+'.part');target=self.root/'records'/rid/'original/mic/000000.part'
        if phase in ['staged','published','committed']:publish(native,staged)
        if phase=='published':target.parent.mkdir(parents=True);publish(staged,target)
        if phase=='committed':self.lib.commit_segment(rid,'mic',0,staged,32000,sha,format_info=metadata)
        return rid,journal,content,sha,native
    def reopen(self):self.lib.close();self.lib=Library.open(self.root);return self.lib.recover()
    def test_all_four_durable_commit_boundaries_recover_once_without_false_saved_status(self):
        expected=[self.pending(phase) for phase in ['native','staged','published','committed']]
        report=self.reopen()
        self.assertEqual(report['orphans'],0)
        for rid,journal,content,sha,_ in expected:
            raw=self.lib._raw(rid);self.assertEqual(raw['status'],'interrupted');self.assertEqual(raw['duration'],2);self.assertEqual(len(raw['_segments']),1);self.assertEqual(raw['_segments'][0]['sha256'],sha);self.assertEqual((self.root/raw['_segments'][0]['path']).read_bytes(),content);self.assertFalse(journal.exists())
            self.assertIn(rid,report['captureRecovered'])
        versions={rid:self.lib._raw(rid)['version'] for rid,*_ in expected};self.reopen()
        self.assertEqual({rid:self.lib._raw(rid)['version'] for rid,*_ in expected},versions)
    def test_untrusted_journals_cannot_publish_foreign_session_bytes_or_reinterpret_metadata(self):
        cases=[self.pending(sessionId=str(uuid.uuid4())),self.pending(sha256='0'*64),self.pending(metadata={'sampleRate':48000,'channels':1,'bitsPerSample':16,'formatTag':1,'startMonotonicNs':10_000_000_000,'endMonotonicNs':12_000_000_000})]
        report=self.reopen()
        for rid,journal,content,_,native in cases:
            self.assertEqual(self.lib._raw(rid)['size'],0);self.assertEqual(native.read_bytes(),content);self.assertTrue(journal.exists());self.assertIn(journal.name,report['captureRecoveryErrors'])
    def test_path_escape_journal_leaves_outside_file_untouched(self):
        outside=Path(self.temp.name)/'outside.part';outside.write_bytes(b'private sentinel');rid,journal,*_=self.pending(stagingId='../outside')
        report=self.reopen();self.assertEqual(outside.read_bytes(),b'private sentinel');self.assertEqual(self.lib._raw(rid)['size'],0);self.assertIn(journal.name,report['captureRecoveryErrors'])
    def test_private_clock_supports_long_os_uptime_without_javascript_number_rounding(self):
        origin=180*86400*10**9;rid,journal,content,sha,native=self.pending()
        raw=self.lib._raw(rid);raw['_capture']['originMonotonicNs']=origin;raw['version']+=1;self.lib._commit(raw)
        value=json.loads(journal.read_text(encoding='utf-8'));value['metadata']['startMonotonicNs']=origin;value['metadata']['endMonotonicNs']=origin+2_000_000_000;atomic_json(journal,value)
        self.reopen();raw=self.lib._raw(rid);self.assertEqual(raw['_segments'][0]['startMonotonicNs'],origin);self.assertEqual(raw['duration'],2);self.assertEqual((self.root/raw['_segments'][0]['path']).read_bytes(),content)
