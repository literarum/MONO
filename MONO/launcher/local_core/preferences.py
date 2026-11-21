"""Small non-secret preferences persisted beside the archive pointer."""
import copy,re
from local_core.paths import atomic_json
from local_core.protocol import CoreError

DEFAULTS={'version':1,'onboarding':{'completed':False,'keySkipped':False,'soundTested':False},'capture':{'mode':'browser','inputId':None,'outputId':None,'appName':None},'dismissedHints':[],'background':{'lingerSeconds':10,'finishWork':True,'keepAwake':True}}
def invalid():raise CoreError('INVALID_PREFERENCES','Проверьте настройки приложения')
class Preferences:
    def __init__(self,config):self.config=config
    def validate(self,patch):
        if not isinstance(patch,dict) or set(patch)-{'onboarding','capture','dismissedHints','background'}:invalid()
        if 'onboarding' in patch:
            value=patch['onboarding']
            if not isinstance(value,dict) or set(value)-set(DEFAULTS['onboarding']) or any(type(item) is not bool for item in value.values()):invalid()
        if 'capture' in patch:
            value=patch['capture']
            if not isinstance(value,dict) or set(value)-(set(DEFAULTS['capture'])|{'browserInputId'}):invalid()
            if 'mode' in value and value['mode'] not in ['mic','system','both','app','browser']:invalid()
            if 'appName' in value and value['appName'] is not None and (not isinstance(value['appName'],str) or not 1<=len(value['appName'])<=120):invalid()
            for key in ['inputId','outputId','browserInputId']:
                if key in value and value[key] is not None and (not isinstance(value[key],str) or not 1<=len(value[key])<=4096):invalid()
        if 'background' in patch:
            value=patch['background']
            if not isinstance(value,dict) or set(value)-set(DEFAULTS['background']):invalid()
            if 'lingerSeconds' in value and (type(value['lingerSeconds']) is not int or value['lingerSeconds'] not in [10,60,300,1800]):invalid()
            if any(key in value and type(value[key]) is not bool for key in ['finishWork','keepAwake']):invalid()
        if 'dismissedHints' in patch:
            values=patch['dismissedHints']
            if not isinstance(values,list) or len(values)>100 or any(not isinstance(item,str) or not re.fullmatch('[a-z0-9-]{1,100}',item) for item in values) or len(set(values))!=len(values):invalid()
    def get(self):
        stored=self.config.settings.get('preferences',{})
        if not isinstance(stored,dict) or stored.get('version',1)!=1:invalid()
        patch={key:value for key,value in stored.items() if key!='version'};self.validate(patch);value=copy.deepcopy(DEFAULTS)
        for key,change in patch.items():
            if isinstance(change,dict):value[key].update(change)
            else:value[key]=copy.deepcopy(change)
        return value
    def update(self,patch):
        self.validate(patch)
        if 'capture' in patch and self.config._capture is not None and self.config._capture.active:raise CoreError('CAPTURE_BUSY','Сначала остановите запись')
        value=self.get()
        for key,change in patch.items():
            if isinstance(change,dict):value[key].update(change)
            else:value[key]=copy.deepcopy(change)
        updated={**self.config.settings,'preferences':value};atomic_json(self.config.file,updated);self.config.settings=updated;return value
