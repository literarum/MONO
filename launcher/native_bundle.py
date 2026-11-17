"""Shared build/runtime integrity rules for the Windows capture capsule."""
import hashlib,json,re,struct
from pathlib import Path
from local_core.paths import reject_links
from local_core.protocol import CoreError

BINARY='MonoAudio.exe'
PAYLOAD={BINARY,'DOTNET_LICENSE.txt','DOTNET_THIRD_PARTY_NOTICES.txt'}

def sha256(file):
    result=hashlib.sha256()
    with file.open('rb') as stream:
        for block in iter(lambda:stream.read(1024*1024),b''):result.update(block)
    return result.hexdigest()

def source_inventory(root):
    entries=[]
    for file in sorted(root.rglob('*')):
        relative=file.relative_to(root)
        if any(part in ['bin','obj','tests'] for part in relative.parts) or file.suffix not in ['.cs','.csproj']:continue
        reject_links(file)
        entries.append({'path':relative.as_posix(),'sha256':sha256(file)})
    if not entries:raise RuntimeError('Native capture sources missing')
    digest=hashlib.sha256(json.dumps(entries,sort_keys=True,separators=(',',':')).encode()).hexdigest()
    return entries,digest

def require_amd64(file):
    with file.open('rb') as stream:
        header=stream.read(64)
        if len(header)!=64 or header[:2]!=b'MZ':raise RuntimeError('Invalid native capture PE header')
        offset=struct.unpack_from('<I',header,60)[0]
        if not 64<=offset<=file.stat().st_size-26:raise RuntimeError('Truncated native capture PE')
        stream.seek(offset);pe=stream.read(26)
        if pe[:4]!=b'PE\0\0' or struct.unpack_from('<H',pe,4)[0]!=0x8664 or struct.unpack_from('<H',pe,24)[0]!=0x20b:raise RuntimeError('Native capture requires AMD64 PE32+')

def verify_inventory(directory,entries,*,provenance=False):
    try:
        reject_links(directory)
        expected=PAYLOAD|({'PROVENANCE.json'} if provenance else set())
        if not isinstance(entries,list) or len(entries)!=len(expected):raise ValueError()
        names=set()
        for item in entries:
            name=item['path'];size=item['size'];digest=item['sha256']
            if name not in expected or name in names or type(size) is not int or size<=0 or not isinstance(digest,str) or not re.fullmatch('[a-f0-9]{64}',digest):raise ValueError()
            names.add(name);file=directory/name;reject_links(file)
            if not file.is_file() or file.stat().st_size!=size or sha256(file)!=digest:raise ValueError()
        require_amd64(directory/BINARY)
    except (KeyError,ValueError,TypeError,AttributeError,OSError,CoreError) as error:
        raise RuntimeError('Native capture bundle missing, damaged or incomplete') from error

def read_build_bundle(directory,source_root):
    try:
        directory=Path(directory).absolute();file=directory/'PROVENANCE.json';reject_links(file)
        if not file.is_file() or file.stat().st_size>1024*1024:raise ValueError()
        value=json.loads(file.read_text(encoding='utf-8'))
        if value.get('schema')!=1 or value.get('protocol')!=1 or value.get('rid')!='win-x64':raise ValueError()
        sources,digest=source_inventory(source_root)
        if value.get('sourceHash')!=digest or value.get('sourceFiles')!=sources:raise ValueError()
        verify_inventory(directory,value['files'])
        if {entry.name for entry in directory.iterdir()}!=PAYLOAD|{'PROVENANCE.json'}:raise ValueError()
        return value
    except (KeyError,ValueError,TypeError,AttributeError,OSError,CoreError) as error:
        raise RuntimeError('Native capture input missing, stale or invalid; run launcher/build_capture.py') from error

def verify_staged_capture(directory,value):
    if not isinstance(value,dict) or value.get('rid')!='win-x64' or value.get('protocol')!=1:raise RuntimeError('Missing native capture inventory')
    verify_inventory(directory,value.get('files'),provenance=True)
