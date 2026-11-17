"""Acquire exactly the reviewed Windows shared LGPL input; never overwrite."""
import argparse,hashlib,json,shutil,stat,urllib.request,zipfile
from pathlib import Path,PurePosixPath
from native_bundle import sha256,require_amd64
from runtime_licenses import inspect_license

LOCK=Path(__file__).with_name('ffmpeg-windows.lock.json')
def acquire(output,archive=None):
    lock=json.loads(LOCK.read_text(encoding='utf-8'));output=output.expanduser().absolute();output.mkdir(parents=True,exist_ok=False)
    url='https://github.com/'+lock['provider']+'/releases/download/'+lock['release']+'/'+lock['asset']
    saved=output/lock['asset']
    if archive:
        if sha256(archive)!=lock['sha256']:raise RuntimeError('FFmpeg input checksum mismatch')
        shutil.copy2(archive,saved)
    else:
        with urllib.request.urlopen(urllib.request.Request(url,headers={'User-Agent':'MONO-build'}),timeout=60) as response,saved.open('xb') as target:
            if not response.geturl().startswith('https://'):raise RuntimeError('HTTPS required')
            shutil.copyfileobj(response,target)
    if sha256(saved)!=lock['sha256']:raise RuntimeError('FFmpeg input checksum mismatch')
    bundle=output/'bundle';bundle.mkdir();top=lock['asset'].removesuffix('.zip')
    with zipfile.ZipFile(saved) as source:
        entries=source.infolist();names=[item.filename for item in entries]
        if len(names)!=len(set(names)) or sum(item.file_size for item in entries)>1500*1024**2:raise RuntimeError('Invalid FFmpeg archive inventory')
        for entry in entries:
            raw=entry.orig_filename;name=PurePosixPath(raw)
            if name.is_absolute() or '..' in name.parts or chr(92) in raw or chr(0) in raw or stat.S_ISLNK(entry.external_attr>>16):raise RuntimeError('Unsafe FFmpeg archive path')
            if len(name.parts)==3 and name.parts[:2]==(top,'bin') and (name.name in {'ffmpeg.exe','ffprobe.exe'} or name.suffix=='.dll'):
                (bundle/name.name).write_bytes(source.read(entry));require_amd64(bundle/name.name)
        (bundle/'COPYING.LGPLv3').write_bytes(source.read(top+'/LICENSE.txt'))
    # LGPLv3 incorporates GPLv3. Retain the exact source-revision text too.
    license_url='https://raw.githubusercontent.com/FFmpeg/FFmpeg/'+lock['ffmpegSourceCommit']+'/COPYING.GPLv3'
    with urllib.request.urlopen(license_url,timeout=30) as source:(bundle/'COPYING.GPLv3').write_bytes(source.read())
    licenses={name:inspect_license(bundle/(name+'.exe'),name) for name in ('ffmpeg','ffprobe')}
    if any(value!='LGPL-3.0-or-later' for value in licenses.values()):raise RuntimeError('Reviewed LGPL variant did not identify itself correctly')
    files=[{'path':file.name,'size':file.stat().st_size,'sha256':sha256(file)} for file in sorted(bundle.iterdir())]
    provenance={'schema':1,'lock':lock,'archiveUrl':url,'archiveSha256':sha256(saved),'licenses':licenses,'files':files,'correspondingSource':'OPEN: exact core revision known; patches/external dependency sources and redistribution bundle still require collection'}
    (bundle/'PROVENANCE.json').write_text(json.dumps(provenance,indent=2),encoding='utf-8')
    return bundle

if __name__=='__main__':
    parser=argparse.ArgumentParser();parser.add_argument('--output',type=Path,required=True);parser.add_argument('--archive',type=Path);args=parser.parse_args()
    print(json.dumps({'bundle':str(acquire(args.output,args.archive)),'scope':'checksum/licensing identity only; complete source obligations remain open'}))
