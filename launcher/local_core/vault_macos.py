"""Security.framework generic-password item. Native macOS acceptance required."""
import ctypes as c,hashlib
from contextlib import contextmanager
from local_core.protocol import CoreError

P=c.c_void_p;N=c.c_long
class MacVault:
    def __init__(self,directory):
        self.account=hashlib.sha256(str(directory.resolve()).encode('utf-8')).hexdigest()
        try:self.cf=c.CDLL('/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation');self.sec=c.CDLL('/System/Library/Frameworks/Security.framework/Security')
        except OSError:raise CoreError('VAULT_UNAVAILABLE','Связка ключей недоступна') from None
        self.cf.CFDictionaryCreateMutable.argtypes=[P,N,P,P];self.cf.CFDictionaryCreateMutable.restype=P
        self.cf.CFDictionarySetValue.argtypes=[P,P,P];self.cf.CFRelease.argtypes=[P]
        self.cf.CFStringCreateWithCString.argtypes=[P,c.c_char_p,c.c_uint32];self.cf.CFStringCreateWithCString.restype=P
        self.cf.CFDataCreate.argtypes=[P,P,N];self.cf.CFDataCreate.restype=P
        self.cf.CFDataGetLength.argtypes=[P];self.cf.CFDataGetLength.restype=N
        self.cf.CFDataGetBytePtr.argtypes=[P];self.cf.CFDataGetBytePtr.restype=P
        self.cf.CFGetTypeID.argtypes=[P];self.cf.CFGetTypeID.restype=c.c_ulong
        self.cf.CFDataGetTypeID.restype=c.c_ulong
        self.sec.SecItemCopyMatching.argtypes=[P,c.POINTER(P)];self.sec.SecItemCopyMatching.restype=c.c_int32
        self.sec.SecItemAdd.argtypes=[P,P];self.sec.SecItemAdd.restype=c.c_int32
        self.sec.SecItemUpdate.argtypes=[P,P];self.sec.SecItemUpdate.restype=c.c_int32
        self.sec.SecItemDelete.argtypes=[P];self.sec.SecItemDelete.restype=c.c_int32
    def symbol(self,name):return P.in_dll(self.cf if name.startswith('kCF') else self.sec,name).value
    @contextmanager
    def dictionary(self,values):
        keys=c.addressof(c.c_byte.in_dll(self.cf,'kCFTypeDictionaryKeyCallBacks'));vals=c.addressof(c.c_byte.in_dll(self.cf,'kCFTypeDictionaryValueCallBacks'))
        dictionary=self.cf.CFDictionaryCreateMutable(None,0,keys,vals)
        if not dictionary:raise CoreError('VAULT_UNAVAILABLE','Связка ключей недоступна')
        try:
            for key,value in values.items():
                own=False
                if isinstance(value,tuple):reference=self.symbol(value[0])
                elif isinstance(value,bytes):buffer=c.create_string_buffer(value);reference=self.cf.CFDataCreate(None,c.cast(buffer,P),len(value));own=True
                elif isinstance(value,bool):reference=self.symbol('kCFBooleanTrue' if value else 'kCFBooleanFalse')
                else:reference=self.cf.CFStringCreateWithCString(None,value.encode('utf-8'),0x08000100);own=True
                if not reference:raise CoreError('VAULT_UNAVAILABLE','Связка ключей недоступна')
                try:self.cf.CFDictionarySetValue(dictionary,self.symbol(key),reference)
                finally:
                    if own:self.cf.CFRelease(reference)
            yield dictionary
        finally:self.cf.CFRelease(dictionary)
    def query(self):
        # Never block the audio supervisor on an OS authentication dialog. A
        # locked/denied keychain reports a recoverable error without fallback.
        return {'kSecClass':('kSecClassGenericPassword',),'kSecAttrService':'com.mono-transcribe.groq','kSecAttrAccount':self.account,'kSecAttrSynchronizable':False,'kSecUseAuthenticationUI':('kSecUseAuthenticationUIFail',)}
    def check(self,status):
        if status!=0:raise CoreError('VAULT_LOCKED' if status in [-128,-25293,-25308] else 'VAULT_UNAVAILABLE','Не удалось открыть Связку ключей')
    def read(self):
        result=P()
        with self.dictionary({**self.query(),'kSecReturnData':True,'kSecMatchLimit':('kSecMatchLimitOne',)}) as query:status=self.sec.SecItemCopyMatching(query,c.byref(result))
        if status==-25300:return None
        self.check(status)
        try:
            if not result or self.cf.CFGetTypeID(result)!=self.cf.CFDataGetTypeID():raise CoreError('VAULT_UNAVAILABLE','Недопустимый ответ Связки ключей')
            length=self.cf.CFDataGetLength(result)
            if not 1<=length<=65536:raise CoreError('VAULT_UNAVAILABLE','Недопустимый ответ Связки ключей')
            return c.string_at(self.cf.CFDataGetBytePtr(result),length)
        finally:
            if result:self.cf.CFRelease(result)
    def store(self,data):
        with self.dictionary({**self.query(),'kSecValueData':data,'kSecAttrLabel':'MONO · Groq'}) as value:status=self.sec.SecItemAdd(value,None)
        if status==-25299:
            with self.dictionary(self.query()) as query,self.dictionary({'kSecValueData':data}) as value:status=self.sec.SecItemUpdate(query,value)
        self.check(status)
    def delete(self):
        with self.dictionary(self.query()) as query:status=self.sec.SecItemDelete(query)
        if status!=-25300:self.check(status)
