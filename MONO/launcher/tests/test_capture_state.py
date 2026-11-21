import os,sys,tempfile,time,unittest
from pathlib import Path
from unittest.mock import patch
from local_core.config import LocalConfig
from local_core.capture import CaptureService
from local_core.protocol import CoreError
FIXTURE=Path(__file__).resolve().parents[2]/'tests/fixtures/audio-helper.py'

class CaptureStateTests(unittest.TestCase):
    def test_restarted_helper_does_not_relabel_interrupted_record_as_ready(self):
        service=self.ready();started=service.start({'mode':'mic'});self.spin(lambda:self.config.get_library().get_record(started['recordId'])['size']>0);service.child.kill();service.child.wait();self.spin(lambda:service.status()['state']=='interrupted')
        old=self.config.get_library()._raw(started['recordId']);service.capabilities();self.spin(lambda:service.ready)
        self.assertIsNone(service.status()['recordId']);self.assertIsNone(service.status()['sessionId']);self.assertEqual(service.status()['levels'],{});self.assertEqual(self.config.get_library()._raw(started['recordId']),old)
    def test_level_freshness_is_measured_by_supervisor_and_not_inferred_from_ui_polling(self):
        service=self.ready('no-heartbeat');service.start({'mode':'mic'});self.spin(lambda:service.status()['state']=='recording')
        service.events.put((service.generation,'event',{'v':1,'seq':service.last_seq+1,'event':'level','sessionId':service.session_id,'track':'mic','peak':.1,'rms':.05,'clippedFrames':0}))
        service.tick();level=service.status()['levels']['mic'];self.assertLessEqual(level.get('ageMs',10**9),100)
        current=time.monotonic()
        with patch('local_core.capture.time.monotonic',return_value=current+2):self.assertGreaterEqual(service.status()['levels']['mic']['ageMs'],1999)
    def test_invalid_clip_counter_is_rejected_instead_of_reaching_ui(self):
        service=self.ready('no-heartbeat');service.start({'mode':'mic'});self.spin(lambda:service.status()['state']=='recording')
        service.events.put((service.generation,'event',{'v':1,'seq':service.last_seq+1,'event':'level','sessionId':service.session_id,'track':'mic','peak':1,'rms':.2,'clippedFrames':'invalid'}))
        service.tick();self.assertEqual(service.status()['state'],'interrupted');self.assertEqual(service.status()['errorCode'],'INVALID_CAPTURE_PROTOCOL')
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.env=patch.dict(os.environ,{'MONO_CONFIG_DIR':str(Path(self.temp.name)/'config'),'MONO_DEFAULT_LIBRARY_ROOT':str(Path(self.temp.name)/'library')});self.env.start();self.config=LocalConfig();self.config.configure({'useDefault':True});self.service=None
    def tearDown(self):
        if self.service:self.service.close()
        self.config.close();self.env.stop();self.temp.cleanup()
    def ready(self,behavior='normal'):
        self.service=CaptureService(self.config,helper_command=[sys.executable,str(FIXTURE),'--behavior',behavior]);self.service.capabilities();self.spin(lambda:self.service.capabilities().get('ready'));return self.service
    def spin(self,condition):
        deadline=time.monotonic()+4
        while time.monotonic()<deadline:
            self.service.tick()
            if condition():return
            time.sleep(.01)
        self.fail('Capture state deadline: '+repr(self.service.status()))
    def test_application_sound_is_one_system_track_labelled_with_the_program(self):
        service=self.ready();self.assertIn('app',service.capabilities()['modes'])
        apps=service.applications();self.assertTrue(apps['available']);self.assertEqual([app['processName'] for app in apps['applications']],['zoom','chrome'])
        with self.assertRaises(CoreError) as missing:service.start({'mode':'app'})
        self.assertEqual(missing.exception.code,'APP_NOT_SELECTED')
        with self.assertRaises(CoreError):service.start({'mode':'app','processId':'4242'})
        started=service.start({'mode':'app','processId':4242,'appName':'Zoom Workplace'})
        self.spin(lambda:service.status()['state']=='recording' and len(self.config.get_library()._raw(started['recordId'])['_segments'])==1)
        raw=self.config.get_library()._raw(started['recordId']);self.assertEqual(raw['_capture']['processId'],4242);self.assertEqual(raw['source'],'Звук приложения «Zoom Workplace»')
        service.stop();self.spin(lambda:service.status()['state']=='ready');record=self.config.get_library().get_record(started['recordId'])
        self.assertEqual(record['status'],'saved');self.assertEqual({track['id'] for track in record['tracks']},{'system'})
    def test_one_session_durable_parts_pause_gap_and_stop(self):
        service=self.ready();started=service.start({'mode':'both','inputId':'mic-fixture','outputId':'system-fixture'})
        with self.assertRaises(CoreError):service.start({'mode':'mic'})
        self.spin(lambda:service.status()['state']=='recording' and len(self.config.get_library()._raw(started['recordId'])['_segments'])==2)
        service.pause();self.spin(lambda:service.status()['state']=='paused');service.resume();self.spin(lambda:len(self.config.get_library()._raw(started['recordId'])['_segments'])==4)
        service.stop();self.spin(lambda:service.status()['state']=='ready');record=self.config.get_library().get_record(started['recordId'])
        self.assertEqual(record['status'],'saved');self.assertAlmostEqual(record['duration'],6);self.assertEqual(len(record['gapMarkers']),1);self.assertEqual(record['gapMarkers'][0],{'start':2.0,'end':4.0,'reason':'paused'})
        self.assertEqual({track['id'] for track in record['tracks']},{'mic','system'});self.assertTrue(all(track['sampleRate']==16000 and track['channels']==1 for track in record['tracks']))
        self.assertEqual(self.config.get_library().recover()['corrupt'],[])
        self.assertEqual(service.status().get('savedBytes'),record['size'])
    def test_stop_during_access_request_never_reports_empty_audio_saved(self):
        service=self.ready('pending');started=service.start({'mode':'mic'});service.stop();self.spin(lambda:service.status()['state'] in ['ready','interrupted','error'])
        self.assertNotEqual(self.config.get_library().get_record(started['recordId'])['status'],'saved')
        self.assertEqual(service.status().get('savedBytes'),0)
    def test_helper_crash_preserves_committed_parts_and_marks_interrupted(self):
        service=self.ready();started=service.start({'mode':'mic'});self.spin(lambda:self.config.get_library().get_record(started['recordId'])['size']>0);service.child.kill();service.child.wait();self.spin(lambda:service.status()['state']=='interrupted');self.assertEqual(self.config.get_library().get_record(started['recordId'])['status'],'interrupted');self.assertEqual(len(self.config.get_library()._raw(started['recordId'])['_segments']),1)
    def test_start_right_after_a_failed_session_waits_for_the_restarted_helper(self):
        # Seen on Windows: an ACCESS_DENIED microphone killed the helper, and every next
        # start (even system audio) failed with CAPTURE_NOT_READY until MONO restarted.
        service=self.ready();service.start({'mode':'mic'});service.child.kill();service.child.wait()
        self.spin(lambda:service.status()['state']=='interrupted')
        again=service.start({'mode':'mic'})
        self.spin(lambda:service.status()['state']=='recording' and service.status()['recordId']==again['recordId'])
        service.stop();self.spin(lambda:service.status()['state']=='ready')
    def test_diagnosis_reports_every_microphone_and_repair_unmutes(self):
        service=self.ready()
        report=service.diagnose()
        self.assertTrue(report['available']);self.assertEqual([d['state'] for d in report['inputs']],['active','disabled'])
        self.assertIs(report['inputs'][0]['muted'],False)
        muted=service.diagnose(repair={'mute':True});self.assertIs(muted['inputs'][0]['muted'],True)
        fixed=service.diagnose(repair={'mute':False,'minimumVolume':.5});self.assertIs(fixed['inputs'][0]['muted'],False)
        with self.assertRaises(CoreError):service.diagnose(repair={'minimumVolume':2})
        # Diagnosis never disturbs a following recording.
        started=service.start({'mode':'mic'});self.spin(lambda:service.status()['state']=='recording');service.stop();self.spin(lambda:service.status()['state']=='ready')
    def test_foreign_relative_file_is_rejected_before_archive_publication(self):
        service=self.ready('unsafe');started=service.start({'mode':'mic'});self.spin(lambda:service.status()['state'] in ['interrupted','error']);record=self.config.get_library().get_record(started['recordId']);self.assertEqual(record['size'],0);self.assertNotEqual(record['status'],'saved')
    def test_unrequested_system_track_is_not_committed_in_microphone_mode(self):
        service=self.ready('wrong-track');started=service.start({'mode':'mic'});self.spin(lambda:service.status()['state'] in ['interrupted','error'])
        self.assertEqual(self.config.get_library().get_record(started['recordId'])['size'],0)
    def test_late_foreign_session_event_cannot_keep_current_capture_alive(self):
        service=self.ready('no-heartbeat');started=service.start({'mode':'mic'});self.spin(lambda:self.config.get_library().get_record(started['recordId'])['size']>0)
        service.last_seen=time.monotonic()-6
        service.events.put((service.generation,'event',{'v':1,'seq':service.last_seq+1,'event':'level','sessionId':'00000000-0000-4000-8000-000000000099','track':'mic','peak':0,'rms':0}))
        service.tick();self.assertEqual(service.status()['state'],'interrupted')
    def test_stop_timeout_terminates_helper_instead_of_leaving_capture_running(self):
        service=self.ready('ignore-stop');started=service.start({'mode':'mic'});self.spin(lambda:self.config.get_library().get_record(started['recordId'])['size']>0)
        service.stop();service.deadline=time.monotonic()-1;service.tick();self.assertEqual(service.status()['state'],'interrupted');service.child.wait(timeout=1);self.assertNotEqual(service.child.returncode,None)
    def test_sound_test_stops_locally_and_only_test_record_can_be_discarded(self):
        service=self.ready();started=service.test({'mode':'mic'});self.spin(lambda:self.config.get_library().get_record(started['recordId'])['size']>0)
        self.assertEqual(service.check_access()['microphone'],'available');service.test_deadline=time.monotonic()-1;service.tick();self.spin(lambda:service.status()['state']=='ready')
        self.assertTrue(self.config.get_library()._raw(started['recordId'])['_capture']['temporary']);self.assertEqual(service.discard_test(started['recordId']),{'discarded':True})
        ordinary=self.config.get_library().create_record({'title':'Keep me'})
        with self.assertRaises(CoreError):service.discard_test(ordinary['id'])
        self.assertEqual(self.config.get_library().get_record(ordinary['id'])['title'],'Keep me')
    def test_measured_end_clock_is_preserved_instead_of_replaced_by_nominal_sample_duration(self):
        service=self.ready('clock-drift');started=service.start({'mode':'mic'});self.spin(lambda:self.config.get_library().get_record(started['recordId'])['size']>0);service.stop();self.spin(lambda:service.status()['state']=='ready')
        record=self.config.get_library()._raw(started['recordId']);self.assertAlmostEqual(record['duration'],2.0002);self.assertEqual(record['_segments'][0]['endMonotonicNs'],12_000_200_000)
    def test_stop_during_resume_keeps_resumed_samples_outside_pause_gap(self):
        service=self.ready('resume-delayed');started=service.start({'mode':'mic'});self.spin(lambda:self.config.get_library().get_record(started['recordId'])['size']>0);service.pause();self.spin(lambda:service.status()['state']=='paused');service.resume();service.stop();self.spin(lambda:service.status()['state']=='ready')
        record=self.config.get_library()._raw(started['recordId']);self.assertEqual(len(record['_segments']),2);self.assertEqual(record['gapMarkers'],[{'start':2.0,'end':4.0,'reason':'paused'}]);self.assertEqual(record['duration'],6)
    def test_samples_acquired_while_paused_without_resume_intent_are_rejected(self):
        service=self.ready('paused-data');started=service.start({'mode':'mic'});self.spin(lambda:self.config.get_library().get_record(started['recordId'])['size']>0);service.pause();self.spin(lambda:service.status()['state']=='interrupted');self.assertEqual(len(self.config.get_library()._raw(started['recordId'])['_segments']),1)
