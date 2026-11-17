import hashlib,io,os,tempfile,unittest,wave
from pathlib import Path
from unittest.mock import patch
from local_core.config import LocalConfig
from local_core.protocol import CoreError
from local_core.browser_capture import BrowserSession

class BrowserCaptureTests(unittest.TestCase):
 def setUp(self):
  self.temp=tempfile.TemporaryDirectory();self.env=patch.dict(os.environ,{'MONO_CONFIG_DIR':str(Path(self.temp.name)/'config'),'MONO_DEFAULT_LIBRARY_ROOT':str(Path(self.temp.name)/'library')});self.env.start()
  self.config=LocalConfig();self.config.configure({'useDefault':True});self.stamp=100_000_000_000
  self.session=BrowserSession(self.config,now_ns=lambda:self.stamp)
 def tearDown(self):self.session.close();self.config.close();self.env.stop();self.temp.cleanup()
 def start(self):return self.session.start({'sampleRate':16000,'inputId':'browser-selected-mic'})
 def part(self,index,frames=32000,value=1000):
  data=io.BytesIO()
  with wave.open(data,'wb') as w:w.setnchannels(1);w.setsampwidth(2);w.setframerate(16000);w.writeframes(int(value).to_bytes(2,'little',signed=True)*frames)
  stage=self.config.allocate_stage();path=self.config.stage_path(stage['id']);path.write_bytes(data.getvalue())
  return dict(sessionId=self.session.session_id,index=index,stagingId=stage['id'],sha256=hashlib.sha256(data.getvalue()).hexdigest())
 def assertCode(self,code,action):
  with self.assertRaises(CoreError) as caught:action()
  self.assertEqual(caught.exception.code,code)
 def test_pcm_durable_receipt_exact_finish_and_restart(self):
  started=self.start();rid=started['recordId'];self.assertEqual(started['state'],'recording')
  ack=self.session.segment(self.part(0));self.assertEqual(ack['frames'],32000);self.assertGreater(self.session.status()['levels']['mic']['rms'],0)
  self.assertCode('INVALID_CAPTURE_FRAMES',lambda:self.session.finish({'sessionId':self.session.session_id,'frames':31999}))
  end=self.session.finish({'sessionId':self.session.session_id,'frames':32000});self.assertEqual(end['state'],'ready')
  record=self.config.get_library().get_record(rid);self.assertEqual(record['status'],'saved');self.assertEqual(record['duration'],2);self.assertEqual(record['tracks'][0]['sampleRate'],16000)
  self.config.close();self.config=LocalConfig();self.assertEqual(self.config.get_library().get_record(rid)['size'],record['size'])
 def test_empty_finish_never_claims_saved_audio(self):
  self.start();end=self.session.finish({'sessionId':self.session.session_id,'frames':0});self.assertEqual(end['state'],'interrupted');self.assertEqual(end['errorCode'],'NO_AUDIO_CAPTURED');self.assertEqual(end['savedFrames'],0)
 def test_duplicate_same_bytes_is_idempotent_and_changed_bytes_rejected(self):
  self.start();self.session.segment(self.part(0));record=self.config.get_library()._raw(self.session.record_id)
  self.assertEqual(self.session.segment(self.part(0))['frames'],32000);self.assertEqual(self.config.get_library()._raw(self.session.record_id),record)
  self.assertCode('SEGMENT_CONFLICT',lambda:self.session.segment(self.part(0,value=2)))
  self.assertCode('INVALID_CAPTURE_SEQUENCE',lambda:self.session.segment(self.part(2)))
 def test_pause_keeps_pcm_timeline_and_gap_without_compression(self):
  self.start();sid=self.session.session_id;self.session.segment(self.part(0))
  self.session.pause({'sessionId':sid,'frames':32000});self.session.segment(self.part(1,value=0))
  self.session.resume({'sessionId':sid,'frames':64000});self.session.segment(self.part(2))
  self.session.finish({'sessionId':sid,'frames':96000});record=self.config.get_library().get_record(self.session.record_id)
  self.assertEqual(record['duration'],6);self.assertEqual(record['gapMarkers'],[{'start':2.0,'end':4.0,'reason':'paused'}]);self.assertEqual([p['frames'] for p in self.config.get_library()._raw(self.session.record_id)['_segments']],[32000]*3)
 def test_pause_rejects_nonzero_samples_instead_of_merely_marking_gap(self):
  self.start();sid=self.session.session_id;self.session.segment(self.part(0));self.session.pause({'sessionId':sid,'frames':32000})
  self.assertCode('INVALID_PAUSED_AUDIO',lambda:self.session.segment(self.part(1,value=1000)))
  self.assertEqual(self.session.status()['savedFrames'],32000)
 def test_wrong_session_is_rejected_without_changing_owner(self):
  self.start();before=self.session.status();self.assertCode('INVALID_CAPTURE_SESSION',lambda:self.session.heartbeat({'sessionId':'foreign'}));self.assertEqual(self.session.status(),before)
 def test_heartbeat_expiry_preserves_only_durable_audio(self):
  self.start();self.session.segment(self.part(0));self.stamp+=6_000_000_000;self.session.tick();self.assertEqual(self.session.status()['state'],'interrupted');self.assertEqual(self.session.status()['savedFrames'],32000)
  record=self.config.get_library().get_record(self.session.record_id);self.assertEqual(record['status'],'interrupted');self.assertEqual(record['duration'],2);self.assertGreater(record['size'],0)
 def test_heartbeats_without_pcm_cannot_pretend_microphone_is_recording(self):
  self.start();sid=self.session.session_id;self.stamp+=4_000_000_000;self.session.heartbeat({'sessionId':sid});self.stamp+=4_000_000_000;self.session.heartbeat({'sessionId':sid});self.session.tick()
  self.assertEqual(self.session.status()['state'],'interrupted');self.assertEqual(self.session.status()['errorCode'],'NO_AUDIO_CAPTURED');self.assertEqual(self.session.status()['savedFrames'],0)
 def test_expiry_metadata_write_failure_is_explicit_and_does_not_crash_owner(self):
  self.start();self.session.segment(self.part(0));size=self.session.status()['savedBytes'];self.stamp+=6_000_000_000
  with patch.object(self.session.library,'_commit',side_effect=OSError('disk unavailable')):self.session.tick()
  self.assertFalse(self.session.active);self.assertEqual(self.session.status()['errorCode'],'ARCHIVE_SAVE_FAILED');self.assertEqual(self.session.status()['savedBytes'],size)
 def test_invalid_rate_and_large_chunk_rejected_without_record_or_size_change(self):
  self.assertCode('INVALID_CAPTURE_FORMAT',lambda:self.session.start({'sampleRate':1}));self.assertEqual(self.config.get_library().list_records()['items'],[])
  self.start();self.assertCode('INVALID_CAPTURE_FORMAT',lambda:self.session.segment(self.part(0,frames=32001)));self.assertEqual(self.config.get_library().get_record(self.session.record_id)['size'],0)
 def test_second_start_and_late_heartbeat_cannot_replace_session(self):
  self.start();sid=self.session.session_id;self.assertCode('CAPTURE_BUSY',lambda:self.start());self.session.finish({'sessionId':sid,'frames':0})
  self.assertCode('INVALID_CAPTURE_STATE',lambda:self.session.heartbeat({'sessionId':sid}))
 def test_foreign_stage_cannot_escape_archive(self):
  self.start();self.assertCode('INVALID_ID',lambda:self.session.segment({'sessionId':self.session.session_id,'index':0,'stagingId':'../outside','sha256':'0'*64}))

if __name__=='__main__':unittest.main(verbosity=2)
