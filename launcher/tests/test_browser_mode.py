"""Browser mode: MONO opens as a tab in the person's own browser and lives while a page is open."""
import importlib.util
import json
import logging
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

ROOT=Path(__file__).resolve().parents[2]
SPEC=importlib.util.spec_from_file_location("mono_launcher_browser",ROOT/"launcher"/"mono_launcher.py")
mono=importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(mono)
LOG=logging.getLogger("test-browser-mode")


class Clock:
    def __init__(self):self.now=0.0
    def __call__(self):return self.now
    def sleep(self,seconds):self.now+=seconds


class BrowserModeTests(unittest.TestCase):
    def run_pages(self,answers,**kw):
        clock=Clock();calls=iter(answers)
        def pages():
            try:return next(calls)
            except StopIteration:return 0
        mono.serve_browser("http://127.0.0.1:4173",LOG,pages,clock=clock,sleep=clock.sleep,poll=3,**kw)
        return clock.now

    def test_waits_for_the_first_page_then_stops_after_the_page_is_gone(self):
        # page appears after 30 s, stays 60 s, then is closed: MONO stops idle_wait (300 s) later
        answers=[0]*10+[1]*20
        stopped=self.run_pages(answers,first_wait=900,idle_wait=300)
        self.assertGreater(stopped,90+300-1);self.assertLess(stopped,90+300+7)

    def test_a_reload_does_not_stop_mono(self):
        answers=[1]*5+[0,0]+[1]*5  # a 6 s gap (reload) inside the session
        stopped=self.run_pages(answers,first_wait=900,idle_wait=300)
        self.assertGreater(stopped,12*3+300-1)

    def test_closing_the_window_quits_mono_within_seconds_by_default(self):
        clock=Clock();calls=iter([1]*30)
        def pages():
            try:return next(calls)
            except StopIteration:return 0
        mono.serve_browser("http://127.0.0.1:4173",LOG,pages,clock=clock,sleep=clock.sleep)
        self.assertGreater(clock.now,30+10-1);self.assertLess(clock.now,30+13)

    def test_a_clock_jump_after_sleep_does_not_end_an_open_session(self):
        clock=Clock();answers=iter([1]*5+[0]+[1]*5)
        def pages():
            value=next(answers,0)
            if clock.now==5:clock.now+=3600  # the computer slept for an hour
            return value
        mono.serve_browser("http://127.0.0.1:4173",LOG,pages,clock=clock,sleep=clock.sleep,poll=1,idle_wait=10)
        self.assertGreater(clock.now,3600+11+9)

    def test_a_transcription_in_flight_keeps_mono_running_after_the_window_closes(self):
        with patch.object(mono,"browser_clients",return_value=(0,1)):self.assertEqual(mono.browser_pages("http://x","t"),1)
        with patch.object(mono,"browser_clients",return_value=(0,0)):self.assertEqual(mono.browser_pages("http://x","t"),0)
        with patch.object(mono,"browser_clients",return_value=None):self.assertIsNone(mono.browser_pages("http://x","t"))

    def test_no_page_ever_connects(self):
        stopped=self.run_pages([None]*1000,first_wait=60,idle_wait=300)
        self.assertGreater(stopped,60);self.assertLess(stopped,70)

    def test_pinned_browser_engine_opens_the_default_browser_not_a_chromium_window(self):
        with tempfile.TemporaryDirectory() as folder:
            Path(folder,"ui-engine.json").write_text(json.dumps({"engine":"browser"}),encoding="utf-8")
            with patch.object(mono,"open_in_browser") as opened,patch.object(mono,"serve_browser") as served:
                mono.launch_window(Path(folder),"http://127.0.0.1:4173",LOG,pages=lambda:1)
            opened.assert_called_once_with("http://127.0.0.1:4173");served.assert_called_once()

    def test_second_click_in_browser_mode_opens_a_tab(self):
        with tempfile.TemporaryDirectory() as folder:
            Path(folder,"ui-engine.json").write_text(json.dumps({"engine":"browser"}),encoding="utf-8")
            Path(folder,"session.json").write_text(json.dumps({"instanceId":"x","url":"http://127.0.0.1:4173"}),encoding="utf-8")
            with patch.object(mono,"healthy",return_value=True),patch.object(mono,"open_in_browser") as opened:
                self.assertEqual(mono.handle_second_instance(Path(folder),LOG),0)
            opened.assert_called_once()

    def test_pages_answer_is_read_with_the_launcher_token(self):
        seen={}
        class Response:
            def __enter__(self):return self
            def __exit__(self,*a):return False
            def read(self,n):return b'{"pages":2}'
        def fake(request,timeout):seen["token"]=request.get_header("X-mono-launcher-token");return Response()
        with patch.object(mono.urllib.request,"urlopen",fake):
            self.assertEqual(mono.browser_pages("http://127.0.0.1:4173","secret"),2)
        self.assertEqual(seen["token"],"secret")
        with patch.object(mono.urllib.request,"urlopen",side_effect=OSError):
            self.assertIsNone(mono.browser_pages("http://127.0.0.1:4173","secret"))

    def test_a_window_of_the_default_browser_in_its_own_profile(self):
        self.assertEqual(mono._command_executable('"C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe" --single-argument %1'),"C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe")
        self.assertEqual(mono.browser_window_command("http://127.0.0.1:4173",("chromium","C:/chrome.exe")),["C:/chrome.exe","--app=http://127.0.0.1:4173/"])
        self.assertEqual(mono.browser_window_command("http://127.0.0.1:4173",("firefox","C:/firefox.exe")),["C:/firefox.exe","-new-window","http://127.0.0.1:4173/"])
        self.assertIsNone(mono.browser_window_command("http://127.0.0.1:4173",("other","C:/x.exe")))
        for command in [mono.browser_window_command("http://x",("chromium","c"))]:
            self.assertFalse(any(a.startswith("--user-data-dir") for a in command),"the person's own profile, not a MONO profile")

    def test_the_retired_mono_chromium_window_moves_to_the_browser(self):
        with tempfile.TemporaryDirectory() as folder:
            Path(folder,"ui-engine.json").write_text(json.dumps({"engine":"chromium"}),encoding="utf-8")
            with patch.object(mono,"open_in_browser") as opened,patch.object(mono,"serve_browser"):
                mono.launch_window(Path(folder),"http://127.0.0.1:4173",LOG)
            opened.assert_called_once()
            self.assertEqual(json.loads(Path(folder,"ui-engine.json").read_text())["engine"],"browser")


if __name__=="__main__":unittest.main()
