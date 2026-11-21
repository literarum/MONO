"""Acquire pinned publisher-reviewed portable MSVC/SDK inputs; never install/execute."""
import argparse,hashlib,io,json,os,re,shutil,stat,zipfile
from pathlib import Path
from fetch_compiler_windows import read_input,RESERVED
from core_bundle import plain
LOCK=Path(__file__).with_name('compiler-msvc-windows.lock.json')
IDS={'msvc-tools','msvc-resources','msvc-headers','msvc-libs','msvc-imports','sdk-common','sdk-x64'}

def load_lock():
    value=json.loads(LOCK.read_text(encoding='utf-8'))
    if value.get('schema')!=1 or value.get('python')!='3.14.8' or value.get('compiler')!={'kind':'msvc','version':'14.51.36260','toolsetDirectory':'14.51.36231','architecture':'x86_64'} or value.get('windowsSdk')!={'version':'10.0.26100.9169','directory':'10.0.26100.0'}:raise RuntimeError('Unsupported MSVC lock')
    rows=value['payloads']
    if len(rows)!=len(IDS) or {r['id'] for r in rows}!=IDS:raise RuntimeError('Incomplete MSVC/SDK lock')
    names=set()
    for row in [*rows,value['nuitka']]:
        if not re.fullmatch('[A-Za-z0-9._+-]+',row.get('filename','')) or row['filename'].casefold() in names or not re.fullmatch('[a-f0-9]{64}',row.get('sha256','')) or not row.get('url','').startswith('https://'):raise RuntimeError('Invalid MSVC input pin')
        names.add(row['filename'].casefold())
    return value

def inspect_archive(raw):
    try:
        with zipfile.ZipFile(io.BytesIO(raw)) as archive:
            names=set();files=set();total=0
            for entry in archive.infolist():
                raw_name=entry.orig_filename;name=raw_name[:-1] if raw_name.endswith('/') else raw_name;parts=name.split('/')
                if not name or '\\' in raw_name or ':' in raw_name or any(ord(c)<32 for c in raw_name) or any(p in {'','.','..'} or p.endswith(('.', ' ')) or p.split('.')[0].upper() in RESERVED for p in parts):raise ValueError('Unsafe Windows archive path')
                if stat.S_ISLNK(entry.external_attr>>16) or name.casefold() in names:raise ValueError('Linked/duplicate archive path')
                names.add(name.casefold());total+=entry.file_size
                if not entry.is_dir():files.add(name)
            if total>2*1024**3 or not files:raise ValueError('Oversized/empty archive')
            return files
    except (ValueError,zipfile.BadZipFile,TypeError) as error:raise RuntimeError('Invalid MSVC/SDK archive') from error

def write_payload(raw,destination):
    with zipfile.ZipFile(io.BytesIO(raw)) as archive:archive.extractall(destination)

def overlay_path(row,name):
    if row['id']=='msvc-resources' and name.startswith('Contents/VC/Tools/MSVC/14.51.36231/bin/Hostx64/x64/1033/'):
        return Path('payloads/msvc-tools')/name
    return None

def acquire(output,archives=None):
    output=Path(output).absolute()
    if output.exists() or output.is_symlink():raise FileExistsError('Choose a new compiler directory; existing work is preserved')
    lock=load_lock();output.mkdir(parents=True,exist_ok=False);(output/'archives').mkdir();inventory=[]
    for row in lock['payloads']:
        raw=read_input(row,Path(archives)/row['filename'] if archives is not None else None);names=inspect_archive(raw)
        if not {p.casefold() for p in row['required']}<={p.casefold() for p in names}:raise RuntimeError('Incomplete compiler/SDK payload')
        (output/'archives'/row['filename']).write_bytes(raw)
        target=output/'payloads'/row['id'];target.mkdir(parents=True);write_payload(raw,target)
        for name in sorted(names):
            file=target/name;plain(file);inventory.append({'path':file.relative_to(output).as_posix(),'size':file.stat().st_size,'sha256':hashlib.sha256(file.read_bytes()).hexdigest()})
            overlay=overlay_path(row,name)
            if overlay is not None:
                destination=output/overlay;destination.parent.mkdir(parents=True,exist_ok=True);plain(destination.parent)
                with file.open('rb') as incoming,destination.open('xb') as current:shutil.copyfileobj(incoming,current)
                inventory.append({'path':overlay.as_posix(),'size':destination.stat().st_size,'sha256':hashlib.sha256(destination.read_bytes()).hexdigest()})
    row=lock['nuitka'];raw=read_input(row,Path(archives)/row['filename'] if archives is not None else None);(output/'archives'/row['filename']).write_bytes(raw)
    (output/'PROVENANCE.json').write_text(json.dumps({'schema':1,'compiler':lock['compiler'],'windowsSdk':lock['windowsSdk'],'files':inventory},indent=2),encoding='utf-8')
    verify_input(output,lock);return output

def verify_input(directory,lock):
    directory=Path(directory).absolute();plain(directory);expected={'PROVENANCE.json'}
    for row in lock['payloads']:
        archive_file=directory/'archives'/row['filename'];plain(archive_file);raw=read_input(row,archive_file);names=inspect_archive(raw);expected.add(archive_file.relative_to(directory).as_posix())
        if not {p.casefold() for p in row['required']}<={p.casefold() for p in names}:raise RuntimeError('Incomplete compiler/SDK payload')
        with zipfile.ZipFile(io.BytesIO(raw)) as archive:
            for name in sorted(names):
                with archive.open(name) as incoming:digest=hashlib.file_digest(incoming,'sha256').digest()
                files=[directory/'payloads'/row['id']/name];overlay=overlay_path(row,name)
                if overlay is not None:files.append(directory/overlay)
                for file in files:
                    plain(file);expected.add(file.relative_to(directory).as_posix())
                    with file.open('rb') as current:
                        if digest!=hashlib.file_digest(current,'sha256').digest():raise RuntimeError('Compiler/SDK extracted bytes changed')
    source=directory/'archives'/lock['nuitka']['filename'];plain(source);read_input(lock['nuitka'],source);expected.add(source.relative_to(directory).as_posix())
    actual=set()
    for file in directory.rglob('*'):
        plain(file)
        if file.is_file():actual.add(file.relative_to(directory).as_posix())
    if actual!=expected:raise RuntimeError('Compiler/SDK extracted file set changed')
    return directory

def environment_for(directory,lock):
    directory=Path(directory);payloads=directory/'payloads';toolset='Contents/VC/Tools/MSVC/'+lock['compiler']['toolsetDirectory'];sdk=payloads/'sdk-common/c';version=lock['windowsSdk']['directory']
    include=[payloads/'msvc-headers'/toolset/'include',*[sdk/'Include'/version/name for name in ['ucrt','shared','um','winrt']]]
    libs=[payloads/'msvc-imports'/toolset/'lib/x64',payloads/'msvc-libs'/toolset/'lib/x64',payloads/'sdk-x64/c/ucrt/x64',payloads/'sdk-x64/c/um/x64']
    paths=[payloads/'msvc-tools'/toolset/'bin/Hostx64/x64',sdk/'bin'/version/'x64',Path(os.environ['SYSTEMROOT'])/'System32']
    return {'PATH':os.pathsep.join(map(str,paths)),'INCLUDE':os.pathsep.join(map(str,include)),'LIB':os.pathsep.join(map(str,libs)),'WindowsSDKVersion':version+'\\','WindowsSdkDir':str(sdk)+os.sep,'VCToolsInstallDir':str(payloads/'msvc-tools'/toolset)+os.sep,'VCToolsVersion':lock['compiler']['toolsetDirectory'],'VSLANG':'1033','COMSPEC':str(Path(os.environ['SYSTEMROOT'])/'System32/cmd.exe')}

def main():
    parser=argparse.ArgumentParser();parser.add_argument('--output',required=True,type=Path);parser.add_argument('--archives',type=Path);args=parser.parse_args();print(json.dumps({'compilerInput':str(acquire(args.output,args.archives))}))
if __name__=='__main__':main()
