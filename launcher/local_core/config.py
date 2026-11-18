import json, os, uuid,time
from pathlib import Path
from local_core.library import Library
from local_core.paths import atomic_json,confined,identifier,reject_links
from local_core.protocol import CoreError
from local_core.folders import choose_folder,documents_folder,local_folder
from local_core.transfer import TransferManager,ensure_idle

SYSTEM_FILES={'desktop.ini','thumbs.db','.ds_store','icon\r','.localized'}
def meaningful_entries(root):
    """Entries a person put there (Explorer/Finder bookkeeping files do not count)."""
    try:return [entry for entry in Path(root).iterdir() if entry.name.lower() not in SYSTEM_FILES]
    except OSError:return []
def archive_root_for(chosen):
    chosen=Path(chosen)
    if (chosen/'library.json').is_file() or not chosen.exists() or not meaningful_entries(chosen):return chosen
    if Library._empty_initialization(chosen):return chosen  # an interrupted MONO initialisation: resume it
    return chosen/'MONO Library'

class LocalConfig:
    def __init__(self):
        self.directory=Path(os.environ.get('MONO_CONFIG_DIR') or Path(os.environ.get('MONO_DATA_DIR','local-data'))/'config').absolute()
        reject_links(self.directory);self.directory.mkdir(parents=True,exist_ok=True)
        self.file=confined(self.directory,'settings.json');self.library=None
        self.settings=json.loads(self.file.read_text(encoding='utf-8')) if self.file.exists() else {}
        self.choices={};self.picker=None;self.pending_stages=set();self._capture=None;self.transfers=TransferManager(self)
    def capture_service(self):
        if self._capture is None:
            from local_core.capture import CaptureService
            self._capture=CaptureService(self)
        return self._capture
    def choose(self,params):
        purpose=params.get('purpose')
        if purpose not in ['create','open','move','backup','import']:raise CoreError('INVALID_PURPOSE','Неизвестная операция с папкой')
        if self.picker:raise CoreError('PICKER_BUSY','Выбор папки уже открыт')
        self.picker={'id':str(uuid.uuid4()),'process':choose_folder(purpose),'purpose':purpose}
        return self.poll_choice({'id':self.picker['id']})
    def poll_choice(self,params):
        picker=self.picker
        if not picker or picker['id']!=params.get('id'):raise CoreError('INVALID_CHOICE','Выбор папки уже завершён')
        try:result=picker['process'].poll()
        except Exception:picker['process'].close();self.picker=None;raise
        if result is None:return {'pending':True,'id':picker['id']}
        picker['process'].close();self.picker=None
        if result is False:return {'cancelled':True}
        path=local_folder(result);reject_links(path)
        token=str(uuid.uuid4());self.choices={k:v for k,v in self.choices.items() if v['expires']>time.monotonic()}
        self.choices[token]={'path':path,'purpose':picker['purpose'],'expires':time.monotonic()+600}
        return {'choiceId':token,'displayPath':str(path)}
    def cancel_choice(self,params):
        if not self.picker or self.picker['id']!=params.get('id'):raise CoreError('INVALID_CHOICE','Выбор папки уже завершён')
        self.picker['process'].close();self.picker=None;return {'cancelled':True}
    def status(self):
        busy=self.transfers.active
        selected=self.settings.get('libraryRoot')
        available=bool(selected and Path(selected).is_dir() and (Path(selected)/'library.json').is_file())
        pending=self.transfers.pending()
        return {'protocol':1,'libraryConfigured':bool(selected),'libraryAvailable':available,'libraryPath':selected,'libraryBusy':busy,**({'transfer':pending} if pending else {}),**({'transferRecoveryError':self.transfers.recovery_error} if self.transfers.recovery_error else {})}
    def consume_choice(self,token,purposes):
        choice=self.choices.pop(token or '',None)
        if choice is None or choice['expires']<=time.monotonic() or choice['purpose'] not in purposes:raise CoreError('INVALID_CHOICE','Выберите папку через системное окно')
        return choice
    def get_library(self):
        if self.library:return self.library
        selected=self.settings.get('libraryRoot')
        if not selected:raise CoreError('LIBRARY_NOT_CONFIGURED','Выберите папку для записей')
        if not Path(selected).is_dir() or not (Path(selected)/'library.json').is_file():raise CoreError('LIBRARY_MISSING','Подключите папку с вашими записями')
        self.library=Library.open(Path(selected));self.library.recover();return self.library
    def configure(self,params):
        if self._capture is not None and self._capture.active:raise CoreError('CAPTURE_BUSY','Сначала остановите запись')
        if self.transfers.active:raise CoreError('LIBRARY_BUSY','Дождитесь завершения копирования')
        if self.pending_stages:raise CoreError('LIBRARY_ACTIVE','Дождитесь сохранения аудио')
        if self.library:ensure_idle(self.library)
        if params.get('useDefault') is True:
            root=Path(os.environ['MONO_DEFAULT_LIBRARY_ROOT']) if os.environ.get('MONO_DEFAULT_LIBRARY_ROOT') else documents_folder()/'MONO Library'
        else:
            choice=self.consume_choice(params.get('choiceId'),['create','open'])
            # One gesture, never a refusal: the archive in the folder opens; an empty folder
            # (Windows may already have put desktop.ini into it) becomes a new archive; a folder
            # with someone else's files keeps them untouched and gets a "MONO Library" inside.
            root=archive_root_for(choice['path'])
        root=local_folder(root)
        reject_links(root)
        if self.library and root.resolve()==self.library.root:return self.status()
        if root.exists() and meaningful_entries(root) and not (root/'library.json').is_file():
            candidate=Library.open_empty_initialization(root)
        else:candidate=Library.open(root)
        try:
            candidate.recover();updated={**self.settings,'schema':1,'libraryRoot':str(candidate.root)};atomic_json(self.file,updated)
        except Exception:candidate.close();raise
        old=self.library;self.library=candidate;self.settings=updated
        if self._capture is not None:self._capture.close()
        if old:old.close()
        return self.status()
    def allocate_stage(self):
        library=self.get_library();sid=str(uuid.uuid4());file=confined(library.root,'.staging',sid+'.part')
        file.touch(mode=0o600,exist_ok=False);self.pending_stages.add(sid);return {'id':sid,'path':str(file)}
    def stage_path(self,sid):return confined(self.get_library().root,'.staging',identifier(sid)+'.part')
    def discard_stage(self,sid):
        file=self.stage_path(sid)
        if file.exists():file.unlink()
        self.pending_stages.discard(sid)
        return {'discarded':True}
    def close(self):
        if self._capture is not None:self._capture.close()
        self.transfers.close()
        if self.picker:self.picker['process'].close();self.picker=None
        if self.library:self.library.close();self.library=None
