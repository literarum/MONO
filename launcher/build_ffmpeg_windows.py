"""Build the pinned audio runtime from upstream sources; no global installation.

Requires Windows x64, Python 3.14 and a trusted Git-for-Windows usr/bin directory.
Every output is new. Failed work and logs are retained for diagnosis.
"""
import argparse,hashlib,json,os,re,shutil,stat,subprocess,tarfile,urllib.request,zipfile
from pathlib import Path,PurePosixPath
from native_bundle import sha256,require_amd64
from local_core.paths import reject_links

LOCK=Path(__file__).with_name('ffmpeg-source-windows.lock.json')
FFMPEG_LICENSES={'COPYING.LGPLv2.1','COPYING.LGPLv3','COPYING.GPLv2','COPYING.GPLv3','LICENSE.md'}
MINGW_LICENSES={'COPYING','COPYING.MinGW-w64.txt','COPYING.MinGW-w64-runtime.txt','COPYING.winpthreads.txt','COPYING.winstorecompat.txt'}

def posix(path):
    path=Path(path).absolute()
    return '/'+path.drive[0].lower()+path.as_posix()[2:]

def acquire(item,target,cache=None):
    if cache is not None:
        source=cache/item['name'];reject_links(source)
        if source.stat().st_size!=item['size'] or sha256(source)!=item['sha256']:
            raise RuntimeError('Build input checksum mismatch: '+item['name'])
        with target.open('xb') as output,source.open('rb') as stream:shutil.copyfileobj(stream,output)
    else:
        request=urllib.request.Request(item['url'],headers={'User-Agent':'MONO-source-build'})
        with urllib.request.urlopen(request,timeout=60) as response,target.open('xb') as output:
            if not response.geturl().startswith('https://'):raise RuntimeError('HTTPS build inputs required')
            total=0
            while chunk:=response.read(1024*1024):
                total+=len(chunk)
                if total>item['size']:raise RuntimeError('Build input exceeds pinned size')
                output.write(chunk)
    if target.stat().st_size!=item['size'] or sha256(target)!=item['sha256']:
        raise RuntimeError('Build input checksum mismatch: '+item['name'])

def safe_name(raw):
    name=PurePosixPath(raw)
    if not raw or name.is_absolute() or '\\' in raw or '\0' in raw or any(
        part in {'.','..'} or ':' in part or part.endswith(('.', ' ')) or
        re.fullmatch(r'(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?',part,re.I)
        for part in raw.rstrip('/').split('/')):
        raise RuntimeError('Unsafe build archive path')
    return name

def extract(archive,destination):
    """Validate the complete inventory before writing any member; no links/devices."""
    destination.mkdir(parents=True,exist_ok=False);seen=set();total=0
    def check(raw,size,allowed):
        nonlocal total
        name=safe_name(raw);key=name.as_posix().casefold();total+=size
        if not allowed or key in seen or size<0 or total>3*1024**3 or len(seen)>100000:
            raise RuntimeError('Unsafe build archive inventory')
        seen.add(key);return name
    if zipfile.is_zipfile(archive):
        with zipfile.ZipFile(archive) as source:
            entries=[(check(e.orig_filename,e.file_size,not stat.S_ISLNK(e.external_attr>>16)),e) for e in source.infolist()]
            for name,entry in entries:
                target=destination.joinpath(*name.parts)
                if entry.is_dir():target.mkdir(parents=True,exist_ok=True)
                else:
                    target.parent.mkdir(parents=True,exist_ok=True)
                    with source.open(entry) as stream,target.open('xb') as output:shutil.copyfileobj(stream,output)
    else:
        with tarfile.open(archive,'r:*') as source:
            entries=[(check(e.name,e.size,e.isfile() or e.isdir()),e) for e in source.getmembers()]
            for name,entry in entries:
                target=destination.joinpath(*name.parts)
                if entry.isdir():target.mkdir(parents=True,exist_ok=True)
                else:
                    target.parent.mkdir(parents=True,exist_ok=True)
                    with source.extractfile(entry) as stream,target.open('xb') as output:shutil.copyfileobj(stream,output)

def configure_options(codecs,filters,install,zlib):
    audio=codecs.split('/* audio codecs */',1)[1].split('/* subtitles */',1)[0]
    decoders=re.findall(r'extern const FFCodec ff_(\w+)_decoder;',audio)
    encoders=re.findall(r'extern const FFCodec ff_(\w+)_encoder;',audio)
    audio_filters=re.findall(r'extern\s+const FFFilter ff_(?:af|asrc|asink)_(\w+);',filters)
    audio_filters=list(dict.fromkeys(audio_filters+['amovie','concat']))
    if not decoders or not encoders or not audio_filters:raise RuntimeError('Audio source declaration inventory missing')
    return ['--prefix='+posix(install),'--target-os=mingw32','--arch=x86_64',
        '--cc=x86_64-w64-mingw32-clang','--cxx=x86_64-w64-mingw32-clang++',
        '--ar=llvm-ar','--nm=llvm-nm','--ranlib=llvm-ranlib','--windres=llvm-windres','--strip=llvm-strip',
        '--disable-autodetect','--disable-gpl','--disable-nonfree','--disable-version3',
        '--enable-shared','--disable-static','--disable-debug','--disable-doc','--disable-ffplay',
        '--disable-network','--disable-devices','--enable-indev=lavfi','--disable-hwaccels',
        '--disable-pthreads','--enable-w32threads','--enable-zlib',
        '--extra-cflags=-I'+posix(zlib),'--extra-ldflags=-L'+posix(zlib)+' -Wl,--no-insert-timestamp',
        '--disable-decoders','--enable-decoder='+','.join(decoders),
        '--disable-encoders','--enable-encoder='+','.join(encoders),
        '--disable-filters','--enable-filter='+','.join(audio_filters),'--extra-version=mono-audio-1']

def build(output,msys_bin,cache=None,jobs=2):
    output=output.expanduser().absolute();output.mkdir(parents=True,exist_ok=False)
    if os.name!='nt' or not 1<=jobs<=4:raise RuntimeError('Windows x64 and 1..4 build jobs required')
    reject_links(output);msys_bin=msys_bin.absolute();reject_links(msys_bin)
    bash=msys_bin/'bash.exe'
    if not bash.is_file() or not (msys_bin/'msys-2.0.dll').is_file():raise RuntimeError('Trusted Git-for-Windows usr/bin required')
    lock=json.loads(LOCK.read_text(encoding='utf-8'))
    if sha256(Path(__file__))!=lock['recipeSha256']:raise RuntimeError('Source build recipe does not match lock')
    archives=output/'archives';archives.mkdir()
    for item in lock['inputs'].values():acquire(item,archives/item['name'],cache)
    # All inputs are checked before extraction, compiler or any source script.
    for name,item in lock['inputs'].items():extract(archives/item['name'],output/name)
    source=output/'ffmpeg'/('FFmpeg-'+lock['sourceCommit'])
    llvm=output/'llvm'/lock['llvmRoot'];nasm=output/'nasm'/'nasm-3.02'
    make=output/'make/usr/bin/make.exe';zlib=output/'zlib/zlib-1.3.2'
    for binary in [llvm/'bin/x86_64-w64-mingw32-clang.exe',nasm/'nasm.exe',make]:require_amd64(binary)
    env=os.environ.copy()
    for key in list(env):
        if key.upper() in {'CC','CXX','CFLAGS','CXXFLAGS','CPPFLAGS','LDFLAGS','LIB','INCLUDE','LIBPATH','CL','_CL_','LINK','_LINK_','BASH_ENV','ENV','PKG_CONFIG_PATH','PKG_CONFIG_LIBDIR','MAKEFLAGS','MFLAGS','GNUMAKEFLAGS','SHELLOPTS','BASHOPTS','CDPATH','GIT_CONFIG_GLOBAL','GIT_CONFIG_SYSTEM'}:env.pop(key)
    env.update(PATH=os.pathsep.join(map(str,[llvm/'bin',nasm,make.parent,msys_bin,Path(os.environ['SYSTEMROOT'])/'System32'])),LC_ALL='C',LANG='C',MAKEFLAGS='',SOURCE_DATE_EPOCH=str(lock['sourceDateEpoch']))
    logs=output/'logs';logs.mkdir()
    def run(name,args,cwd):
        with (logs/(name+'.log')).open('xb') as log:
            result=subprocess.run(list(map(str,args)),cwd=cwd,env=env,stdin=subprocess.DEVNULL,stdout=log,stderr=subprocess.STDOUT)
        (logs/(name+'.exit')).write_text(str(result.returncode),encoding='ascii')
        print(json.dumps({'step':name,'exitCode':result.returncode}),flush=True)
        if result.returncode:raise RuntimeError('Source build failed: '+name+'; see '+str(logs))
    run('compiler',[llvm/'bin/x86_64-w64-mingw32-clang.exe','--version'],output)
    run('assembler',[nasm/'nasm.exe','-v'],output)
    zargs=[make,'-f','win32/Makefile.gcc','CC=x86_64-w64-mingw32-clang','LD=x86_64-w64-mingw32-clang','AR=llvm-ar','STRIP=llvm-strip','-j'+str(jobs)]
    run('zlib',zargs+['libz.a'],zlib)
    run('zlib-test',zargs+['test'],zlib)
    build_dir=output/'build';build_dir.mkdir();install=output/'install'
    options=configure_options((source/'libavcodec/allcodecs.c').read_text(encoding='utf-8'),(source/'libavfilter/allfilters.c').read_text(encoding='utf-8'),install,zlib)
    command={'schema':1,'sourceCommit':lock['sourceCommit'],'options':options,'jobs':jobs,'sourceChanges':False,'zlibLinkage':'static','buildEnvironment':'isolated LLVM/NASM/make/Git usr/bin/System32 PATH; no global installs','msysBin':str(msys_bin)}
    (output/'BUILD-COMMAND.json').write_text(json.dumps(command,indent=2)+'\n',encoding='utf-8')
    run('configure',[bash,posix(source/'configure'),*options],build_dir)
    run('compile',[make,'-j'+str(jobs)],build_dir)
    run('install',[make,'install'],build_dir)
    config=(build_dir/'config.h').read_text(encoding='utf-8')
    unexpected=re.findall(r'^#define CONFIG_(LIB\w+|CHROMAPRINT|ICONV|GMP|LZMA|BZLIB|OPENSSL|GNUTLS|SDL2|NETWORK|GPL|NONFREE|VERSION3) 1$',config,re.M)
    if unexpected or '#define CONFIG_ZLIB 1' not in config:raise RuntimeError('Unexpected FFmpeg dependency configuration')
    if not re.search(r'^#define HAVE_X86ASM 1$',config,re.M):raise RuntimeError('Assembly optimizations were not enabled')
    bundle=output/'bundle';bundle.mkdir()
    names=set(lock['runtimeFiles'])
    if {p.name for p in (install/'bin').glob('*.exe')}|{p.name for p in (install/'bin').glob('*.dll')}!=names:raise RuntimeError('Unexpected FFmpeg runtime inventory')
    for name in names:shutil.copy2(install/'bin'/name,bundle/name)
    for name in FFMPEG_LICENSES:shutil.copy2(source/name,bundle/name)
    shutil.copy2(zlib/'LICENSE',bundle/'ZLIB-LICENSE.txt')
    shutil.copy2(llvm/'LICENSE.TXT',bundle/'LLVM-LICENSE.txt')
    for name in MINGW_LICENSES:shutil.copy2(llvm/'x86_64-w64-mingw32/share/mingw32'/name,bundle/('MINGW-'+name))
    for source_path,name in [(archives/lock['inputs']['ffmpeg']['name'],'FFMPEG-SOURCE.tar.gz'),(archives/lock['inputs']['zlib']['name'],'ZLIB-SOURCE.tar.gz'),(Path(__file__),'BUILD-RECIPE.py'),(LOCK,'BUILD-LOCK.json'),(output/'BUILD-COMMAND.json','BUILD-COMMAND.json'),(build_dir/'config.h','CONFIG.h'),(build_dir/'config_components.h','CONFIG-COMPONENTS.h')]:shutil.copy2(source_path,bundle/name)
    from runtime_licenses import inspect_license
    from ffmpeg_bundle import read_bundle
    licenses={name:inspect_license(bundle/(name+'.exe'),name) for name in ['ffmpeg','ffprobe']}
    files=[{'path':p.name,'size':p.stat().st_size,'sha256':sha256(p)} for p in sorted(bundle.iterdir())]
    value={'schema':2,'lock':lock,'licenses':licenses,'files':files,'sourceChanges':False,'correspondingSource':'Included exact FFmpeg and zlib source archives, recipe, lock, configuration and original runtime notices; whole-application license clearance separate'}
    (bundle/'PROVENANCE.json').write_text(json.dumps(value,indent=2)+'\n',encoding='utf-8');read_bundle(bundle)
    return bundle

if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output',type=Path,required=True);parser.add_argument('--msys-bin',type=Path,required=True)
    parser.add_argument('--cache',type=Path);parser.add_argument('--jobs',type=int,default=2)
    args=parser.parse_args();print(json.dumps({'bundle':str(build(args.output,args.msys_bin,args.cache,args.jobs)),'scope':'unsigned source-built audio runtime; full product acceptance separate'}))
