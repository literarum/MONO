"""Actual source-free native-core protocol consumer and unchanged core test slice."""
import argparse,contextlib,hashlib,importlib,io,json,os,queue,shutil,subprocess,sys,tempfile,threading,unittest,uuid,wave
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1];sys.path.insert(0,str(ROOT/'launcher'))
from core_bundle import BINARY,read_build_bundle,sha256

class Worker:
    def __init__(self,consumer,environment):
        bootstrap='import sys;sys.path.insert(0,'+repr(str(consumer))+');from local_core.worker import main;raise SystemExit(main())'
        self.child=subprocess.Popen([sys.executable,'-I','-X','utf8','-u','-c',bootstrap],cwd=consumer,env=environment,stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,encoding='utf-8')
        self.lines=queue.Queue();self.index=0
        def read():
            try:
                for line in self.child.stdout:self.lines.put(json.loads(line))
            except (ValueError,OSError) as error:self.lines.put(error)
        self.reader=threading.Thread(target=read,daemon=True);self.reader.start()
        try:assert self.lines.get(timeout=20)=={'event':'ready','protocol':1}
        except BaseException:
            self.abort();raise
    def ask(self,method,params=None,error=None):
        self.index+=1;rid=str(self.index);self.child.stdin.write(json.dumps({'v':1,'id':rid,'method':method,'params':params or {}})+'\n');self.child.stdin.flush()
        response=self.lines.get(timeout=20);assert isinstance(response,dict) and response['id']==rid,response
        if error:assert response['error']['code']==error,response
        else:assert 'result' in response,response
        return response if error else response['result']
    def abort(self):
        if self.child.poll() is None:self.child.kill();self.child.wait(timeout=5)
        for stream in [self.child.stdin,self.child.stdout,self.child.stderr]:stream.close()
    def close(self):
        self.child.stdin.close()
        try:code=self.child.wait(timeout=12)
        except subprocess.TimeoutExpired:self.abort();raise
        self.reader.join(timeout=2);self.child.stdout.close();errors=self.child.stderr.read();self.child.stderr.close();assert code==0,errors[-1500:]

def verify(bundle,run_tests=False,private_workspace=None):
    bundle=Path(bundle).resolve();value=read_build_bundle(bundle,ROOT/'launcher/local_core')
    names=sorted(Path(row['path']).stem for row in value['sourceFiles'] if row['path'].endswith('.py') and row['path']!='__init__.py')
    if private_workspace is None:
        # Windows keeps a loaded PYD mapped until process exit. The controller
        # must own cleanup while a separate process owns native imports/tests.
        with tempfile.TemporaryDirectory(prefix='mono-native-core-consumer-') as folder:
            command=[sys.executable,'-X','utf8',str(Path(__file__).resolve()),'--bundle',str(bundle),'--internal-workspace',folder]
            if run_tests:command.append('--run-tests')
            child=subprocess.run(command,capture_output=True,text=True,encoding='utf-8',timeout=180 if run_tests else 60)
            if child.stderr:sys.stderr.write(child.stderr)
            if child.returncode!=0:raise RuntimeError('Native consumer failed: '+child.stdout[-1000:])
            result=json.loads(child.stdout);assert result['status']=='PASS'
        return {**result,'consumerWorkspaceRemoved':not Path(folder).exists()}
    with contextlib.nullcontext(str(private_workspace)) as folder:
        private=Path(folder);consumer=private/'consumer';consumer.mkdir();shutil.copy2(bundle/BINARY,consumer/BINARY)
        (consumer/'local_core').mkdir();shutil.copy2(ROOT/'launcher/local_core/schema.sql',consumer/'local_core/schema.sql')
        sys.path.insert(0,str(consumer))
        for name in list(sys.modules):
            if name=='local_core' or name.startswith('local_core.'):raise RuntimeError('Core verifier must run in a fresh Python process')
        origin=importlib.machinery.PathFinder.find_spec('local_core',sys.path).origin
        assert Path(origin).resolve()==(consumer/BINARY).resolve()
        package=importlib.import_module('local_core');assert hasattr(package,'__compiled__') and not package.__compiled__.no_asserts
        modules={name:importlib.import_module('local_core.'+name) for name in names}
        assert all(hasattr(m,'__compiled__') and Path(m.__file__).resolve().is_relative_to(consumer.resolve()) for m in modules.values())
        environment={**os.environ,'MONO_CONFIG_DIR':str(private/'config'),'MONO_DEFAULT_LIBRARY_ROOT':str(private/'library'),'PYTHONUTF8':'1'}
        worker=Worker(consumer,environment)
        try:
            assert worker.ask('ping')['protocol']==1 and worker.ask('library.configure',{'useDefault':True})['libraryAvailable']
            assert not worker.ask('credentials.status')['configured']
            worker.ask('not.a.real.method',error='UNKNOWN_METHOD');worker.ask('records.get',{'id':'../../outside'},error='INVALID_ID')
            worker.child.stdin.write('{broken\n');worker.child.stdin.flush();assert worker.lines.get(timeout=20)['error']['code']=='INVALID_JSON'
            with io.BytesIO() as output:
                with wave.open(output,'wb') as writer:writer.setparams((1,2,16000,0,'NONE','not compressed'));writer.writeframes(b'\0\0'*16000)
                original=output.getvalue()
            stage=worker.ask('stage.allocate');Path(stage['path']).write_bytes(original)
            record=worker.ask('records.import',{'meta':{'title':'Native compiler synthetic QA','mime':'audio/wav','duration':1},'stagingId':stage['id'],'sha256':hashlib.sha256(original).hexdigest()});worker.ask('stage.discard',{'id':stage['id']})
            record=worker.ask('records.patch',{'id':record['id'],'expectedVersion':record['version'],'patch':{'transcript':{'segments':[{'start':0,'end':1,'text':'Native edited','original':'Native original'}]}}})
        finally:worker.close()
        worker=Worker(consumer,environment)
        try:
            transcript=worker.ask('records.transcript',{'id':record['id'],'offset':0,'limit':1})['segments'][0]
            assert transcript['text']=='Native edited' and transcript['original']=='Native original'
            audio=Path(worker.ask('records.audio',{'id':record['id']})['files'][0]['path']);assert audio.resolve().is_relative_to((private/'library').resolve()) and audio.read_bytes()==original
        finally:worker.close()
        result={'status':'PASS','scope':'source-free native core; not frozen GUI or physical audio','binarySha256':sha256(bundle/BINARY),'compiledSubmodules':len(names),'syntheticAudioAndBothTextsSurviveRestart':True,'invalidJsonMethodAndTraversalRejected':True,'credentialsUsed':False,'audioStarted':False}
        if run_tests:
            selected=['test_library','test_library_boundaries','test_library_recovery','test_library_transfer','test_transfer_recovery','test_audio_versions','test_record_schema','test_preferences','test_vault','test_publication','test_folder_choices','test_capture_recovery','test_capture_state']
            sys.path.insert(0,str(ROOT/'launcher/tests'));suite=unittest.TestSuite(unittest.defaultTestLoader.loadTestsFromName(name) for name in selected)
            tests=unittest.TextTestRunner(verbosity=2).run(suite)
            assert tests.wasSuccessful() and not tests.skipped
            assert all(sys.modules['local_core.'+name] is m and hasattr(m,'__compiled__') for name,m in modules.items())
            result['unchangedCoreTests']=tests.testsRun;result['skips']=len(tests.skipped)
        assert {p.relative_to(consumer).as_posix() for p in consumer.rglob('*') if p.is_file()}=={BINARY,'local_core/schema.sql'}
        return result

def main():
    parser=argparse.ArgumentParser();parser.add_argument('--bundle',required=True,type=Path);parser.add_argument('--run-tests',action='store_true');parser.add_argument('--report',type=Path);parser.add_argument('--internal-workspace',type=Path,help=argparse.SUPPRESS);args=parser.parse_args()
    if args.report and args.report.exists():raise FileExistsError('Preserve previous verification reports')
    result=verify(args.bundle,args.run_tests,args.internal_workspace)
    if args.report:
        with args.report.open('x',encoding='utf-8') as file:json.dump(result,file,indent=2)
    print(json.dumps(result))
if __name__=='__main__':main()
