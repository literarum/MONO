"""Allowlisted library paths and durable atomic publication."""
import ctypes, json, os, stat, uuid,time
from pathlib import Path
from local_core.protocol import CoreError

def identifier(value):
    if not isinstance(value,str):raise CoreError('INVALID_ID','INVALID_ID')
    try:valid=str(uuid.UUID(value))==value
    except (ValueError,AttributeError):valid=False
    if not valid:raise CoreError('INVALID_ID','INVALID_ID')
    return value

def reject_links(path):
    for part in [path,*path.parents]:
        if not part.exists() and not part.is_symlink():continue
        st=part.lstat()
        if stat.S_ISLNK(st.st_mode) or getattr(st,'st_file_attributes',0)&0x400:
            raise CoreError('UNSAFE_PATH','UNSAFE_PATH')

def confined(root,*parts):
    path=root.joinpath(*parts)
    reject_links(path)
    if not path.resolve().is_relative_to(root.resolve()):raise CoreError('UNSAFE_PATH','UNSAFE_PATH')
    return path

def publish(source,target):
    if os.name=='nt':
        move=ctypes.WinDLL('kernel32',use_last_error=True).MoveFileExW
        move.argtypes=[ctypes.c_wchar_p,ctypes.c_wchar_p,ctypes.c_uint32];move.restype=ctypes.c_int
        deadline=time.monotonic()+.5;delay=.005
        while not move(str(source),str(target),0x1|0x8):
            error=ctypes.WinError(ctypes.get_last_error())
            # Readers and scanners may briefly omit FILE_SHARE_DELETE. Keep
            # atomic replace + write-through; a permanent denial still fails.
            if error.winerror not in [5,32,33] or time.monotonic()>=deadline or not source.is_file():raise error
            reject_links(source);reject_links(target)
            time.sleep(min(delay,max(0,deadline-time.monotonic())));delay=min(.05,delay*2)
    else:
        os.replace(source,target)
        descriptor=os.open(target.parent,os.O_RDONLY)
        try:os.fsync(descriptor)
        finally:os.close(descriptor)

def atomic_json(target,value):
    target.parent.mkdir(parents=True,exist_ok=True)
    temp=target.with_name(target.name+'.'+str(uuid.uuid4())+'.tmp')
    try:
        with temp.open('x',encoding='utf-8') as file:
            json.dump(value,file,ensure_ascii=False,separators=(',',':'));file.flush();os.fsync(file.fileno())
        publish(temp,target)
    finally:
        if temp.exists():temp.unlink()

class LibraryLock:
    def __init__(self,file):
        reject_links(file)
        try:
            fd=os.open(file,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600);os.write(fd,b'\0');os.close(fd)
        except FileExistsError:pass
        self.handle=file.open('r+b',buffering=0)
        try:
            if os.name=='nt':
                import msvcrt
                msvcrt.locking(self.handle.fileno(),msvcrt.LK_NBLCK,1)
            else:
                import fcntl
                fcntl.flock(self.handle,fcntl.LOCK_EX|fcntl.LOCK_NB)
        except OSError:
            self.handle.close();self.handle=None
            raise CoreError('LIBRARY_BUSY','LIBRARY_BUSY')
    def close(self):
        if not self.handle:return
        if os.name=='nt':
            import msvcrt
            self.handle.seek(0);msvcrt.locking(self.handle.fileno(),msvcrt.LK_UNLCK,1)
        else:
            import fcntl
            fcntl.flock(self.handle,fcntl.LOCK_UN)
        self.handle.close();self.handle=None
