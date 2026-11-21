"""Pinned October security-release input. Validation/acquisition never runs Node."""
import argparse,hashlib,io,json,stat,urllib.request,zipfile
from pathlib import Path
from core_bundle import amd64,plain

VERSION='v24.22.1'
ARCHIVE_SHA256='d2046d28c2c3dcd211ac5145c0bf30e2047ef9dfb306693c8c6e2eccd8b95fa5'
EXE_SHA256='d702daa815eabbff763c7d3808e235cf031cf2ca70211b56847bc72f51e240e5'
LICENSE_SHA256='ed34dd8e3f0a78dbaf00d0444ce8e285b015b765379c2e17880455f70370f8e9'
ARCHIVE_NAME='node-'+VERSION+'-win-x64.zip'
URL='https://nodejs.org/dist/'+VERSION+'/'+ARCHIVE_NAME
ADVISORY='https://nodejs.org/en/blog/vulnerability/october-2026-security-releases'
MAX_ARCHIVE=200*1024**2

def digest(file):
    with file.open('rb') as stream:return hashlib.file_digest(stream,'sha256').hexdigest()

def verify_files(executable,license_file):
    try:
        executable=Path(executable).absolute();license_file=Path(license_file).absolute()
        for file,expected in [(executable,EXE_SHA256),(license_file,LICENSE_SHA256)]:
            plain(file)
            if not file.is_file() or digest(file)!=expected:raise ValueError('Pinned Node bytes differ')
        amd64(executable)
    except (OSError,ValueError) as error:
        raise RuntimeError('Node security runtime missing, changed or unreviewed') from error
    return {'version':VERSION,'nodeSha256':EXE_SHA256,'licenseSha256':LICENSE_SHA256,'advisory':ADVISORY}

def acquire(output,archive=None):
    output=Path(output).absolute()
    if output.exists() or output.is_symlink():raise FileExistsError('Choose a new Node input directory; existing work is preserved')
    plain(output.parent)
    if archive is None:
        with urllib.request.urlopen(URL,timeout=60) as response:
            if response.status!=200 or not response.url.startswith('https://nodejs.org/'):raise RuntimeError('Unexpected Node download origin')
            raw=response.read(MAX_ARCHIVE+1)
    else:
        archive=Path(archive).absolute();plain(archive)
        if archive.stat().st_size>MAX_ARCHIVE:raise RuntimeError('Node input archive too large')
        raw=archive.read_bytes()
    if not raw or len(raw)>MAX_ARCHIVE or hashlib.sha256(raw).hexdigest()!=ARCHIVE_SHA256:raise RuntimeError('Node archive checksum mismatch')
    try:
        with zipfile.ZipFile(io.BytesIO(raw)) as zipped:
            values={}
            for name,expected,limit in [('node.exe',EXE_SHA256,150*1024**2),('LICENSE',LICENSE_SHA256,4*1024**2)]:
                member='node-'+VERSION+'-win-x64/'+name
                if zipped.namelist().count(member)!=1:raise ValueError('Missing or duplicate Node member')
                entry=zipped.getinfo(member)
                if stat.S_ISLNK(entry.external_attr>>16) or not 0<entry.file_size<=limit:raise ValueError('Invalid Node member')
                value=zipped.read(entry)
                if hashlib.sha256(value).hexdigest()!=expected:raise ValueError('Node member checksum mismatch')
                values[name]=value
    except (ValueError,KeyError,zipfile.BadZipFile) as error:raise RuntimeError('Invalid Node input archive') from error
    output.mkdir(exist_ok=False)
    for name,value in values.items():
        with (output/name).open('xb') as file:file.write(value)
    result=verify_files(output/'node.exe',output/'LICENSE')
    provenance={**result,'source':URL,'archiveSha256':ARCHIVE_SHA256,'executed':False}
    (output/'PROVENANCE.json').write_text(json.dumps(provenance,indent=2),encoding='utf-8')
    return output

def main():
    parser=argparse.ArgumentParser();parser.add_argument('--output',required=True,type=Path);parser.add_argument('--archive',type=Path)
    args=parser.parse_args();print(json.dumps({'nodeInput':str(acquire(args.output,args.archive)),'executed':False}))
if __name__=='__main__':main()
