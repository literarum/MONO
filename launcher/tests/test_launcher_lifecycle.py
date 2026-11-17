import importlib.util, subprocess, sys, tempfile, unittest
from pathlib import Path
ROOT=Path(__file__).resolve().parents[2]
spec=importlib.util.spec_from_file_location('mono_lifecycle',ROOT/'launcher/mono_launcher.py');mono=importlib.util.module_from_spec(spec);spec.loader.exec_module(mono)
class LauncherLifecycleTests(unittest.TestCase):
    def test_shutdown_waits_for_real_child_to_flush_after_parent_pipe_eof(self):
        with tempfile.TemporaryDirectory() as temp:
            marker=Path(temp)/'flushed';logger=mono.logger_for(Path(temp))
            code="import sys,time;from pathlib import Path;print('ready',flush=True);sys.stdin.read();time.sleep(.15);Path(sys.argv[1]).write_text('flushed')"
            child=subprocess.Popen([sys.executable,'-c',code,str(marker)],stdin=subprocess.PIPE,stdout=subprocess.PIPE,text=True)
            try:
                self.assertEqual(child.stdout.readline().strip(),'ready');mono.stop_backend(child,logger)
                self.assertTrue(marker.is_file(),'Graceful stop killed the child before durable flush');self.assertEqual(child.returncode,0)
            finally:
                if child.poll() is None:child.kill();child.wait()
                child.stdout.close()
                for handler in list(logger.handlers):handler.close();logger.removeHandler(handler)
