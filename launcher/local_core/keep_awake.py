"""Hold an idle-sleep assertion while audio is being captured.

Idle sleep stops capture (native `SLEEP` error, frozen browser audio). The
assertion only prevents *idle* sleep: closing a lid or choosing Sleep still
works, and the existing sleep detection then reports the interruption.
"""
import os,shutil,subprocess,sys

ES_CONTINUOUS=0x80000000
ES_SYSTEM_REQUIRED=0x00000001
# windows-sys metadata: ProcessPowerThrottling=4, PROCESS_POWER_THROTTLING_CURRENT_VERSION=1, EXECUTION_SPEED=1.
PROCESS_POWER_THROTTLING=4

def full_speed(recording):
    """Windows 11 EcoQoS / Efficiency mode may slow a background process; while recording
    the archive writer opts out (ControlMask=EXECUTION_SPEED, StateMask=0), afterwards it
    hands the decision back to Windows (ControlMask=0). Best effort, never raises."""
    if sys.platform!='win32':return False
    try:
        import ctypes
        class State(ctypes.Structure):_fields_=[('Version',ctypes.c_uint32),('ControlMask',ctypes.c_uint32),('StateMask',ctypes.c_uint32)]
        state=State(1,1 if recording else 0,0);kernel=ctypes.windll.kernel32
        return bool(kernel.SetProcessInformation(kernel.GetCurrentProcess(),PROCESS_POWER_THROTTLING,ctypes.byref(state),ctypes.sizeof(state)))
    except (OSError,AttributeError):return False

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
                full_speed(True)
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
                full_speed(False)
            elif self.process is not None:
                self.process.terminate()
                try:self.process.wait(timeout=2)
                except subprocess.TimeoutExpired:self.process.kill()
        except (OSError,AttributeError):pass
        finally:self.process=None;self.active=False
