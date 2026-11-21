"""Replace only the OS picker for HTTP acceptance; never packaged with MONO."""
import json,os,sys,time,uuid
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[2]/'launcher'))
from local_core import worker
root=Path(os.environ['MONO_CONFIG_DIR']).parent.resolve()
original_configuration=worker.configuration
def configuration():
    config=original_configuration()
    def choose(params):
        purpose=params['purpose'];choices=json.loads((root/'test-picker.json').read_text(encoding='utf-8'));path=Path(choices[purpose]).resolve()
        if not path.is_relative_to(root):raise worker.CoreError('INVALID_CHOICE','Fixture path escaped test root')
        path.mkdir(parents=True,exist_ok=True);token=str(uuid.uuid4());config.choices[token]={'path':path,'purpose':purpose,'expires':time.monotonic()+600}
        return {'choiceId':token,'displayPath':str(path)}
    if os.environ.get('MONO_FIXTURE_PICKER_DELAY'):
        # Realistic picker: the real LocalConfig.choose/poll_choice code with a dialog that
        # stays open for a while (the person is choosing), exactly like the Tk process.
        import local_core.config as config_module
        delay=float(os.environ['MONO_FIXTURE_PICKER_DELAY'])
        class SlowPicker:
            def __init__(self,purpose):self.purpose=purpose;self.until=time.monotonic()+delay
            def poll(self):
                if time.monotonic()<self.until:return None
                path=Path(json.loads((root/'test-picker.json').read_text(encoding='utf-8'))[self.purpose]).resolve();path.mkdir(parents=True,exist_ok=True);return path
            def close(self):pass
        config_module.choose_folder=SlowPicker
    else:config.choose=choose
    return config
worker.configuration=configuration
raise SystemExit(worker.main())
