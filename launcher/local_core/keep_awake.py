"""Hold an idle-sleep assertion while audio is being captured.

Idle sleep stops capture (native `SLEEP` error, frozen browser audio). The
assertion only prevents *idle* sleep: closing a lid or choosing Sleep still
works, and the existing sleep detection then reports the interruption.
"""
import os,shutil,subprocess,sys

ES_CONTINUOUS=0x80000000
ES_SYSTEM_REQUIRED=0x00000001

class KeepAwake:
    def __init__(self,platform=sys.platform,runner=subprocess.Popen,which=shutil.which):
        self.platform=platform;self.runner=runner;self.which=which;self.active=False;self.process=None
    def set(self,wanted):
        """Idempotent. Must be called from one thread (Windows assertions are per thread)."""
        if wanted and not self.active:self._acquire()
        elif not wanted and self.active:self._release()
    def _acquire(self):
        try:
            if self.platform=='win32':
                import ctypes
                if not ctypes.windll.kernel32.SetThreadExecutionState(ES_CONTINUOUS|ES_SYSTEM_REQUIRED):return
            elif self.platform=='darwin':
                # -i: prevent idle system sleep; -w: end automatically if MONO dies.
                self.process=self.runner(['/usr/bin/caffeinate','-i','-w',str(os.getpid())],stdin=subprocess.DEVNULL,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
            else:
                tool=self.which('systemd-inhibit')
                if not tool:return
                self.process=self.runner([tool,'--what=idle:sleep','--who=MONO Transcribe','--why=Идёт запись звука','--mode=block','sleep','infinity'],stdin=subprocess.DEVNULL,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
            self.active=True
        except (OSError,AttributeError):
            # Best effort: recording must never fail because sleep cannot be blocked.
            self.process=None
    def _release(self):
        try:
            if self.platform=='win32':
                import ctypes
                ctypes.windll.kernel32.SetThreadExecutionState(ES_CONTINUOUS)
            elif self.process is not None:
                self.process.terminate()
                try:self.process.wait(timeout=2)
                except subprocess.TimeoutExpired:self.process.kill()
        except (OSError,AttributeError):pass
        finally:self.process=None;self.active=False
