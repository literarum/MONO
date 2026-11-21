"""Inspect an own Windows onefile build; optionally exercise private synthetic data.

Checksums establish selected build contents, not trust in arbitrary executables.
Use --execute only for an executable produced by your reviewed local build.
No GUI, microphone, system capture or external provider is invoked.
"""
import argparse,hashlib,io,json,os,queue,shutil,subprocess,sys,tempfile,threading,wave
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1];sys.path.insert(0,str(ROOT/'launcher'))
from mono_launcher import verify_runtime_manifest
from core_bundle import BINARY,sha256
from PyInstaller.archive.readers import CArchiveReader


def inspect(executable,stage):
    verify_runtime_manifest(stage)
    archive=CArchiveReader(str(executable));names={}
    for name in archive.toc:
        normalized=name.replace('\\','/')
        if normalized.casefold() in names:raise RuntimeError('Duplicate embedded path')
        names[normalized.casefold()]=name
    checked=[]
    for file in sorted(stage.rglob('*')):
        if not file.is_file():continue
        name=file.relative_to(stage).as_posix();key=names.get(name.casefold())
        if key is None:raise RuntimeError('Missing staged payload: '+name)
        digest=hashlib.sha256(archive.extract(key)).hexdigest()
        if digest!=sha256(file):raise RuntimeError('Embedded payload mismatch: '+name)
        checked.append({'path':name,'sha256':digest})
    pyz=archive.open_embedded_archive(names['pyz.pyz']);modules=list(pyz.toc)
    if any(name=='local_core' or name.startswith('local_core.') for name in modules):raise RuntimeError('Business core Python bytecode was included')
    if any(name.startswith(('local_core/','launcher/local_core/')) and name.endswith(('.py','.pyc','.pyo')) for name in names):raise RuntimeError('Business core Python source was included')
    return {'embeddedStagedFiles':checked,'pyzModulesInspected':len(modules),'noLocalCorePythonSourceOrBytecode':True,'manifestSha256':sha256(stage/'runtime/manifest.json'),'coreSha256':sha256(stage/BINARY)}


class Worker:
    def __init__(self,executable,environment,extractions):
        self.child=subprocess.Popen([str(executable),'--core-worker'],cwd=executable.parent,env=environment,stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,encoding='utf-8',creationflags=subprocess.CREATE_NO_WINDOW)
        self.lines=queue.Queue();self.index=0;self.extractions=extractions
        def read():
            try:
                for line in self.child.stdout:self.lines.put(json.loads(line))
            except (ValueError,OSError) as error:self.lines.put(error)
        self.reader=threading.Thread(target=read,daemon=True);self.reader.start()
        try:
            if self.lines.get(timeout=20)!={'event':'ready','protocol':1}:raise RuntimeError('Frozen worker handshake mismatch')
            roots=list(extractions.iterdir())
            if len(roots)!=1 or not roots[0].name.startswith('_MEI') or not (roots[0]/'runtime/manifest.json').is_file():raise RuntimeError('Onefile did not use its private extraction directory')
            self.assets=roots[0]
        except BaseException:self.abort();raise
    def ask(self,method,params=None):
        self.index+=1;rid=str(self.index);self.child.stdin.write(json.dumps({'v':1,'id':rid,'method':method,'params':params or {}})+'\n');self.child.stdin.flush()
        response=self.lines.get(timeout=20)
        if not isinstance(response,dict) or response.get('id')!=rid or 'result' not in response:raise RuntimeError('Frozen worker request failed: '+method)
        return response['result']
    def abort(self):
        if self.child.poll() is None:self.child.kill();self.child.wait(timeout=10)
        for stream in [self.child.stdin,self.child.stdout,self.child.stderr]:stream.close()
    def close(self):
        self.child.stdin.close()
        try:code=self.child.wait(timeout=12)
        except subprocess.TimeoutExpired:self.abort();raise
        self.reader.join(timeout=2);self.child.stdout.close();errors=self.child.stderr.read();self.child.stderr.close()
        if code!=0:raise RuntimeError('Frozen worker shutdown failed: '+errors[-1200:])
        if self.assets.exists() or list(self.extractions.iterdir()):raise RuntimeError('Onefile extraction was not removed on exit')


def execute(executable,manifest_sha):
    with tempfile.TemporaryDirectory(prefix='mono-onefile-consumer-') as folder:
        private=Path(folder);extract=private/'extract';extract.mkdir()
        transported=private/'transport';transported.mkdir();source=executable;executable=transported/source.name;shutil.copy2(source,executable)
        if sha256(executable)!=sha256(source):raise RuntimeError('Single-file transport changed executable bytes')
        environment={**os.environ,'PATH':str(Path(os.environ['SYSTEMROOT'])/'System32'),'MONO_HOME':str(private/'home'),'MONO_CONFIG_DIR':str(private/'home/config'),'MONO_DEFAULT_LIBRARY_ROOT':str(private/'library'),'TEMP':str(extract),'TMP':str(extract),'DOTNET_BUNDLE_EXTRACT_BASE_DIR':str(private/'dotnet'),'DOTNET_ROOT':str(private/'no-system-dotnet'),'DOTNET_MULTILEVEL_LOOKUP':'0'}
        for name in ['GROQ_API_KEY','GROQ_API_KEY_FILE','MONO_GROQ_ENDPOINT']:environment.pop(name,None)
        verified=subprocess.run([str(executable),'--verify-bundle'],cwd=transported,env=environment,capture_output=True,text=True,encoding='utf-8',timeout=45,check=True,creationflags=subprocess.CREATE_NO_WINDOW)
        if json.loads(verified.stdout).get('ok') is not True or list(extract.iterdir()):raise RuntimeError('Onefile verifier or extraction cleanup failed')
        worker=Worker(executable,environment,extract)
        try:
            if sha256(worker.assets/'runtime/manifest.json')!=manifest_sha:raise RuntimeError('Extracted manifest mismatch')
            if worker.ask('ping')['protocol']!=1:raise RuntimeError('Onefile protocol unavailable')
            configured=worker.ask('library.configure',{'useDefault':True})
            if not configured['libraryAvailable'] or Path(configured['libraryPath']).resolve()!=(private/'library').resolve():raise RuntimeError('Onefile private library unavailable')
            if worker.ask('credentials.status')['configured']:raise RuntimeError('Private fixture unexpectedly has a credential')
            capabilities=worker.ask('capture.capabilities')
            if not capabilities.get('ready'):
                import time
                deadline=time.monotonic()+15
                while not capabilities.get('ready'):
                    if time.monotonic()>=deadline:raise RuntimeError('Native helper readiness timeout')
                    time.sleep(.05);capabilities=worker.ask('capture.capabilities')
            if not capabilities['supported'] or not {'mic','system','both'}<=set(capabilities['modes'])<={'mic','system','both','app'}:raise RuntimeError('Native helper capabilities mismatch')
            devices=worker.ask('capture.devices')
            if not devices['inputDevices'] or not devices['outputDevices']:raise RuntimeError('Native helper did not enumerate endpoints')
            with io.BytesIO() as output:
                with wave.open(output,'wb') as writer:writer.setparams((1,2,16000,0,'NONE','not compressed'));writer.writeframes(b'\0\0'*16000)
                original=output.getvalue()
            stage=worker.ask('stage.allocate');staged=Path(stage['path'])
            if not staged.resolve().is_relative_to(private.resolve()):raise RuntimeError('Onefile staging escaped private fixture')
            staged.write_bytes(original)
            record=worker.ask('records.import',{'meta':{'title':'Onefile synthetic fixture','mime':'audio/wav','duration':1},'stagingId':stage['id'],'sha256':hashlib.sha256(original).hexdigest()});worker.ask('stage.discard',{'id':stage['id']})
            record=worker.ask('records.patch',{'id':record['id'],'expectedVersion':record['version'],'patch':{'transcript':{'segments':[{'start':0,'end':1,'text':'Onefile edited','original':'Onefile original'}]}}})
        finally:worker.close()
        worker=Worker(executable,environment,extract)
        try:
            transcript=worker.ask('records.transcript',{'id':record['id'],'offset':0,'limit':1})['segments'][0]
            if transcript['text']!='Onefile edited' or transcript['original']!='Onefile original':raise RuntimeError('Onefile transcript did not survive restart')
            audio=Path(worker.ask('records.audio',{'id':record['id']})['files'][0]['path'])
            if not audio.resolve().is_relative_to((private/'library').resolve()) or audio.read_bytes()!=original:raise RuntimeError('Onefile original audio did not survive restart')
        finally:worker.close()
        if {p.name for p in transported.iterdir()}!={executable.name}:raise RuntimeError('Onefile unexpectedly needs or leaves adjacent runtime files')
        result={'frozenIntegrityCLI':True,'singleExeTransportWithoutSidecars':True,'frozenAudioAndBothTextsSurviveRestart':True,'nativeHelperHandshake':True,'inputCount':len(devices['inputDevices']),'outputCount':len(devices['outputDevices']),'extractionRemovedAfterEachWorker':True,'audioStarted':False,'providerRequests':0}
    return {**result,'privateWorkspaceRemoved':not private.exists()}


def main():
    parser=argparse.ArgumentParser();parser.add_argument('executable',type=Path);parser.add_argument('--stage',required=True,type=Path);parser.add_argument('--execute',action='store_true');parser.add_argument('--report',type=Path);args=parser.parse_args()
    if args.report and args.report.exists():raise FileExistsError('Preserve previous verification reports')
    executable=args.executable.resolve();stage=args.stage.resolve()
    if os.name!='nt' or not executable.is_file():raise RuntimeError('Own Windows onefile EXE required')
    result={'status':'PASS','scope':'onefile component integrity; not normal GUI, physical capture or release clearance','executableSha256':sha256(executable),**inspect(executable,stage)}
    if args.execute:result.update(execute(executable,result['manifestSha256']))
    if args.report:
        with args.report.open('x',encoding='utf-8') as output:json.dump(result,output,indent=2)
    print(json.dumps({k:v for k,v in result.items() if k!='embeddedStagedFiles'}))

if __name__=='__main__':main()
