"""Compile current local-core sources with reviewed isolated Windows inputs."""
import argparse,hashlib,io,json,os,shutil,subprocess,sys,tarfile
from importlib import metadata
from pathlib import Path
from core_bundle import BINARY,TAG,COMPILER,source_inventory,read_build_bundle,sha256,amd64,plain,compatible_runtime
from fetch_msvc_windows import load_lock,read_input,verify_input,environment_for

PROJECT=Path(__file__).resolve().parent.parent

def build(output,compiler_input,nuitka_archive):
    output=Path(output).absolute()
    if output.exists() or output.is_symlink():raise FileExistsError('Choose a new core build directory; existing work is preserved')
    lock=load_lock()
    try:version=metadata.version('Nuitka')
    except metadata.PackageNotFoundError as error:raise RuntimeError('Install the hash-locked Nuitka build environment') from error
    if version!=lock['nuitka']['version']:raise RuntimeError('Unreviewed Nuitka version')
    if sys.version_info[:3]!=tuple(map(int,lock['python'].split('.'))) or not compatible_runtime():raise RuntimeError('Core compilation requires pinned Python3.14.8 GIL-enabled Windows x64')
    raw_nuitka=read_input(lock['nuitka'],nuitka_archive)
    compiler=verify_input(compiler_input,lock)
    sources,source_hash,imports=source_inventory(PROJECT/'launcher/local_core')
    output.mkdir(parents=True,exist_ok=False)
    snapshot=output/'source/local_core';snapshot.mkdir(parents=True)
    for row in sources:shutil.copy2(PROJECT/'launcher/local_core'/row['path'],snapshot/row['path'])
    generated_init=not (snapshot/'__init__.py').exists()
    if generated_init:(snapshot/'__init__.py').write_text('',encoding='utf-8')
    # All caches other than the validated compiler download are private to this build.
    environment=os.environ.copy()
    for name in ['PYTHONHOME','PYTHONSTARTUP','CC','CXX','CFLAGS','CXXFLAGS','CPPFLAGS','LDFLAGS','CL','_CL_','LINK','_LINK_','LIBPATH']:environment.pop(name,None)
    environment.update(environment_for(compiler,lock))
    environment.update({'PYTHONUTF8':'1','PYTHONDONTWRITEBYTECODE':'1','PYTHONNOUSERSITE':'1','PYTHONPATH':str(snapshot.parent),'NUITKA_CACHE_DIR':str(output/'tool-cache'),'NUITKA_CACHE_DIR_DOWNLOADS':str(output/'tool-cache/downloads')})
    command=[sys.executable,'-m','nuitka','--mode=package','--include-package=local_core','--jobs=2','--lto=no','--disable-cache=ccache','--no-pyi-file','--python-flag=no_docstrings','--file-reference-choice=runtime','--output-dir='+str(output/'native'),'--report='+str(output/'compilation-report.xml'),str(snapshot)]
    subprocess.run(command,check=True,cwd=snapshot.parent,env=environment,stdin=subprocess.DEVNULL)
    if source_inventory(PROJECT/'launcher/local_core')!=(sources,source_hash,imports):raise RuntimeError('Core source set changed during compilation')
    expected_names={row['path'] for row in sources}|({'__init__.py'} if generated_init else set())
    if {p.name for p in snapshot.iterdir()}!=expected_names:raise RuntimeError('Core source snapshot changed')
    for row in sources:
        if sha256(snapshot/row['path'])!=row['sha256']:raise RuntimeError('Core source snapshot changed')
    if generated_init and (snapshot/'__init__.py').read_bytes()!=b'':raise RuntimeError('Generated initializer changed')
    binary=output/'native'/BINARY;plain(binary);amd64(binary)
    bundle=output/'bundle';bundle.mkdir();shutil.copy2(binary,bundle/BINARY)
    with tarfile.open(fileobj=io.BytesIO(raw_nuitka),mode='r:gz') as archive:
        for name,target in [('LICENSE.txt','NUITKA_LICENSE.txt'),('LICENSE-RUNTIME.txt','NUITKA_RUNTIME_EXCEPTION.txt')]:
            member=archive.getmember('nuitka-'+version+'/'+name)
            if not member.isfile() or not 0<member.size<1024**2:raise RuntimeError('Invalid Nuitka runtime license')
            (bundle/target).write_bytes(archive.extractfile(member).read())
    value={'schema':1,'module':'local_core','pythonTag':TAG,'sourceFiles':sources,'sourceHash':source_hash,'stdlibImports':imports,'compiler':COMPILER,'inputs':{'compilerArchivesSha256':{row['id']:row['sha256'] for row in lock['payloads']},'nuitkaSourceSha256':hashlib.sha256(raw_nuitka).hexdigest()},'files':[{'path':p.name,'size':p.stat().st_size,'sha256':sha256(p)} for p in sorted(bundle.iterdir())]}
    (bundle/'PROVENANCE.json').write_text(json.dumps(value,indent=2),encoding='utf-8')
    read_build_bundle(bundle,PROJECT/'launcher/local_core');return bundle

def main():
    parser=argparse.ArgumentParser();parser.add_argument('--output',required=True,type=Path);parser.add_argument('--compiler-input',required=True,type=Path);parser.add_argument('--nuitka-archive',required=True,type=Path);args=parser.parse_args()
    print(json.dumps({'coreBundle':str(build(args.output,args.compiler_input,args.nuitka_archive))}))
if __name__=='__main__':main()
