"""Integrity inventory for the reviewed shared Windows FFmpeg runtime."""
import json,re,shutil
from pathlib import Path
from native_bundle import sha256,require_amd64
from local_core.paths import reject_links
from local_core.protocol import CoreError

FAMILIES={'avcodec','avdevice','avfilter','avformat','avutil','swresample','swscale'}
LICENSES={'COPYING.LGPLv3','COPYING.GPLv3'}
SOURCE_NOTICES=LICENSES|{'COPYING.LGPLv2.1','COPYING.GPLv2','LICENSE.md',
    'ZLIB-LICENSE.txt','LLVM-LICENSE.txt','MINGW-COPYING','MINGW-COPYING.MinGW-w64.txt',
    'MINGW-COPYING.MinGW-w64-runtime.txt','MINGW-COPYING.winpthreads.txt',
    'MINGW-COPYING.winstorecompat.txt','FFMPEG-SOURCE.tar.gz','ZLIB-SOURCE.tar.gz',
    'BUILD-RECIPE.py','BUILD-LOCK.json','BUILD-COMMAND.json','CONFIG.h','CONFIG-COMPONENTS.h'}

def verify_source_materials(directory,lock):
    pinned={'BUILD-RECIPE.py':lock['recipeSha256'],'FFMPEG-SOURCE.tar.gz':lock['inputs']['ffmpeg']['sha256'],'ZLIB-SOURCE.tar.gz':lock['inputs']['zlib']['sha256']}
    if any(sha256(directory/name)!=digest for name,digest in pinned.items()):raise RuntimeError('Source archive or recipe does not match reviewed lock')
    if json.loads((directory/'BUILD-LOCK.json').read_text(encoding='utf-8'))!=lock:raise RuntimeError('Source build lock changed')
    config=(directory/'CONFIG.h').read_text(encoding='utf-8')
    if re.search(r'^#define CONFIG_(LIB\w+|CHROMAPRINT|ICONV|GMP|LZMA|BZLIB|OPENSSL|GNUTLS|SDL2|NETWORK|GPL|NONFREE|VERSION3) 1$',config,re.M) or not re.search(r'^#define CONFIG_ZLIB 1$',config,re.M) or not re.search(r'^#define HAVE_X86ASM 1$',config,re.M):raise RuntimeError('Source runtime configuration is not the reviewed audio variant')

def require_source_support(runtime,value):
    """Release consumer gate, before any child program; legacy QA stays readable."""
    verify_support(runtime,value)
    if value['schema']!=2:raise RuntimeError('Windows release requires source-built FFmpeg with corresponding sources')
    lock=json.loads(Path(__file__).with_name('ffmpeg-source-windows.lock.json').read_text(encoding='utf-8'))
    verify_source_materials(runtime/'licenses/ffmpeg',lock)
def dll_family(name):
    match=re.fullmatch(r'(avcodec|avdevice|avfilter|avformat|avutil|swresample|swscale)-[1-9][0-9]*\.dll',name)
    return match[1] if match else None

def validate_files(directory,entries,required,*,staged=False):
    try:
        reject_links(directory)
        if not isinstance(entries,list) or len(entries)!=len(required)+len(FAMILIES):raise ValueError()
        names=set();families=set()
        for entry in entries:
            name=entry['path'];size=entry['size'];digest=entry['sha256']
            if not isinstance(name,str) or name in names or type(size) is not int or size<=0 or not isinstance(digest,str) or not re.fullmatch('[a-f0-9]{64}',digest):raise ValueError()
            relative=name.removeprefix('bin/') if staged else name;family=dll_family(relative)
            if name not in required and (not family or staged and name!='bin/'+relative):raise ValueError()
            if family:
                if family in families:raise ValueError()
                families.add(family)
            names.add(name);file=directory/name;reject_links(file)
            if not file.is_file() or file.stat().st_size!=size or sha256(file)!=digest:raise ValueError()
            if family or name in {'ffmpeg.exe','ffprobe.exe'}:require_amd64(file)
        if families!=FAMILIES or not required<=names:raise ValueError()
    except (KeyError,TypeError,ValueError,OSError,CoreError,RuntimeError) as error:
        raise RuntimeError('Shared FFmpeg runtime missing, damaged or invalid') from error

def read_bundle(directory):
    directory=Path(directory).absolute();file=directory/'PROVENANCE.json'
    try:
        reject_links(file)
        if file.stat().st_size>1024*1024:raise ValueError()
        value=json.loads(file.read_text(encoding='utf-8'))
        if not isinstance(value,dict) or type(value.get('schema')) is not int:raise ValueError()
        if value['schema']==1:
            lock=json.loads(Path(__file__).with_name('ffmpeg-windows.lock.json').read_text(encoding='utf-8'));notices=LICENSES
            if value.get('lock')!=lock or value.get('archiveSha256')!=lock['sha256'] or value.get('licenses')!={'ffmpeg':'LGPL-3.0-or-later','ffprobe':'LGPL-3.0-or-later'}:raise ValueError()
        elif value['schema']==2:
            lock=json.loads(Path(__file__).with_name('ffmpeg-source-windows.lock.json').read_text(encoding='utf-8'));notices=SOURCE_NOTICES
            if value.get('lock')!=lock or value.get('sourceChanges') is not False or value.get('licenses')!={'ffmpeg':'LGPL-2.1-or-later','ffprobe':'LGPL-2.1-or-later'}:raise ValueError()
        else:raise ValueError()
        validate_files(directory,value['files'],{'ffmpeg.exe','ffprobe.exe'}|notices)
        if {v.name for v in directory.iterdir()}!={v['path'] for v in value['files']}|{'PROVENANCE.json'}:raise ValueError()
        if value['schema']==2:
            if {v['path'] for v in value['files'] if v['path'].endswith(('.dll','.exe'))}!=set(lock['runtimeFiles']):raise ValueError()
            verify_source_materials(directory,lock)
        return value
    except (KeyError,TypeError,ValueError,OSError,CoreError) as error:
        raise RuntimeError('Reviewed FFmpeg input missing or does not match the lock') from error

def stage_support(directory,runtime,value):
    # Revalidate even when the caller already read the input before copying.
    if read_bundle(directory)!=value:raise RuntimeError('FFmpeg input changed during staging')
    (runtime/'bin').mkdir(exist_ok=True);notices=runtime/'licenses/ffmpeg';notices.mkdir(parents=True)
    files=[]
    for entry in value['files']:
        name=entry['path']
        if dll_family(name):target=runtime/'bin'/name
        elif name in (SOURCE_NOTICES if value['schema']==2 else LICENSES):target=notices/name
        else:continue
        shutil.copy2(directory/name,target)
        if target.stat().st_size!=entry['size'] or sha256(target)!=entry['sha256']:raise RuntimeError('FFmpeg input changed during copying')
        files.append({'path':target.relative_to(runtime).as_posix(),'size':entry['size'],'sha256':entry['sha256']})
    provenance_digest=sha256(directory/'PROVENANCE.json')
    shutil.copy2(directory/'PROVENANCE.json',notices/'PROVENANCE.json')
    target=notices/'PROVENANCE.json'
    if sha256(target)!=provenance_digest or json.loads(target.read_text(encoding='utf-8'))!=value:raise RuntimeError('FFmpeg provenance changed during copying')
    files.append({'path':target.relative_to(runtime).as_posix(),'size':target.stat().st_size,'sha256':provenance_digest})
    result={'schema':value['schema'],'files':files};verify_support(runtime,result);return result

def verify_support(runtime,value):
    if not isinstance(value,dict) or type(value.get('schema')) is not int or value['schema'] not in {1,2}:raise RuntimeError('Shared FFmpeg inventory missing')
    notices=SOURCE_NOTICES if value['schema']==2 else LICENSES
    validate_files(runtime,value.get('files'),{'licenses/ffmpeg/'+name for name in notices|{'PROVENANCE.json'}},staged=True)
