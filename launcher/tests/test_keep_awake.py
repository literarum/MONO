"""Idle-sleep assertion follows capture state without ever failing capture."""
import unittest
from local_core.keep_awake import KeepAwake

class FakeProcess:
    def __init__(self,args,**_):self.args=args;self.terminated=False
    def terminate(self):self.terminated=True
    def wait(self,timeout=None):return 0
class KeepAwakeTests(unittest.TestCase):
    def test_macos_uses_caffeinate_bound_to_this_process_and_releases(self):
        started=[];awake=KeepAwake(platform='darwin',runner=lambda args,**kw:started.append(FakeProcess(args)) or started[-1])
        awake.set(True);awake.set(True)
        self.assertEqual(len(started),1,'idempotent');self.assertEqual(started[0].args[:3],['/usr/bin/caffeinate','-i','-w'])
        awake.set(False);self.assertTrue(started[0].terminated);self.assertFalse(awake.active)
    def test_linux_without_systemd_is_a_silent_no_op(self):
        awake=KeepAwake(platform='linux',which=lambda name:None);awake.set(True);self.assertFalse(awake.active)
    def test_spawn_failure_never_raises(self):
        def broken(*a,**k):raise OSError('missing')
        awake=KeepAwake(platform='darwin',runner=broken);awake.set(True);self.assertFalse(awake.active)

if __name__=='__main__':unittest.main()
