import ctypes as c,os,uuid
from local_core.paths import confined,publish,reject_links
from local_core.protocol import CoreError

class Blob(c.Structure):_fields_=[('size',c.c_uint32),('data',c.c_void_p)]
class WindowsVault:
    def __init__(self,directory):self.directory=directory
    @property
    def file(self):return confined(self.directory,'groq.dpapi')
    def _transform(self,data,decrypt=False):
        if not 1<=len(data)<=65536:raise CoreError('VAULT_UNAVAILABLE','Не удалось открыть защищённый ключ')
        crypt=c.WinDLL('crypt32',use_last_error=True);kernel=c.WinDLL('kernel32',use_last_error=True)
        kernel.LocalFree.argtypes=[c.c_void_p];kernel.LocalFree.restype=c.c_void_p
        buffer=c.create_string_buffer(data,len(data));source=Blob(len(data),c.addressof(buffer));output=Blob();entropy_bytes=b'MONO/Groq/v1';entropy_buffer=c.create_string_buffer(entropy_bytes,len(entropy_bytes));entropy=Blob(len(entropy_bytes),c.addressof(entropy_buffer))
        fn=crypt.CryptUnprotectData if decrypt else crypt.CryptProtectData
        fn.argtypes=[c.POINTER(Blob),c.c_void_p if decrypt else c.c_wchar_p,c.POINTER(Blob),c.c_void_p,c.c_void_p,c.c_uint32,c.POINTER(Blob)];fn.restype=c.c_int
        try:
            if not fn(c.byref(source),None,c.byref(entropy),None,None,1,c.byref(output)):raise CoreError('VAULT_UNAVAILABLE','Windows не удалось открыть защищённый ключ')
            if not 1<=output.size<=65536:raise CoreError('VAULT_UNAVAILABLE','Недопустимый ответ хранилища ключей')
            return c.string_at(output.data,output.size)
        finally:
            c.memset(c.addressof(buffer),0,len(data))
            if output.data:
                c.memset(output.data,0,output.size);kernel.LocalFree(output.data)
    def read(self):
        try:
            file=self.file
            if not file.exists():return None
            if file.stat().st_size>65536:raise CoreError('VAULT_UNAVAILABLE','Не удалось открыть защищённый ключ')
            return self._transform(file.read_bytes(),True)
        except OSError:raise CoreError('VAULT_UNAVAILABLE','Не удалось открыть защищённый ключ') from None
    def store(self,data):
        protected=self._transform(data);reject_links(self.directory);self.directory.mkdir(parents=True,exist_ok=True);file=self.file;temp=confined(self.directory,'groq.'+str(uuid.uuid4())+'.tmp')
        try:
            descriptor=os.open(temp,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600)
            with os.fdopen(descriptor,'wb') as output:output.write(protected);output.flush();os.fsync(output.fileno())
            publish(temp,file)
        except OSError:raise CoreError('VAULT_UNAVAILABLE','Windows не удалось сохранить защищённый ключ') from None
        finally:
            if temp.exists():temp.unlink()
    def delete(self):
        try:self.file.unlink(missing_ok=True)
        except OSError:raise CoreError('VAULT_UNAVAILABLE','Не удалось удалить защищённый ключ') from None
