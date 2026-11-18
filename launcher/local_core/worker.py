"""Private stdin/stdout worker. Never expose this process as a network server."""
import json, sys,threading,queue,time
from collections import OrderedDict
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parent.parent))
from local_core.protocol import CoreError, decode, error_reply, MAX_LINE
from local_core.config import LocalConfig
from local_core.migration import Migration
config=None

POWER={'until':0.0}
def configuration():
    global config
    if config is None:config=LocalConfig()
    return config

def dispatch(method,params):
    if method=='ping':return {'protocol':1}
    if method in ['preferences.get','preferences.update']:
        from local_core.preferences import Preferences
        preferences=Preferences(configuration())
        return preferences.get() if method=='preferences.get' else preferences.update(params)
    if method in ['credentials.status','credentials.store','credentials.delete','credentials.read']:
        from local_core.vault import CredentialVault
        vault=CredentialVault(configuration().directory)
        if method=='credentials.status':return vault.status()
        if method=='credentials.store':return vault.store(params.get('key'),verified_at=params.get('verifiedAt'))
        if method=='credentials.delete':return vault.delete()
        # This RPC is on the private trusted supervisor pipe only. There is no
        # corresponding HTTP read operation, including in credentials routes.
        if method=='credentials.read':return {'key':vault.read()}
    if method=='power.busy':
        # A long transcription keeps the computer awake for a bounded lease (renewed by the server).
        seconds=params.get('seconds',120)
        if type(seconds) not in [int,float] or not 0<=seconds<=600:raise CoreError('INVALID_REQUEST','Некорректный запрос')
        POWER['until']=time.monotonic()+seconds;return {'until':seconds}
    if method=='status':return configuration().status()
    if (method in ['records.create','records.patch','records.transcript.commit','records.transcript.edit','records.trash','records.restore','records.segment','records.import','stage.allocate','library.scrub'] or method.startswith('migration.')) and configuration().transfers.active:
        raise CoreError('LIBRARY_BUSY','Дождитесь завершения копирования архива')
    if method=='transfer.start':return configuration().transfers.start(params)
    if method=='transfer.status':return configuration().transfers.status(params.get('id'))
    if method=='transfer.cancel':return configuration().transfers.cancel(params.get('id'))
    if method=='transfer.resume':return configuration().transfers.resume(params.get('id'))
    if method=='transfer.recover_invalid':return configuration().transfers.recover_invalid()
    if method=='library.configure':return configuration().configure(params)
    if method=='folder.choose':return configuration().choose(params)
    if method=='folder.poll':return configuration().poll_choice(params)
    if method=='folder.cancel':return configuration().cancel_choice(params)
    if method=='stage.allocate':return configuration().allocate_stage()
    if method=='stage.discard':return configuration().discard_stage(params['id'])
    if method.startswith('capture.'):
        service=configuration().capture_service();operation=method.split('.',1)[1]
        if operation=='capabilities':return service.capabilities()
        if operation=='devices':return service.devices()
        if operation=='status':service.tick();return service.status()
        if operation=='check_access':return service.check_access()
        if operation=='diagnose':return service.diagnose()
        if operation=='repair':return service.diagnose(repair=params or {})
        if operation=='test':return service.test(params)
        if operation=='discard_test':return service.discard_test(params['recordId'])
        if operation=='start':return service.start(params)
        if operation=='pause':return service.pause()
        if operation=='resume':return service.resume()
        if operation=='stop':return service.stop()
        if operation=='browser_start':return service.browser_start(params)
        if operation.startswith('browser_'):return service.browser_call(operation.removeprefix('browser_'),params)
    if method.startswith('migration.'):
        service=Migration(configuration().get_library())
        if method=='migration.begin':return service.begin(params)
        if method=='migration.part':return service.part(params['id'],params['index'],configuration().stage_path(params['stagingId']),params['sha256'])
        if method=='migration.transcript':return service.transcript(params['id'],configuration().stage_path(params['stagingId']),params['sha256'])
        if method=='migration.finish':return service.finish(params['id'])
    if method.startswith('records.'):
        if method in ['records.audio','records.sources.file','records.version.get','records.version.commit'] and configuration()._capture is not None and configuration()._capture.active:raise CoreError('CAPTURE_BUSY','Остановите запись перед прослушиванием и подготовкой звука')
        lib=configuration().get_library()
        if method in ['records.sources.file','records.version.get','records.version.commit']:
            from local_core.audio_versions import AudioVersions
            versions=AudioVersions(lib)
            if method=='records.sources.file':return versions.sources_file(params['id'])
            if method=='records.version.get':return versions.get(params['id'],params['versionId'],params['sourceHash'])
            return versions.commit(params['id'],params['metadata'],configuration().stage_path(params['stagingId']),params['sha256'])
        if method=='library.scrub':return lib.scrub(params.get('cursor'),params.get('budgetSeconds',20.0))
        if method=='records.list':return lib.list_records(params.get('cursor'),params.get('limit',100),params.get('query',''),params.get('trash',False))
        if method=='records.create':return lib.create_record(params['meta'])
        if method=='records.get':return lib.metadata(params['id'])
        if method=='records.patch':
            lib.patch_record(params['id'],params['expectedVersion'],params['patch']);return lib.metadata(params['id'])
        if method=='records.transcript':return lib.transcript_page(params['id'],params.get('offset',0),params.get('limit',50),params.get('query',''))
        if method=='records.transcript.file':return lib.transcript_page_file(params['id'],params.get('offset',0),params.get('limit',50),params.get('query',''))
        if method=='records.transcript.commit':return lib.commit_transcript(params['id'],params['expectedVersion'],configuration().stage_path(params['stagingId']))
        if method=='records.transcript.edit':return lib.edit_transcript(params['id'],params['expectedVersion'],configuration().stage_path(params['stagingId']))
        if method=='records.trash':return lib.trash(params['id'],params['expectedVersion'])
        if method=='records.restore':return lib.restore(params['id'],params['expectedVersion'])
        if method=='records.audio':return lib.audio_descriptor(params['id'],params.get('variant','original'))
        if method=='records.segment':return lib.commit_segment(params['id'],params['track'],params['index'],configuration().stage_path(params['stagingId']),params['frames'],params['sha256'])
        if method=='records.import':
            record=lib.create_record({**params['meta'],'status':'importing'})
            lib.commit_segment(record['id'],'original',0,configuration().stage_path(params['stagingId']),0,params['sha256'])
            record=lib.get_record(record['id'])
            return lib.patch_record(record['id'],record['version'],{'duration':params['meta'].get('duration',0),'status':'saved'})
    raise CoreError('UNKNOWN_METHOD','Операция не поддерживается')

def main():
    sys.stdout.reconfigure(encoding='utf-8',line_buffering=True)
    sys.stdin.reconfigure(encoding='utf-8')
    print(json.dumps({'event':'ready','protocol':1}))
    recent=OrderedDict();requests=queue.Queue(maxsize=64);eof=threading.Event()
    def read_requests():
        try:
            while True:
                line=sys.stdin.readline(MAX_LINE+2)
                if not line:break
                if not line.endswith('\n') and len(line)>=MAX_LINE:
                    while line and not line.endswith('\n'):line=sys.stdin.readline(MAX_LINE+2)
                    requests.put(CoreError('TOO_LARGE','Сообщение слишком большое'))
                else:requests.put(line)
        except (OSError,UnicodeError):requests.put(CoreError('INVALID_JSON','Некорректное сообщение'))
        finally:eof.set();requests.put(None)
    threading.Thread(target=read_requests,name='mono-private-control',daemon=True).start()
    from local_core.keep_awake import KeepAwake
    awake=KeepAwake()
    while True:
        if config is not None and config._capture is not None:
            config._capture.tick()
            # Same thread every time: Windows execution-state assertions are per thread.
            awake.set(config._capture.active or time.monotonic()<POWER['until'])
        elif time.monotonic()<POWER['until'] or awake.active:awake.set(time.monotonic()<POWER['until'])
        try:line=requests.get(timeout=.05)
        except queue.Empty:continue
        if line is None:break
        request_id=None
        try:
            if isinstance(line,CoreError):raise line
            request=decode(line);request_id=request['id']
            if request_id in recent:raise CoreError('DUPLICATE_REQUEST','Повторный идентификатор запроса')
            recent[request_id]=True
            if len(recent)>4096:recent.popitem(last=False)
            if eof.is_set() and request['method'] in ['capture.start','capture.test','capture.browser_start']:raise CoreError('CANCELLED','Приложение завершает работу')
            began=time.monotonic()
            try:reply={'v':1,'id':request_id,'result':dispatch(request['method'],request.get('params',{}))}
            finally:
                # This loop is single-threaded: while one long request runs, capture
                # heartbeats and segments wait in the queue. Never count that wait
                # as a lost microphone/helper.
                stalled=time.monotonic()-began
                if stalled>1 and config is not None and config._capture is not None:config._capture.grace(stalled)
        except Exception as error:reply=error_reply(request_id,error)
        encoded=json.dumps(reply,ensure_ascii=False,separators=(',',':'))
        if len(encoded.encode('utf-8'))>MAX_LINE:encoded=json.dumps(error_reply(request_id,CoreError('TOO_LARGE','Результат слишком большой')))
        print(encoded,flush=True)
    awake.set(False)
    if config:config.close()
    return 0

if __name__=='__main__':raise SystemExit(main())
