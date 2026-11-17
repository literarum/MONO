"""Fault injection only: real copy pauses after its first durable file."""
import json,os,sys,time,uuid
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[2]/'launcher'))
from local_core import worker,transfer
root=Path(os.environ['MONO_CONFIG_DIR']).parent.resolve()
configuration=worker.configuration;copy_file=transfer.copy_file
def configured():
    config=configuration()
    if os.environ.get('MONO_TEST_CAPTURE_FIXTURE')=='1' and config._capture is None:
        from local_core.capture import CaptureService
        config._capture=CaptureService(config,helper_command=[sys.executable,str(Path(__file__).resolve().parent/'audio-helper.py')])
    def choose(params):
        purpose=params['purpose'];path=Path(json.loads((root/'test-picker.json').read_text(encoding='utf-8'))[purpose]).resolve()
        if not path.is_relative_to(root):raise worker.CoreError('INVALID_CHOICE','Fixture path escaped test root')
        path.mkdir(parents=True,exist_ok=True);token=str(uuid.uuid4());config.choices[token]={'path':path,'purpose':purpose,'expires':time.monotonic()+600}
        return {'choiceId':token,'displayPath':str(path)}
    config.choose=choose;return config
def held_copy(*args,**kwargs):
    result=copy_file(*args,**kwargs)
    if (root/'hold-copy').exists():
        (root/'held-copy.json').write_text(json.dumps({'pid':os.getpid(),'parentPid':os.getppid(),'copied':True}),encoding='utf-8')
        deadline=time.monotonic()+300
        while (root/'hold-copy').exists() and time.monotonic()<deadline:time.sleep(.02)
        if (root/'hold-copy').exists():raise OSError('Fixture hold deadline')
    return result
worker.configuration=configured;transfer.copy_file=held_copy
raise SystemExit(worker.main())
