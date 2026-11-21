"""Acquire fixed build-only Windows compiler inputs. Never executes downloaded code."""
import argparse,hashlib,io,json,re,shutil,stat,urllib.request,zipfile
from pathlib import Path

LOCK=Path(__file__).with_name('compiler-windows.lock.json')
MAX_ARCHIVE=512*1024**2
REQUIRED={'mingw64/bin/'+name for name in ['gcc.exe','g++.exe','as.exe','ld.exe','windres.exe']}
RESERVED={'CON','PRN','AUX','NUL',*['COM'+str(i) for i in range(1,10)],*['LPT'+str(i) for i in range(1,10)]}

def load_lock():
    value=json.loads(LOCK.read_text(encoding='utf-8'))
    if value.get('schema')!=1 or value.get('python')!='3.12.10' or value['compiler'].get('architecture')!='x86_64':raise RuntimeError('Unsupported compiler lock')
    for key in ['compiler','nuitka']:
        row=value[key]
        if not isinstance(row.get('url'),str) or not row['url'].startswith('https://') or not re.fullmatch('[a-f0-9]{64}',row.get('sha256','')) or not re.fullmatch('[A-Za-z0-9._+-]+',row.get('filename','')):raise RuntimeError('Invalid compiler input lock')
    if not re.fullmatch('[A-Za-z0-9._+-]+',value['compiler'].get('release','')):raise RuntimeError('Invalid compiler release')
    return value

def sha(data):return hashlib.sha256(data).hexdigest()

def read_input(row,archive=None):
    if archive is not None:
        path=Path(archive)
        if path.is_symlink() or not path.is_file() or path.stat().st_size>MAX_ARCHIVE:raise RuntimeError('Invalid compiler archive')
        data=path.read_bytes()
    else:
        with urllib.request.urlopen(row['url'],timeout=60) as response:
            if not response.geturl().startswith('https://'):raise RuntimeError('Compiler transport must use HTTPS')
            data=response.read(MAX_ARCHIVE+1)
    if len(data)>MAX_ARCHIVE or sha(data)!=row['sha256']:raise RuntimeError('Compiler input checksum mismatch')
    return data

def inspect_archive(data):
    """Validate raw names before extraction; bytes must separately pass pinned SHA."""
    try:
        with zipfile.ZipFile(io.BytesIO(data)) as archive:
            seen=set();files=set();total=0
            for entry in archive.infolist():
                raw=entry.orig_filename;name=raw[:-1] if raw.endswith('/') else raw;parts=name.split('/')
                if not name or '\\' in raw or ':' in raw or '\x00' in raw or parts[0]!='mingw64' or any(p in {'','.','..'} or p.endswith(('.', ' ')) or p.split('.')[0].upper() in RESERVED for p in parts):raise ValueError('Invalid raw compiler archive path')
                if stat.S_ISLNK(entry.external_attr>>16) or name.casefold() in seen:raise ValueError('Linked/duplicate compiler archive path')
                seen.add(name.casefold());total+=entry.file_size
                if not entry.is_dir():files.add(name)
            if total>2*1024**3 or not REQUIRED<=files:raise ValueError('Incomplete or oversized compiler archive')
            return files
    except (ValueError,zipfile.BadZipFile,TypeError) as error:raise RuntimeError('Invalid compiler archive paths or inventory') from error

def cache_directory(output,lock):return Path(output)/'cache/downloads/gcc/x86_64'/lock['compiler']['release']

def write_payload(data,destination):
    with zipfile.ZipFile(io.BytesIO(data)) as archive:archive.extractall(destination)

def acquire(output,archive=None,nuitka_archive=None):
    output=Path(output).absolute()
    if output.exists() or output.is_symlink():raise FileExistsError('Choose a new compiler input directory; existing work is preserved')
    output.mkdir(parents=True,exist_ok=False);lock=load_lock()
    data=read_input(lock['compiler'],archive);files=inspect_archive(data)
    # Keep the verified immutable archive for independent extracted-byte checks.
    (output/lock['compiler']['filename']).write_bytes(data)
    destination=cache_directory(output,lock);destination.mkdir(parents=True)
    write_payload(data,destination)
    nuitka=read_input(lock['nuitka'],nuitka_archive);(output/lock['nuitka']['filename']).write_bytes(nuitka)
    inventory=[]
    for name in sorted(files):
        file=destination/name
        if file.is_symlink() or not file.is_file():raise RuntimeError('Compiler extraction failed')
        with file.open('rb') as stream:digest=hashlib.file_digest(stream,'sha256').hexdigest()
        inventory.append({'path':name,'size':file.stat().st_size,'sha256':digest})
    value={'schema':1,'compiler':lock['compiler'],'nuitka':lock['nuitka'],'files':inventory}
    (output/'PROVENANCE.json').write_text(json.dumps(value,indent=2),encoding='utf-8');return output

def verify_input(directory,lock):
    """Compare actual compiler files against pinned archive bytes, not mutable hashes."""
    from core_bundle import plain
    directory=Path(directory).absolute();plain(directory)
    raw=read_input(lock['compiler'],directory/lock['compiler']['filename']);files=inspect_archive(raw);destination=cache_directory(directory,lock)
    actual=set()
    for file in destination.rglob('*'):
        plain(file)
        if file.is_file():actual.add(file.relative_to(destination).as_posix())
    if actual!=files:raise RuntimeError('Compiler extracted file set changed')
    with zipfile.ZipFile(io.BytesIO(raw)) as archive:
        for name in sorted(files):
            file=destination/name
            with archive.open(name) as incoming,file.open('rb') as current:
                if hashlib.file_digest(incoming,'sha256').digest()!=hashlib.file_digest(current,'sha256').digest():raise RuntimeError('Compiler extracted bytes changed')
    return destination/'mingw64/bin/gcc.exe'

def main():
    parser=argparse.ArgumentParser();parser.add_argument('--output',required=True,type=Path);parser.add_argument('--archive',type=Path);parser.add_argument('--nuitka-archive',type=Path);args=parser.parse_args()
    print(json.dumps({'compilerInput':str(acquire(args.output,args.archive,args.nuitka_archive))}))
if __name__=='__main__':main()
