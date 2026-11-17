"""Native local-core build/runtime inventory. Stdlib only: verify before import."""
import ast,hashlib,json,os,re,stat,struct,sys,sysconfig,shutil
from pathlib import Path

BINARY='local_core.cp314-win_amd64.pyd'
NOTICES={'NUITKA_LICENSE.txt','NUITKA_RUNTIME_EXCEPTION.txt'}
PAYLOAD={BINARY}|NOTICES
TAG='cp314-win_amd64'
PYTHON_VERSION=(3,14,8)
COMPILER={'nuitka':'4.3.1','msvc':'14.51.36260','windowsSdk':'10.0.26100.9169'}

def compatible_runtime():
    return os.name=='nt' and sys.version_info[:3]==PYTHON_VERSION and struct.calcsize('P')==8 and not sysconfig.get_config_var('Py_GIL_DISABLED')

def sha256(file):
    with Path(file).open('rb') as stream:return hashlib.file_digest(stream,'sha256').hexdigest()

def plain(path):
    path=Path(path)
    for part in [path,*path.parents]:
        value=part.lstat()
        if stat.S_ISLNK(value.st_mode) or getattr(value,'st_file_attributes',0)&0x400:raise ValueError('Linked compiled core path')

def amd64(file):
    with file.open('rb') as stream:
        header=stream.read(64)
        if len(header)!=64 or header[:2]!=b'MZ':raise ValueError('Compiled core PE header')
        offset=struct.unpack_from('<I',header,60)[0]
        if not 64<=offset<=file.stat().st_size-26:raise ValueError('Compiled core PE bounds')
        stream.seek(offset);pe=stream.read(26)
        if pe[:4]!=b'PE\0\0' or struct.unpack_from('<H',pe,4)[0]!=0x8664 or struct.unpack_from('<H',pe,24)[0]!=0x20b:raise ValueError('Compiled core requires AMD64 PE32+')

def source_inventory(source):
    entries=[];imports=set()
    for file in sorted(Path(source).iterdir()):
        if file.suffix not in {'.py','.sql'}:continue
        plain(file);entries.append({'path':file.name,'sha256':sha256(file)})
        if file.suffix=='.py':
            for node in ast.walk(ast.parse(file.read_text(encoding='utf-8'))):
                if isinstance(node,ast.Import):imports.update(alias.name for alias in node.names)
                elif isinstance(node,ast.ImportFrom) and node.module:imports.add(node.module)
    if not entries or 'schema.sql' not in {v['path'] for v in entries}:raise ValueError('Core source/schema missing')
    imports=sorted(name for name in imports if name!='local_core' and not name.startswith('local_core.'))
    if any(name.split('.')[0] not in sys.stdlib_module_names for name in imports):raise ValueError('Unknown core dependency')
    digest=hashlib.sha256(json.dumps(entries,sort_keys=True,separators=(',',':')).encode()).hexdigest()
    return entries,digest,imports

def check_entries(root,entries,expected):
    if not isinstance(entries,list) or len(entries)!=len(expected):raise ValueError('Compiled core inventory count')
    seen=set()
    for row in entries:
        if not isinstance(row,dict):raise ValueError('Compiled core inventory row')
        name=row['path'];size=row['size'];digest=row['sha256']
        if not isinstance(name,str) or name not in expected or name in seen or type(size) is not int or size<=0 or not isinstance(digest,str) or not re.fullmatch('[a-f0-9]{64}',digest):raise ValueError('Compiled core inventory entry')
        seen.add(name);file=root/name;plain(file)
        if not file.is_file() or file.stat().st_size!=size or sha256(file)!=digest:raise ValueError('Compiled core missing or damaged')

def read_build_bundle(directory,source):
    try:
        directory=Path(directory).absolute();plain(directory);file=directory/'PROVENANCE.json';plain(file)
        if not file.is_file() or file.stat().st_size>2*1024**2:raise ValueError('Compiled core provenance size')
        value=json.loads(file.read_text(encoding='utf-8'))
        if not isinstance(value,dict) or value.get('schema')!=1 or value.get('module')!='local_core' or value.get('pythonTag')!=TAG:raise ValueError('Compiled core metadata')
        if not compatible_runtime():raise ValueError('Compiled core requires pinned GIL-enabled CPython3.14.8 Windows x64')
        sources,digest,imports=source_inventory(source)
        if value.get('sourceFiles')!=sources or value.get('sourceHash')!=digest or value.get('stdlibImports')!=imports:raise ValueError('Compiled core source mismatch')
        if value.get('compiler')!=COMPILER:raise ValueError('Unreviewed core compiler input')
        check_entries(directory,value.get('files'),PAYLOAD);amd64(directory/BINARY)
        if {p.name for p in directory.iterdir()}!=PAYLOAD|{'PROVENANCE.json'}:raise ValueError('Extra core payload')
        return value
    except (OSError,ValueError,TypeError,KeyError,AttributeError,SyntaxError) as error:
        raise RuntimeError('Compiled core input missing, stale or invalid') from error

def stage_bundle(directory,stage,value):
    directory=Path(directory);notice=stage/'runtime/licenses/core';notice.mkdir(parents=True)
    # The active import-root binary is separately inventoried. Staged launcher
    # copy is PyInstaller's analysis input; no Python source audit copy is made.
    shutil.copy2(directory/BINARY,stage/BINARY);shutil.copy2(directory/BINARY,stage/'launcher'/BINARY)
    files=[]
    for name in sorted(NOTICES|{'PROVENANCE.json'}):shutil.copy2(directory/name,notice/name)
    for name in [BINARY,*['runtime/licenses/core/'+n for n in sorted(NOTICES|{'PROVENANCE.json'})]]:
        file=stage/name;files.append({'path':name,'size':file.stat().st_size,'sha256':sha256(file)})
    return {'schema':1,'module':'local_core','pythonTag':TAG,'sourceHash':value['sourceHash'],'stdlibImports':value['stdlibImports'],'files':files}

def verify_staged_core(root,value):
    try:
        if not compatible_runtime():raise ValueError('Compiled core runtime ABI mismatch')
        if not isinstance(value,dict) or value.get('schema')!=1 or value.get('module')!='local_core' or value.get('pythonTag')!=TAG:raise ValueError('Compiled core manifest')
        expected={BINARY}|{'runtime/licenses/core/'+name for name in NOTICES|{'PROVENANCE.json'}}
        check_entries(root,value.get('files'),expected);amd64(root/BINARY)
        for location in [root/'local_core',root/'launcher/local_core']:
            if not location.exists():continue
            plain(location)
            for file in location.rglob('*'):
                plain(file)
                if file.is_file() and file.suffix.lower() in {'.py','.pyc','.pyo','.pyd'}:raise ValueError('Compiled core contains a replacement Python package')
        if any((root/name).exists() for name in ['local_core.py','local_core.pyc','local_core.pyo']):raise ValueError('Compiled core contains replacement module')
    except (OSError,ValueError,TypeError,KeyError,AttributeError) as error:
        raise RuntimeError('Compiled core missing, changed or invalid') from error
