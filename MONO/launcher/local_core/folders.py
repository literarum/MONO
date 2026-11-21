"""Native directory dialog in its own process; archive IO never waits for UI."""
import ctypes,json,os,subprocess,sys,uuid
from pathlib import Path
if __package__ in (None,''):sys.path.insert(0,str(Path(__file__).resolve().parent.parent))
from local_core.protocol import CoreError

def documents_folder():
    if os.name!='nt':return Path.home()/'Documents'
    folder_id=(ctypes.c_byte*16).from_buffer_copy(uuid.UUID('fdd39ad0-238f-46af-adb4-6c85480369c7').bytes_le)
    result=ctypes.c_void_p();shell=ctypes.WinDLL('shell32');ole=ctypes.WinDLL('ole32')
    function=shell.SHGetKnownFolderPath
    function.argtypes=[ctypes.c_void_p,ctypes.c_uint32,ctypes.c_void_p,ctypes.POINTER(ctypes.c_void_p)];function.restype=ctypes.c_long
    if function(ctypes.byref(folder_id),0,None,ctypes.byref(result))!=0:raise CoreError('FOLDER_UNAVAILABLE','Не удалось найти папку «Документы»')
    try:return Path(ctypes.wstring_at(result))
    finally:ole.CoTaskMemFree.argtypes=[ctypes.c_void_p];ole.CoTaskMemFree(result)

def local_folder(path):
    path=Path(path).absolute()
    if os.name=='nt':
        function=ctypes.WinDLL('kernel32').GetDriveTypeW;function.argtypes=[ctypes.c_wchar_p];function.restype=ctypes.c_uint
        if path.drive.startswith('\\\\') or function(path.anchor)==4:raise CoreError('NETWORK_LIBRARY','Выберите папку на локальном диске')
    return path

class PickerProcess:
    def __init__(self,purpose):
        args=[sys.executable,'--folder-picker',purpose] if getattr(sys,'frozen',False) else [sys.executable,str(Path(__file__).resolve()),purpose]
        self.child=subprocess.Popen(args,stdin=subprocess.DEVNULL,stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,creationflags=subprocess.CREATE_NO_WINDOW if os.name=='nt' else 0)
    def poll(self):
        if self.child.poll() is None:return None
        raw=self.child.stdout.read(65537);self.child.stdout.close()
        try:
            data=json.loads(raw.decode('utf-8'))
            if len(raw)>65536 or self.child.returncode!=0 or not isinstance(data,dict):raise ValueError()
            if data.get('error'):raise ValueError()
            path=data.get('path')
            if path is not None and (not isinstance(path,str) or len(path)>32768):raise ValueError()
            return Path(path) if path else False
        except (ValueError,UnicodeError):raise CoreError('PICKER_UNAVAILABLE','Не удалось открыть системный выбор папки')
    def close(self):
        if self.child.poll() is None:self.child.terminate();self.child.wait(timeout=5)
        if not self.child.stdout.closed:self.child.stdout.close()

def choose_folder(purpose):return PickerProcess(purpose)

def main(purpose='create'):
    # Tk delegates askdirectory to the platform directory dialog. This process
    # owns the UI main thread, including on macOS, and has no archive lock.
    import tkinter as tk
    from tkinter import filedialog
    root=None
    try:
        root=tk.Tk();root.withdraw()
        title={'create':'MONO — папка для записей','open':'MONO — открыть архив','move':'MONO — перенести архив','backup':'MONO — резервная копия','import':'MONO — восстановить из копии'}[purpose]
        selected=filedialog.askdirectory(parent=root,title=title,mustexist=True)
        result={'path':selected or None}
    except Exception:result={'error':'PICKER_UNAVAILABLE'}
    finally:
        if root is not None:root.destroy()
    encoded=json.dumps(result,ensure_ascii=False).encode('utf-8')
    if sys.stdout is not None:sys.stdout.buffer.write(encoded);sys.stdout.buffer.flush()
    return 1 if 'error' in result else 0

if __name__=='__main__':
    raise SystemExit(main(sys.argv[1] if len(sys.argv)>1 else 'create'))
