import hashlib,json,tempfile,unittest,uuid
from pathlib import Path
from local_core.library import Library
from local_core.protocol import CoreError
try:from local_core.audio_versions import AudioVersions
except ImportError:AudioVersions=None

class AudioVersionTests(unittest.TestCase):
    def setUp(self):
        self.assertIsNotNone(AudioVersions,'Durable audio versions are missing');self.temp=tempfile.TemporaryDirectory();self.library=Library.open(Path(self.temp.name)/'library');self.versions=AudioVersions(self.library)
    def tearDown(self):
        if hasattr(self,'library'):self.library.close();self.temp.cleanup()
    def source(self):
        record=self.library.create_record({'title':'Original stays safe'});source=self.library.root/'.staging'/(str(uuid.uuid4())+'.part');source.write_bytes(b'original source bytes');self.library.commit_segment(record['id'],'original',0,source,0,hashlib.sha256(source.read_bytes()).hexdigest());record=self.library.get_record(record['id']);self.library.patch_record(record['id'],record['version'],{'duration':2});return record['id']
    def metadata(self,source_hash):
        params='a'*64;values=[source_hash,'native-timeline-1','original',params];vid=hashlib.sha256(json.dumps(values,separators=(',',':')).encode()).hexdigest();return {'id':vid,'sourceHash':source_hash,'pipelineVersion':'native-timeline-1','profile':'original','parametersHash':params,'frames':96000,'sampleRate':48000,'channels':1,'mime':'audio/flac'}
    def stage(self,data):
        file=self.library.root/'.staging'/(str(uuid.uuid4())+'.part');file.write_bytes(data);return file
    def test_immutable_version_commit_reopen_and_stale_or_trashed_source_rejection(self):
        rid=self.source();spec=self.versions.sources(rid);meta=self.metadata(spec['sourceHash']);data=b'fLaC'+b'verified-by-supervisor-fixture';stage=self.stage(data)
        result=self.versions.commit(rid,meta,stage,hashlib.sha256(data).hexdigest());self.assertEqual(result['mime'],'audio/flac');self.assertEqual(Path(result['files'][0]['path']).read_bytes(),data);self.assertFalse(stage.exists());self.assertEqual(self.library._raw(rid)['_segments'][0]['sha256'],hashlib.sha256(b'original source bytes').hexdigest())
        self.library.close();self.library=Library.open(self.library.root);self.library.recover();self.versions=AudioVersions(self.library);self.assertEqual(self.versions.get(rid,meta['id'],meta['sourceHash']),result)
        record=self.library.get_record(rid);self.library.patch_record(rid,record['version'],{'duration':3})
        with self.assertRaises(CoreError) as error:self.versions.get(rid,meta['id'],meta['sourceHash'])
        self.assertEqual(error.exception.code,'STALE_AUDIO_VERSION')
        record=self.library.get_record(rid);self.library.trash(rid,record['version'])
        with self.assertRaises(CoreError):self.versions.get(rid,meta['id'],meta['sourceHash'])
    def test_invalid_or_corrupt_version_never_moves_staged_bytes_and_cache_corruption_is_detected(self):
        rid=self.source();meta=self.metadata(self.versions.sources(rid)['sourceHash']);data=b'fLaC'+b'original';stage=self.stage(data)
        with self.assertRaises(CoreError):self.versions.commit(rid,{**meta,'id':'../outside'},stage,hashlib.sha256(data).hexdigest())
        self.assertEqual(stage.read_bytes(),data)
        with self.assertRaises(CoreError):self.versions.commit(rid,meta,stage,'0'*64)
        self.assertEqual(stage.read_bytes(),data)
        result=self.versions.commit(rid,meta,stage,hashlib.sha256(data).hexdigest());file=Path(result['files'][0]['path']);file.write_bytes(b'x'*len(data))
        with self.assertRaises(CoreError) as error:self.versions.get(rid,meta['id'],meta['sourceHash'])
        self.assertEqual(error.exception.code,'AUDIO_VERSION_DAMAGED');self.assertEqual(file.read_bytes(),b'x'*len(data))

    def analysis(self):
        report={'schema':1,'analysisVersion':'audio-analysis-1','duration':2,'frames':96000,'sampleRate':48000,'channels':1,'format':{'codec':'flac','container':'flac'},'peak':-12,'rms':-15,'truePeak':-12,'clipping':{'samples':0,'fraction':0,'threshold':1,'heuristic':True},'silence':{'seconds':0,'fraction':0,'thresholdDbFS':-60,'windowMs':20,'heuristic':True},'noiseHeuristic':None,'loudness':{'valid':True,'integrated':-15,'range':None,'threshold':-25,'reason':None}}
        return json.dumps({'original':report,'prepared':report},separators=(',',':'))

    def test_analysis_is_hash_bound_to_immutable_version_and_survives_reopen(self):
        rid=self.source();meta=self.metadata(self.versions.sources(rid)['sourceHash']);analysis=self.analysis();meta.update(analysisJson=analysis,analysisHash=hashlib.sha256(analysis.encode()).hexdigest());data=b'fLaCanalysis';result=self.versions.commit(rid,meta,self.stage(data),hashlib.sha256(data).hexdigest())
        self.assertEqual(result['analysis'],json.loads(analysis));self.assertEqual(result['analysisHash'],meta['analysisHash']);self.assertEqual(result['profile'],'original')
        self.library.close();self.library=Library.open(self.library.root);self.versions=AudioVersions(self.library);self.assertEqual(self.versions.get(rid,meta['id'],meta['sourceHash']),result)

    def test_analysis_hash_unknown_fields_nonfinite_or_frame_mismatch_never_publish(self):
        rid=self.source();base=self.metadata(self.versions.sources(rid)['sourceHash']);analysis=self.analysis();invalid=[{**base,'analysisJson':analysis,'analysisHash':'0'*64},{**base,'analysisHash':'a'*64}]
        for mutation in ['unknown','nonfinite','frames','duration-type']:
            value=json.loads(analysis)
            if mutation=='unknown':value['original']['privatePath']='C:/private/audio.wav'
            elif mutation=='nonfinite':value['prepared']['truePeak']=float('nan')
            elif mutation=='frames':value['prepared']['frames']+=1
            else:value['prepared']['duration']='invalid'
            raw=json.dumps(value,separators=(',',':'));invalid.append({**base,'analysisJson':raw,'analysisHash':hashlib.sha256(raw.encode()).hexdigest()})
        for meta in invalid:
            stage=self.stage(b'fLaCkeep-staged');before=stage.read_bytes()
            with self.assertRaises(CoreError):self.versions.commit(rid,meta,stage,hashlib.sha256(before).hexdigest())
            self.assertEqual(stage.read_bytes(),before)
