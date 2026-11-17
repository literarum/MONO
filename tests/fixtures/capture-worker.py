"""Native helper boundary fixture; all HTTP/worker/archive code remains real."""
import sys,os
from pathlib import Path
root=Path(__file__).resolve().parents[2];sys.path.insert(0,str(root/'launcher'))
from local_core import worker
from local_core.capture import CaptureService
original=worker.configuration
def configuration():
    config=original()
    behavior=os.environ.get('MONO_TEST_AUDIO_BEHAVIOR','normal')
    if behavior not in ['normal','impulse','start-delayed','open-failure','open-failure-unsafe']:raise ValueError('Unknown native boundary fixture')
    if config._capture is None:config._capture=CaptureService(config,helper_command=[sys.executable,str(root/'tests/fixtures/audio-helper.py'),'--behavior',behavior])
    return config
worker.configuration=configuration
raise SystemExit(worker.main())
