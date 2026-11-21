"""Private durable copy intent. Never accepts paths from an HTTP request."""
import json,re,uuid
from pathlib import Path
from local_core.paths import atomic_json,confined,identifier,publish,reject_links
from local_core.protocol import CoreError

class TransferJournal:
    def __init__(self,directory):
        self.directory=directory;self.file=confined(directory,'transfer.json')
    def workspace(self,operation_id):return confined(self.directory,'transfers',identifier(operation_id))
    def load(self):
        if not self.file.exists():return None
        try:
            if self.file.stat().st_size>16384:raise ValueError()
            value=json.loads(self.file.read_text(encoding='utf-8'))
            if value.get('schema')!=1 or value.get('kind') not in ['move','export','import'] or value.get('state') not in ['running','interrupted','failed','cancelled','completed']:raise ValueError()
            identifier(value.get('id'))
            for key in ['source','target','libraryRoot']:
                path=Path(value[key])
                if not path.is_absolute() or len(str(path))>4096:raise ValueError()
                reject_links(path)
            if value.get('snapshotHash') is not None:
                import re
                if not re.fullmatch('[a-f0-9]{64}',value['snapshotHash']):raise ValueError()
            return value
        except (ValueError,TypeError,KeyError,AttributeError,OSError,CoreError):
            raise CoreError('TRANSFER_JOURNAL_INVALID','TRANSFER_JOURNAL_INVALID')
    def save(self,task):
        value={key:str(task[key]) if isinstance(task[key],Path) else task[key] for key in ['id','kind','state','source','target','libraryRoot','snapshotHash'] if key in task}
        if 'errorCode' in task:value['errorCode']=task['errorCode']
        if 'result' in task:value['result']=task['result']
        if task.get('cleanupPending'):value['cleanupPending']=True
        atomic_json(self.file,{'schema':1,**value})
    def archive_invalid(self):
        reject_links(self.file)
        if len(list(self.directory.glob('transfer-invalid-*.json')))>=16:
            raise CoreError('TRANSFER_RECOVERY_LIMIT','TRANSFER_RECOVERY_LIMIT')
        target=confined(self.directory,'transfer-invalid-'+str(uuid.uuid4())+'.json')
        if target.exists():raise CoreError('TRANSFER_JOURNAL_INVALID','TRANSFER_JOURNAL_INVALID')
        publish(self.file,target)
    def cleanup(self,task):
        """Only our UUID-scoped private inventory/conversion area is disposable.

        Neither source archives nor user-selected copy destinations enter this
        method. Check every traversed entry before descending; never follow a
        symlink/junction/reparse point, including a replaced parent directory.
        """
        workspace=self.workspace(task['id']);base=confined(self.directory,'transfers')
        if not workspace.exists():return
        if workspace.resolve().parent!=base.resolve():raise CoreError('UNSAFE_PATH','UNSAFE_PATH')
        for entry in workspace.iterdir():
            reject_links(entry)
            if entry.name!='snapshot.json' and not re.fullmatch(r'legacy-[a-f0-9]{32}',entry.name):
                raise CoreError('UNSAFE_PATH','UNSAFE_PATH')
        def remove_owned(directory):
            reject_links(directory)
            if not directory.resolve().is_relative_to(workspace.resolve()):raise CoreError('UNSAFE_PATH','UNSAFE_PATH')
            for entry in directory.iterdir():
                reject_links(entry)
                if entry.is_dir():remove_owned(entry)
                else:entry.unlink()
            directory.rmdir()
        remove_owned(workspace)
    def snapshot(self,task,value=None):
        from local_core.transfer import fingerprint,validate_snapshot
        file=confined(self.workspace(task['id']),'snapshot.json')
        if value is not None:
            validate_snapshot(value);atomic_json(file,value)
            task['snapshotHash']=fingerprint(value);self.save(task)
            return value
        try:
            if not file.is_file() or file.stat().st_size>256*1024**2:raise ValueError()
            value=json.loads(file.read_text(encoding='utf-8'));validate_snapshot(value)
            if fingerprint(value)!=task.get('snapshotHash'):raise ValueError()
            return value
        except (ValueError,TypeError,OSError,CoreError):
            raise CoreError('TRANSFER_JOURNAL_INVALID','TRANSFER_JOURNAL_INVALID')
