#!/usr/bin/env python3
"""Read-only Windows/stage integrity checks; optional own-build CLI probes.

Checksums detect mismatches, not publisher identity. --execute is for a locally
built trusted executable; it never launches the application UI/server or audio.
"""
import argparse,json,os,subprocess,sys,tempfile
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'launcher'))
from mono_launcher import verify_runtime_manifest
from native_bundle import sha256

def exercise_core(executable):
    """Real frozen stdio/SQLite/transcript restart, only private synthetic data."""
    with tempfile.TemporaryDirectory(prefix='mono-frozen-core-') as folder:
        private=Path(folder);environment={**os.environ,'PATH':str(Path(os.environ['SYSTEMROOT'])/'System32'),'MONO_CONFIG_DIR':str(private/'config'),'MONO_DEFAULT_LIBRARY_ROOT':str(private/'library')}
        def exchange(requests):
            payload=''.join(json.dumps({'v':1,'id':str(i),'method':method,'params':params})+'\n' for i,(method,params) in enumerate(requests))
            child=subprocess.run([str(executable),'--core-worker'],input=payload,capture_output=True,text=True,encoding='utf-8',env=environment,timeout=30,check=True,creationflags=subprocess.CREATE_NO_WINDOW)
            replies=[json.loads(line) for line in child.stdout.splitlines()]
            if not replies or replies[0]!={'event':'ready','protocol':1} or len(replies)!=len(requests)+1:raise RuntimeError('Frozen private worker handshake mismatch')
            results=[]
            for index,response in enumerate(replies[1:]):
                if response.get('id')!=str(index) or 'result' not in response:raise RuntimeError('Frozen private worker request failed')
                results.append(response['result'])
            return results
        first=exchange([('ping',{}),('library.configure',{'useDefault':True}),('records.create',{'meta':{'title':'Frozen synthetic verification','mime':'audio/wav','duration':1}})])
        if first[0].get('protocol')!=1 or not first[1].get('libraryAvailable'):raise RuntimeError('Frozen archive unavailable')
        record=first[2]
        exchange([('records.patch',{'id':record['id'],'expectedVersion':record['version'],'patch':{'transcript':{'segments':[{'start':0,'end':1,'text':'Synthetic edited text','original':'Synthetic original text'}]}}})])
        restored=exchange([('records.transcript',{'id':record['id'],'offset':0,'limit':1})])[0]
        if restored['segments'][0]['text']!='Synthetic edited text' or restored['segments'][0]['original']!='Synthetic original text':raise RuntimeError('Frozen transcript restart mismatch')
    return {'frozenCoreRestart':True,'syntheticTranscriptPreserved':True,'privateWorkspaceRemoved':not private.exists()}

def main():
    parser=argparse.ArgumentParser();parser.add_argument('package',type=Path);parser.add_argument('--execute',action='store_true');parser.add_argument('--exercise-core',action='store_true',help='With --execute, exercise a private synthetic archive across worker restart')
    parser.add_argument('--require-node-baseline',action='store_true',help='Windows release gate: require exact reviewed security runtime bytes before execution')
    parser.add_argument('--require-source-ffmpeg',action='store_true',help='Windows release gate: require source-built audio runtime and pinned corresponding sources before execution');args=parser.parse_args()
    if args.exercise_core and not args.execute:parser.error('--exercise-core requires --execute for an own trusted build')
    package=args.package.resolve();assets=package/'_internal' if (package/'_internal').is_dir() else package
    verify_runtime_manifest(assets)
    result={'status':'PASS','scope':'component integrity; not physical capture or full release acceptance','manifestSha256':sha256(assets/'runtime/manifest.json')}
    if args.require_node_baseline:
        from node_windows import verify_files
        result['nodeSecurityBaseline']=verify_files(assets/'runtime/bin/node.exe',assets/'NODE_LICENSE.txt')
    if args.require_source_ffmpeg:
        from ffmpeg_bundle import require_source_support
        manifest=json.loads((assets/'runtime/manifest.json').read_text(encoding='utf-8'))
        require_source_support(assets/'runtime',manifest.get('ffmpegSupport'))
        result['sourceBuiltFFmpegBaseline']=True
    if args.execute:
        executable=package/'MONO Transcribe.exe'
        if os.name!='nt' or not executable.is_file():raise RuntimeError('Own Windows EXE required for --execute')
        environment={**os.environ,'PATH':str(Path(os.environ['SYSTEMROOT'])/'System32'),'DOTNET_MULTILEVEL_LOOKUP':'0'}
        verified=subprocess.run([str(executable),'--verify-bundle'],capture_output=True,text=True,encoding='utf-8',timeout=45,check=True,env=environment,creationflags=subprocess.CREATE_NO_WINDOW)
        health=json.loads(verified.stdout)
        if health.get('ok') is not True or health.get('folderPickerImports') is not True:raise RuntimeError('Frozen verifier did not confirm integrity and native folder-dialog dependencies')
        from runtime_licenses import inspect_license
        ffmpeg_licenses={name:inspect_license(assets/'runtime/bin'/(name+'.exe'),name) for name in ('ffmpeg','ffprobe')}
        with tempfile.TemporaryDirectory(prefix='mono-package-enumeration-') as scratch:
            environment['DOTNET_ROOT']=str(Path(scratch)/'no-system-dotnet')
            helper=subprocess.run([str(assets/'runtime/native/MonoAudio.exe'),'--protocol','1','--capture-root',scratch],input='',capture_output=True,text=True,encoding='utf-8',timeout=20,check=True,env=environment,creationflags=subprocess.CREATE_NO_WINDOW)
            ready=json.loads(helper.stdout.splitlines()[0])
            if ready.get('event')!='ready' or ready.get('protocol')!=1:raise RuntimeError('Native helper protocol mismatch')
        result.update({'frozenIntegrityCLI':True,'ffmpegRuntimeProbe':True,'ffmpegLicenses':ffmpeg_licenses,'nativeEnumeration':True,'inputCount':len(ready['inputDevices']),'outputCount':len(ready['outputDevices']),'audioStarted':False,'executableSha256':sha256(executable)})
        if args.exercise_core:result.update(exercise_core(executable))
    print(json.dumps(result))

if __name__=='__main__':main()
