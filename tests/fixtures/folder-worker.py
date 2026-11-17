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
    config.choose=choose
    return config
worker.configuration=configuration
raise SystemExit(worker.main())
