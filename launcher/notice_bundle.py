"""Exact reviewed license data, shared by the packager and frozen launcher.

Integrity/provenance checks do not replace publisher signing or legal review.
"""
import hashlib,json,re,shutil
from pathlib import Path
from core_bundle import plain

INDEX_SHA256='f4d260f1ab5fa7d63eb5a284e3149c47c15ccd097ab277b4665e5e1e03ee89a5'
LOCATION='runtime/licenses/python-dependencies'

def inspect_input(directory):
    directory=Path(directory).absolute()
    try:
        plain(directory);index=directory/'INDEX.json';plain(index)
        if not 0<index.stat().st_size<2*1024*1024:raise ValueError('Invalid notice index size')
        raw=index.read_bytes()
        if hashlib.sha256(raw).hexdigest()!=INDEX_SHA256:raise ValueError('Reviewed notice index changed')
        value=json.loads(raw)
        if value['schema']!=1 or len(value['components'])!=13 or len(value['files'])!=33:raise ValueError('Incomplete notice corpus')
        components={c['id'] for c in value['components']}
        if len(components)!=13:raise ValueError('Duplicate notice component')
        expected={'INDEX.json'};covered=set()
        for row in value['files']:
            name=row['path']
            if not isinstance(name,str) or not re.fullmatch(r'[a-z0-9_-]+/[0-9]{2}-[A-Z0-9_.-]+',name) or name.split('/')[0]!=row['component'] or row['component'] not in components or name in expected:raise ValueError('Invalid notice path')
            if type(row['size']) is not int or not 0<row['size']<2*1024*1024 or not re.fullmatch('[a-f0-9]{64}',row['sha256']):raise ValueError('Invalid notice entry')
            expected.add(name);covered.add(row['component']);file=directory/name;plain(file)
            if not file.is_file() or file.stat().st_size!=row['size'] or hashlib.sha256(file.read_bytes()).hexdigest()!=row['sha256']:raise ValueError('License notice missing or changed')
        actual=set()
        for file in directory.rglob('*'):
            plain(file)
            if file.is_file():actual.add(file.relative_to(directory).as_posix())
        if covered!=components or actual!=expected:raise ValueError('Notice file set changed')
        return value
    except (OSError,ValueError,KeyError,TypeError) as error:
        raise RuntimeError('Python dependency notices invalid: '+str(error)) from error

def verify_build_environment(index):
    # Deliberately build-only: the frozen validator never queries distributions.
    from core_bundle import compatible_runtime
    if not compatible_runtime():raise RuntimeError('Python notice build requires the pinned normal-GIL Windows x64 runtime')
    from importlib import metadata
    try:
        for component in index['components']:
            if 'distribution' in component and metadata.version(component['distribution'])!=component['version']:
                raise ValueError('Unreviewed dependency version: '+component['distribution'])
        sdk=next(c for c in index['components'] if c['id']=='webview2-sdk')
        distribution=metadata.distribution('pywebview')
        for row in sdk['matchedDlls']:
            file=Path(distribution.locate_file('webview/lib/'+row['path']));plain(file)
            if hashlib.sha256(file.read_bytes()).hexdigest()!=row['sha256']:raise ValueError('WebView2 SDK bytes changed')
    except (OSError,ValueError,KeyError,TypeError,StopIteration,metadata.PackageNotFoundError) as error:
        raise RuntimeError('Python notice build environment invalid: '+str(error)) from error

def verify_staged(root,descriptor):
    if descriptor!={'schema':1,'indexSha256':INDEX_SHA256}:raise RuntimeError('Missing or changed Python dependency notice descriptor')
    inspect_input(Path(root)/LOCATION)

def stage_bundle(source,root):
    target=Path(root)/LOCATION
    if target.exists() or target.is_symlink():raise FileExistsError('Existing notice destination is preserved')
    value=inspect_input(source);verify_build_environment(value);plain(root)
    target.mkdir(parents=True,exist_ok=False)
    for name in ['INDEX.json',*[row['path'] for row in value['files']]]:
        destination=target/name;destination.parent.mkdir(parents=True,exist_ok=True);shutil.copyfile(Path(source)/name,destination)
    descriptor={'schema':1,'indexSha256':INDEX_SHA256};verify_staged(root,descriptor)
    return descriptor
