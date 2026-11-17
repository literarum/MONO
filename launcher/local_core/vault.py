"""User-scoped system credential vault. No plaintext or browser fallback."""
import json,re,sys
from datetime import datetime
from pathlib import Path
from local_core.paths import reject_links
from local_core.protocol import CoreError

def valid_key(value):return isinstance(value,str) and re.fullmatch(r'[A-Za-z0-9_-]{20,512}',value) is not None
class CredentialVault:
    def __init__(self,directory):
        self.directory=Path(directory).absolute();reject_links(self.directory)
        if sys.platform=='win32':
            from local_core.vault_windows import WindowsVault
            self.backend=WindowsVault(self.directory)
        elif sys.platform=='darwin':
            from local_core.vault_macos import MacVault
            self.backend=MacVault(self.directory)
        else:raise CoreError('VAULT_UNAVAILABLE','Системное хранилище ключей недоступно')
    def _payload(self):
        data=self.backend.read()
        if data is None:return None
        try:
            value=json.loads(data.decode('utf-8'))
            if not isinstance(value,dict) or set(value)!={'schema','key','verifiedAt'} or value['schema']!=1 or not valid_key(value['key']):raise ValueError()
            datetime.fromisoformat(value['verifiedAt'])
            return value
        except (ValueError,TypeError,KeyError,UnicodeError):raise CoreError('VAULT_UNAVAILABLE','Не удалось открыть защищённый ключ') from None
    def status(self):
        try:value=self._payload()
        except CoreError as error:return {'configured':False,'verified':False,'masked':None,'errorCode':error.code}
        return {'configured':value is not None,'verified':value is not None,'masked':'•••• '+value['key'][-4:] if value else None,'errorCode':None}
    def store(self,key,*,verified_at):
        if not valid_key(key):raise CoreError('INVALID_KEY','Проверьте ключ Groq')
        try:datetime.fromisoformat(verified_at)
        except (ValueError,TypeError):raise CoreError('INVALID_KEY_STATUS','Проверка ключа не завершена') from None
        self.backend.store(json.dumps({'schema':1,'key':key,'verifiedAt':verified_at},separators=(',',':')).encode('utf-8'))
        # The OS write must succeed before a success status is returned.
        return {'configured':True,'verified':True,'masked':'•••• '+key[-4:],'errorCode':None}
    def read(self):
        value=self._payload();return value['key'] if value else None
    def delete(self):self.backend.delete();return {'configured':False,'verified':False,'masked':None,'errorCode':None}
