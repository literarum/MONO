"""Native capture owner. Only tick() mutates the archive on the worker thread."""
import hashlib,json,math,os,queue,re,struct,subprocess,sys,threading,time,uuid,sqlite3
from pathlib import Path
from local_core.paths import atomic_json,confined,identifier,publish,reject_links
from local_core.protocol import CoreError,MAX_LINE

ACTIVE={'requesting','recording','paused','stopping'}
ERRORS={'ACCESS_DENIED','DEVICE_LOST','DEVICE_BUSY','UNSUPPORTED_FORMAT','NOT_SUPPORTED','IO_ERROR','DISCONTINUITY','SLEEP','INTERNAL','START_TIMEOUT','STOP_PENDING'}
FAILURE_STAGES={'coordinator'}|{f'capture-{track}/{operation}' for track in ['mic','system'] for operation in ['resolve-device','activate','mix-format','initialize','event-handle','stream-latency','buffer-size','capture-service','start','next-packet','packet-buffer']}

def failure_details(event):
    stage=event.get('stage');native=event.get('nativeCode')
    if not isinstance(stage,str) or stage not in FAILURE_STAGES:return None
    if native is not None and (not isinstance(native,str) or re.fullmatch('[0-9A-F]{8}',native) is None):return None
    return {'stage':stage,'nativeCode':native}
def fail(code):raise CoreError(code,code)
def integer(value,minimum=0):return type(value) is int and minimum<=value<2**63

def wave_descriptor(file):
    size=file.stat().st_size
    if not 44<=size<=32*1024**2:fail('INVALID_AUDIO')
    fmt=None;data=None
    with file.open('rb') as stream:
        header=stream.read(12)
        if header[:4]!=b'RIFF' or header[8:12]!=b'WAVE' or struct.unpack_from('<I',header,4)[0]+8!=size:fail('INVALID_AUDIO')
        while stream.tell()+8<=size:
            kind,length=struct.unpack('<4sI',stream.read(8));start=stream.tell()
            if start+length>size:fail('INVALID_AUDIO')
            if kind==b'fmt ':
                if fmt is not None or not 16<=length<=4096:fail('INVALID_AUDIO')
                fmt=stream.read(length)
            elif kind==b'data':
                if data is not None:data=None;fail('INVALID_AUDIO')
                data=length
            stream.seek(start+length+(length%2))
    if fmt is None or data is None:fail('INVALID_AUDIO')
    tag,channels,rate,average,alignment,bits=struct.unpack_from('<HHIIHH',fmt)
    if tag==65534:
        if len(fmt)<40 or struct.unpack_from('<H',fmt,16)[0]<22:fail('INVALID_AUDIO')
        if fmt[28:40]!=bytes.fromhex('00001000800000aa00389b71'):fail('INVALID_AUDIO')
        tag=struct.unpack_from('<I',fmt,24)[0]
    if tag not in [1,3] or not 1<=channels<=64 or not 8000<=rate<=384000 or bits not in [8,16,24,32,64] or alignment!=channels*(bits//8) or average!=rate*alignment or data%alignment:fail('INVALID_AUDIO')
    if tag==3 and bits not in [32,64] or tag==1 and bits==64:fail('INVALID_AUDIO')
    encoding=f'pcm_f{bits}le' if tag==3 else 'pcm_u8' if bits==8 else f'pcm_s{bits}le'
    return {'sampleRate':rate,'channels':channels,'bitsPerSample':bits,'formatTag':tag,'format':encoding,'frames':data//alignment}

class CaptureService:
    def __init__(self,config,helper_command=None):
        self.config=config;self.command=helper_command;self.child=None;self.reader=None;self.events=queue.Queue(maxsize=256);self.generation=0
        self.state='idle';self.error=None;self.ready=False;self.capability={'supported':False,'modes':[],'inputDevices':[],'outputDevices':[]}
        self.record_id=None;self.session_id=None;self.mode=None;self.library=None;self.root=None;self.origin=None;self.end_ns=None;self.pause_ns=None;self.pending=None;self.levels={};self.last_seq=-1;self.last_seen=0;self.closing=False;self.queue_fault=False
        self.test_deadline=None;self.resume_requested=False;self.access={'microphone':'unknown','system':'unknown'}
        self.level_seen={}
        self.browser=None;self.selected_engine='native';self.saved_bytes=0;self.failure_details=None
    @property
    def active(self):return self.state in ACTIVE or bool(self.browser and self.browser.active)
    def grace(self,seconds):
        """Extend liveness deadlines by time the worker spent unable to read capture traffic."""
        if self.browser and self.browser.active:self.browser.grace(seconds)
        if self.state in ACTIVE:
            self.last_seen+=seconds
            if hasattr(self,'deadline'):self.deadline+=seconds
    def browser_start(self,params):
        if self.active:fail('CAPTURE_BUSY')
        self.close()
        from local_core.browser_capture import BrowserSession
        self.browser=BrowserSession(self.config);result=self.browser.start(params);self.selected_engine='browser';return result
    def browser_call(self,operation,params):
        if self.selected_engine!='browser' or self.browser is None:fail('INVALID_CAPTURE_SESSION')
        if operation not in ['segment','heartbeat','pause','resume','finish','abort']:fail('INVALID_CAPTURE')
        return getattr(self.browser,operation)(params)
    def _command(self):
        if self.command:return list(self.command)
        executable=os.environ.get('MONO_AUDIO_HELPER')
        if executable:candidates=[Path(executable)]
        else:
            # Development checkouts: the documented build output, then a local
            # `dotnet build`. Packaged builds always pass MONO_AUDIO_HELPER.
            base=Path(__file__).resolve().parents[2];name='MonoAudio.exe' if os.name=='nt' else 'MonoAudio'
            candidates=[base/'.build/capture-windows/bundle'/name,base/'native/windows/bin/Release/net10.0-windows/win-x64'/name,base/'native/windows/bin/Release/net10.0-windows'/name] if os.name=='nt' else [base/'.build/capture-macos/bundle'/name]
        for path in candidates:
            try:reject_links(path)
            except CoreError:continue
            if path.is_file():return [str(path)]
        return None
    def _launch(self):
        command=self._command()
        if not command:return False
        library=self.config.get_library()
        if self.child is not None and self.child.poll() is None and self.library is library:return True
        if self.child is not None:self.close()
        self.library=library;self.closing=False;self.generation+=1;generation=self.generation;self.events=queue.Queue(maxsize=256);events=self.events
        self.root=confined(library.root,'.staging','capture-'+str(uuid.uuid4()));self.root.mkdir(mode=0o700)
        self.state='idle';self.error=None;self.failure_details=None;self.capability={'supported':None,'modes':[],'inputDevices':[],'outputDevices':[]}
        self.record_id=None;self.session_id=None;self.mode=None;self.origin=None;self.end_ns=None;self.pause_ns=None;self.pending=None;self.levels={};self.level_seen={};self.test_deadline=None;self.resume_requested=False;self.saved_bytes=0
        self.child=subprocess.Popen([*command,'--protocol','1','--capture-root',str(self.root)],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,creationflags=subprocess.CREATE_NO_WINDOW if os.name=='nt' else 0)
        child=self.child;self.ready=False;self.last_seq=-1;self.last_seen=time.monotonic();self.queue_fault=False
        def read():
            try:
                while True:
                    line=child.stdout.readline(MAX_LINE+2)
                    if not line:break
                    if len(line)>MAX_LINE or not line.endswith(b'\n'):raise ValueError()
                    value=json.loads(line.decode('utf-8'))
                    if not isinstance(value,dict):raise ValueError()
                    try:events.put_nowait((generation,'event',value))
                    except queue.Full:
                        if value.get('event')!='level':self.queue_fault=True;return
            except (OSError,ValueError,UnicodeError):
                try:events.put_nowait((generation,'fault',{}))
                except queue.Full:self.queue_fault=True
            finally:
                try:events.put_nowait((generation,'eof',{}))
                except queue.Full:self.queue_fault=True
        self.reader=threading.Thread(target=read,name='mono-audio-metadata',daemon=True);self.reader.start();return True
    def _send(self,method,params=None):
        if self.child is None or self.child.poll() is not None:fail('CAPTURE_HELPER_UNAVAILABLE')
        data=json.dumps({'v':1,'id':str(uuid.uuid4()),'method':method,'params':params or {'sessionId':self.session_id}},separators=(',',':')).encode('utf-8')+b'\n'
        if len(data)>MAX_LINE:fail('INVALID_CAPTURE')
        try:self.child.stdin.write(data);self.child.stdin.flush()
        except (OSError,ValueError):fail('CAPTURE_HELPER_UNAVAILABLE')
    def capabilities(self):
        if self.browser and self.browser.active:return {**self.capability,'ready':False,'state':self.browser.state,'browserActive':True}
        if not self._launch():return {'supported':False,'ready':False,'modes':[],'reason':'HELPER_UNAVAILABLE'}
        self.tick();return {**self.capability,'ready':self.ready,'state':self.state,**({'reason':self.error} if self.error else {})}
    def devices(self):
        capability=self.capabilities()
        if self.ready:self._send('enumerate',{})
        return {'inputDevices':capability.get('inputDevices',[]),'outputDevices':capability.get('outputDevices',[]),'ready':self.ready}
    def check_access(self):return {**self.access,'snapshot':True,'requestOnStart':True}
    def test(self,params):
        result=self.start(params);self.test_deadline=time.monotonic()+5
        raw=self.library._raw(self.record_id);raw['title']='Проверка звука';raw['_capture']['temporary']=True;raw['version']+=1;self.library._commit(raw)
        return result
    def discard_test(self,record_id):
        if self.active and record_id==self.status()['recordId']:fail('CAPTURE_BUSY')
        raw=self.config.get_library()._raw(record_id)
        if not raw.get('_capture',{}).get('temporary'):fail('INVALID_TEST_RECORD')
        if not raw.get('_trashed'):self.config.get_library().trash(record_id,raw['version'])
        return {'discarded':True}
    def start(self,params):
        if self.active:fail('CAPTURE_BUSY')
        self.selected_engine='native'
        # Staged uploads/renders use unique files and never conflict with a
        # new capture; only an archive copy/move must block recording.
        if self.config.transfers.active:fail('LIBRARY_BUSY')
        if not self._launch():fail('CAPTURE_NOT_READY')
        # After any failure the helper is restarted (an error must never leave a hot input
        # open); the next start waits for its 'ready' instead of failing immediately.
        until=time.monotonic()+8
        while not self.ready and self.error!='NOT_SUPPORTED' and self.child is not None and self.child.poll() is None and time.monotonic()<until:
            self.tick();time.sleep(.02)
        if not self.ready:fail('CAPTURE_NOT_READY')
        mode=params.get('mode')
        if mode not in self.capability.get('modes',[]):fail('INVALID_CAPTURE_MODE')
        for field,devices in [('inputId','inputDevices'),('outputId','outputDevices')]:
            value=params.get(field)
            if value is not None and (not isinstance(value,str) or value not in {device['id'] for device in self.capability.get(devices,[])}):fail('DEVICE_LOST')
        self.session_id=str(uuid.uuid4());self.mode=mode;self.origin=None;self.end_ns=None;self.pause_ns=None;self.pending=None;self.levels={};self.error=None;self.saved_bytes=0
        self.level_seen={};self.failure_details=None
        self.test_deadline=None;self.resume_requested=False
        source={'mic':'Микрофон','system':'Звук компьютера','both':'Микрофон и компьютер'}[mode]
        record=self.library.create_record({'title':'Запись '+time.strftime('%d.%m.%Y %H:%M'),'mime':'audio/wav','source':source,'status':'requesting'})
        self.record_id=record['id'];raw=self.library._raw(self.record_id)
        raw['_capture']={'sessionId':self.session_id,'mode':mode,'inputId':params.get('inputId'),'outputId':params.get('outputId'),'sessionDirectory':self.root.relative_to(self.library.root).as_posix()};raw['version']+=1;self.library._commit(raw)
        self.state='requesting';self.last_seen=time.monotonic();self.deadline=time.monotonic()+15
        try:self._send('start',{'sessionId':self.session_id,'mode':mode,'inputId':params.get('inputId'),'outputId':params.get('outputId')})
        except CoreError:self._interrupt('CAPTURE_HELPER_UNAVAILABLE');raise
        return self.status()
    def diagnose(self,repair=None):
        """Windows view of every microphone: present, disabled, muted, input level.
        repair={'inputId','mute','minimumVolume'} changes one endpoint first (on user intent)."""
        if not self._launch():return {'available':False,'reason':'HELPER_UNAVAILABLE'}
        until=time.monotonic()+8
        while not self.ready and self.error!='NOT_SUPPORTED' and self.child is not None and self.child.poll() is None and time.monotonic()<until:
            self.tick();time.sleep(.02)
        if self.child is None or self.child.poll() is not None:return {'available':False,'reason':'HELPER_UNAVAILABLE'}
        before=getattr(self,'diagnosis_seq',0)
        params={}
        if repair:
            if repair.get('inputId') is not None and not isinstance(repair.get('inputId'),str):fail('INVALID_CAPTURE')
            if 'mute' in repair and type(repair['mute']) is not bool:fail('INVALID_CAPTURE')
            if 'minimumVolume' in repair and (type(repair['minimumVolume']) not in [int,float] or not 0<=repair['minimumVolume']<=1):fail('INVALID_CAPTURE')
            params={k:repair[k] for k in ['inputId','mute','minimumVolume'] if k in repair}
        self._send('repair' if repair else 'diagnose',params or {'sessionId':self.session_id})
        until=time.monotonic()+5
        while getattr(self,'diagnosis_seq',0)==before and time.monotonic()<until:
            self.tick();time.sleep(.02)
        if getattr(self,'diagnosis_seq',0)==before:return {'available':False,'reason':'TIMEOUT'}
        return {'available':True,**self.diagnosis}
    def pause(self):
        if self.selected_engine=='browser':fail('BROWSER_CAPTURE_OWNER')
        if self.state!='recording' or self.pending:fail('INVALID_CAPTURE_STATE')
        self.pending='pause'
        try:self._send('pause')
        except CoreError:self._interrupt('CAPTURE_HELPER_UNAVAILABLE');raise
        return self.status()
    def resume(self):
        if self.selected_engine=='browser':fail('BROWSER_CAPTURE_OWNER')
        if self.state!='paused' or self.pending:fail('INVALID_CAPTURE_STATE')
        self.pending='resume';self.resume_requested=True
        try:self._send('resume')
        except CoreError:self._interrupt('CAPTURE_HELPER_UNAVAILABLE');raise
        return self.status()
    def stop(self):
        if self.selected_engine=='browser' and self.browser:return self.browser.request_stop()
        if self.state=='stopping':return self.status()
        if not self.active:return self.status()
        self.state='stopping';self.pending='stop';self.deadline=time.monotonic()+5
        try:self._send('stop')
        except CoreError:self._interrupt('CAPTURE_HELPER_UNAVAILABLE')
        return self.status()
    def status(self):
        if self.selected_engine=='browser' and self.browser:return self.browser.status()
        now=time.monotonic();levels={track:{**value,'ageMs':max(0,round((now-self.level_seen.get(track,now-60))*1000))} for track,value in self.levels.items()}
        return {'state':self.state,'sessionId':self.session_id,'recordId':self.record_id,'errorCode':self.error,'failureDetails':dict(self.failure_details) if self.failure_details is not None else None,'levels':levels,'duration':max(0,(self.end_ns-self.origin)/1e9) if self.origin is not None and self.end_ns is not None else 0,'savedBytes':self.saved_bytes,'pendingAction':self.pending}
    def _interrupt(self,code,details=None):
        was_active=self.active;self.error=code;self.failure_details=details;self.state='interrupted' if self.record_id else 'error';self.pending=None
        # Stop timeout or a protocol/storage fault must never leave a hot input
        # running after the UI reports interruption. Process exit releases OS IO.
        if self.child and self.child.poll() is None:self.child.kill()
        if code=='ACCESS_DENIED':
            if self.mode in ['mic','both']:self.access['microphone']='denied'
            if self.mode in ['system','both']:self.access['system']='denied'
        if was_active and self.record_id:
            try:
                raw=self.library._raw(self.record_id);raw['status']='interrupted';raw['_capture']['errorCode']=code;raw['version']+=1;self.library._commit(raw)
            except (CoreError,OSError,sqlite3.Error):self.error='ARCHIVE_SAVE_FAILED';self.failure_details=None  # Explicitly unsafe; no saved/ACK state is emitted.
    def tick(self):
        if self.selected_engine=='browser' and self.browser and self.browser.active:self.browser.tick();return
        for _ in range(64):
            try:generation,kind,event=self.events.get_nowait()
            except queue.Empty:break
            if generation!=self.generation:continue
            if kind!='event':
                if not self.closing and (self.active or not self.ready):self._interrupt('CAPTURE_HELPER_UNAVAILABLE' if kind=='eof' else 'INVALID_CAPTURE_PROTOCOL')
                continue
            try:self._event(event)
            except CoreError as error:self._interrupt(error.code if error.code in ['DISK_FULL','DEVICE_LOST','UNSUPPORTED_FORMAT'] else 'INVALID_CAPTURE_PROTOCOL')
            except (OSError,sqlite3.Error):self._interrupt('ARCHIVE_IO_ERROR')
            except (ValueError,KeyError,TypeError):self._interrupt('INVALID_CAPTURE_PROTOCOL')
        if self.queue_fault and not self.closing:self._interrupt('CAPTURE_QUEUE_OVERFLOW');self.queue_fault=False
        if self.test_deadline is not None and time.monotonic()>=self.test_deadline and self.state in ['requesting','recording','paused']:self.test_deadline=None;self.stop()
        if self.active and time.monotonic()-self.last_seen>5:self._interrupt('CAPTURE_HELPER_TIMEOUT')
        if self.state in ['requesting','stopping'] and time.monotonic()>getattr(self,'deadline',float('inf')):self._interrupt('CAPTURE_STOP_TIMEOUT' if self.state=='stopping' else 'ACCESS_TIMEOUT')
    def _event(self,event):
        if event.get('v')!=1 or not integer(event.get('seq')) or event['seq']<=self.last_seq:fail('INVALID_CAPTURE_PROTOCOL')
        self.last_seq=event['seq'];kind=event.get('event')
        if kind in ['ready','devices']:
            self.last_seen=time.monotonic()
            if kind=='ready' and event.get('protocol')!=1:fail('INVALID_CAPTURE_PROTOCOL')
            for field in ['inputDevices','outputDevices']:
                values=event.get(field)
                if not isinstance(values,list) or len(values)>256 or any(not isinstance(d,dict) or not isinstance(d.get('id'),str) or len(d['id'])>4096 or not isinstance(d.get('name'),str) or len(d['name'])>500 or type(d.get('default')) is not bool for d in values):fail('INVALID_CAPTURE_PROTOCOL')
                self.capability[field]=values
            if kind=='ready':
                if type(event.get('supported')) is not bool or not isinstance(event.get('modes'),list) or any(mode not in ['mic','system','both'] for mode in event['modes']):fail('INVALID_CAPTURE_PROTOCOL')
                self.capability.update({'supported':event['supported'],'modes':event['modes']});self.ready=event['supported']
                if not self.ready:self.error='NOT_SUPPORTED'
                if not self.active:self.state='ready' if self.ready else 'error'
            return
        if kind=='diagnosis':
            inputs=event.get('inputs')
            if not isinstance(inputs,list) or len(inputs)>256:fail('INVALID_CAPTURE_PROTOCOL')
            rows=[]
            for d in inputs:
                if not isinstance(d,dict) or not isinstance(d.get('id'),str) or not isinstance(d.get('name'),str) or type(d.get('default')) is not bool or not integer(d.get('state')):fail('INVALID_CAPTURE_PROTOCOL')
                muted=d.get('muted');volume=d.get('volume')
                if muted is not None and type(muted) is not bool:fail('INVALID_CAPTURE_PROTOCOL')
                if volume is not None and (type(volume) not in [int,float] or not 0<=volume<=1):fail('INVALID_CAPTURE_PROTOCOL')
                rows.append({'id':d['id'][:4096],'name':d['name'][:500],'default':d['default'],'state':{1:'active',2:'disabled',4:'missing',8:'unplugged'}.get(d['state'],'unknown'),'muted':muted,'volume':volume})
            self.diagnosis={'inputs':rows,'repairError':event.get('repairError') if isinstance(event.get('repairError'),str) else None}
            self.diagnosis_seq=getattr(self,'diagnosis_seq',0)+1
            return
        if event.get('sessionId')!=self.session_id:return
        if not self.active:return
        self.last_seen=time.monotonic()
        if kind=='state':self._state_event(event)
        elif kind=='segment':self._segment(event)
        elif kind=='level':
            track=event.get('track')
            if track not in ['mic','system'] or self.mode!='both' and track!=self.mode or any(type(event.get(field)) not in [int,float] or not math.isfinite(event[field]) or not 0<=event[field]<=1000 for field in ['peak','rms']):fail('INVALID_CAPTURE_PROTOCOL')
            if not integer(event.get('clippedFrames',0)) or event.get('clippedFrames',0)>2**53-1:fail('INVALID_CAPTURE_PROTOCOL')
            self.levels[track]={'peak':event['peak'],'rms':event['rms'],'clippedFrames':event.get('clippedFrames',0)}
            self.level_seen[track]=time.monotonic()
        elif kind=='error':self._interrupt(event.get('code') if event.get('code') in ERRORS else 'INTERNAL',failure_details(event))
        elif kind=='gap':
            if self.origin is None or not integer(event.get('startMonotonicNs')) or not integer(event.get('endMonotonicNs')) or event['endMonotonicNs']<event['startMonotonicNs']:fail('INVALID_CAPTURE_PROTOCOL')
            self._gap(event['startMonotonicNs'],event['endMonotonicNs'],event.get('reason') if event.get('reason') in ['discontinuity','sleep','device_lost'] else 'discontinuity',event.get('track'))
        else:fail('INVALID_CAPTURE_PROTOCOL')
    def _gap(self,start,end,reason,track=None):
        if self.origin is None or start<self.origin:fail('INVALID_CAPTURE_PROTOCOL')
        gap={'start':(start-self.origin)/1e9,'end':(end-self.origin)/1e9,'reason':reason}
        if track is not None:
            if track not in ['mic','system']:fail('INVALID_CAPTURE_PROTOCOL')
            gap['track']=track
        raw=self.library._raw(self.record_id);raw.setdefault('gapMarkers',[]).append(gap);raw['version']+=1;self.library._commit(raw)
    def _state_event(self,event):
        state=event.get('state');stamp=event.get('monotonicNs')
        if not integer(stamp):fail('INVALID_CAPTURE_PROTOCOL')
        if self.origin is not None and stamp<self.origin:fail('INVALID_CAPTURE_PROTOCOL')
        if state=='requesting':return
        if state=='recording':
            if self.state=='stopping':return
            if self.state not in ['requesting','paused']:fail('INVALID_CAPTURE_STATE')
            if self.origin is None:
                self.origin=event.get('originMonotonicNs')
                if not integer(self.origin) or self.origin>stamp:fail('INVALID_CAPTURE_PROTOCOL')
            if self.pause_ns is not None:self._gap(self.pause_ns,stamp,'paused');self.pause_ns=None
            raw=self.library._raw(self.record_id);raw['status']='recording';raw['_capture']['originMonotonicNs']=self.origin
            for field in ['inputId','outputId']:
                relevant=self.mode=='both' or self.mode==('mic' if field=='inputId' else 'system')
                if not relevant:continue
                previous=raw['_capture'].get(field);actual=event.get(field,previous)
                if not isinstance(actual,str) or not actual or len(actual)>4096 or previous is not None and actual!=previous:fail('DEVICE_LOST')
                raw['_capture'][field]=actual
            raw['version']+=1;self.library._commit(raw);self.state='recording';self.pending=None;self.resume_requested=False
            if self.mode in ['mic','both']:self.access['microphone']='available'
            if self.mode in ['system','both']:self.access['system']='available'
        elif state=='paused':
            if self.state=='stopping':return
            if self.state!='recording' or self.pending!='pause':fail('INVALID_CAPTURE_STATE')
            self.pause_ns=stamp;self.state='paused';self.pending=None
            raw=self.library._raw(self.record_id);raw['status']='paused';raw['version']+=1;self.library._commit(raw)
        elif state=='idle':
            if self.state!='stopping':self._interrupt('UNEXPECTED_CAPTURE_STOP');return
            if self.pause_ns is not None:self._gap(self.pause_ns,stamp,'paused');self.pause_ns=None
            raw=self.library._raw(self.record_id);self.end_ns=max(stamp,self.end_ns or stamp)
            raw['duration']=max(0,(self.end_ns-self.origin)/1e9) if self.origin is not None else 0
            raw['status']='saved' if raw['size'] and self.origin is not None else 'interrupted';raw['version']+=1;self.library._commit(raw)
            self.state='ready' if raw['status']=='saved' else 'interrupted';self.pending=None
        else:fail('INVALID_CAPTURE_STATE')
    def _segment(self,event):
        if self.origin is None:fail('INVALID_CAPTURE_PROTOCOL')
        track=event.get('track');index=event.get('index');frames=event.get('frames');start=event.get('startMonotonicNs')
        if track not in ['mic','system'] or self.mode!='both' and track!=self.mode or not integer(index) or index>999999 or not integer(frames,1) or not integer(start) or start<self.origin or start-self.origin>30*86400*10**9:fail('INVALID_CAPTURE_PROTOCOL')
        name=event.get('relativeFile');sha=event.get('sha256')
        if name!=f'{track}-{index:06}.wav' or not isinstance(sha,str) or not re.fullmatch('[a-f0-9]{64}',sha):fail('INVALID_CAPTURE_PROTOCOL')
        if self.pause_ns is not None and start>=self.pause_ns:
            if not self.resume_requested:fail('INVALID_CAPTURE_PROTOCOL')
            self._gap(self.pause_ns,start,'paused');self.pause_ns=None
        raw=self.library._raw(self.record_id);existing=next((p for p in raw['_segments'] if p['track']==track and p['index']==index),None)
        if existing:
            if existing['sha256']!=sha or existing['frames']!=frames or existing.get('startMonotonicNs')!=start or any(existing.get(key)!=event.get(key) for key in ['sampleRate','channels']):fail('SEGMENT_CONFLICT')
            self._send('commitAck',{'sessionId':self.session_id,'track':track,'index':index,'sha256':sha});return
        file=confined(self.root,name);descriptor=wave_descriptor(file)
        if any(descriptor[key]!=event.get(key) for key in ['sampleRate','channels','format','frames']):fail('INVALID_CAPTURE_PROTOCOL')
        nominal=round(frames*1e9/descriptor['sampleRate']);end=event.get('endMonotonicNs',start+nominal)
        if not integer(end) or end<=start or abs(end-start-nominal)>max(2_000_000,nominal//20):fail('INVALID_CAPTURE_PROTOCOL')
        metadata={key:descriptor[key] for key in ['sampleRate','channels','bitsPerSample','formatTag']};metadata.update({'startMonotonicNs':start,'endMonotonicNs':end})
        previous=next((p for p in raw['_segments'] if p['track']==track),None)
        if previous and any(previous.get(key)!=metadata[key] for key in ['sampleRate','channels','bitsPerSample','formatTag']):fail('UNSUPPORTED_FORMAT')
        sid=str(uuid.uuid4());staged=confined(self.library.root,'.staging',sid+'.part');journal=confined(self.library.root,'journal',f'capture-{self.session_id}-{track}-{index}.json')
        atomic_json(journal,{'recordId':self.record_id,'sessionId':self.session_id,'track':track,'index':index,'stagingId':sid,'sha256':sha,'frames':frames,'metadata':metadata})
        end_ns=max(self.end_ns or self.origin,end)
        publish(file,staged);receipt=self.library.commit_segment(self.record_id,track,index,staged,frames,sha,format_info=metadata,record_updates={'duration':(end_ns-self.origin)/1e9})
        self.end_ns=end_ns;self.saved_bytes=self.library._raw(self.record_id)['size']
        self._send('commitAck',{'sessionId':self.session_id,'track':track,'index':index,'sha256':sha,'version':receipt['version']});journal.unlink()
    def close(self):
        if self.browser:self.browser.close()
        if self.child is None:return
        if self.active:
            self.stop();deadline=time.monotonic()+2
            while self.state=='stopping' and time.monotonic()<deadline:self.tick();time.sleep(.01)
            if self.active:self._interrupt('CAPTURE_STOP_TIMEOUT')
        self.closing=True
        try:self.child.stdin.close()
        except OSError:pass
        try:self.child.wait(timeout=2)
        except subprocess.TimeoutExpired:self.child.kill();self.child.wait(timeout=2)
        if self.reader:self.reader.join(timeout=1)
        self.child.stdout.close();self.child=None;self.ready=False
        if self.root and self.root.exists() and not any(self.root.iterdir()):self.root.rmdir()
