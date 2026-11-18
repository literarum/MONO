"""Synthetic protocol fixture. This never proves physical audio capture."""
import argparse,hashlib,json,os,sys,wave,threading,struct,time
from pathlib import Path
parser=argparse.ArgumentParser();parser.add_argument('--protocol');parser.add_argument('--capture-root');parser.add_argument('--behavior',default='normal');args=parser.parse_args()
root=Path(args.capture_root);root.mkdir(parents=True,exist_ok=True);sequence=0;session=None;previous=None;mode='mic';origin=10_000_000_000;end=origin;output_lock=threading.Lock();closed=threading.Event()
def emit(event,**fields):
    global sequence
    with output_lock:
        print(json.dumps({'v':1,'event':event,'seq':sequence,**fields}),flush=True);sequence+=1
def segment(track,index,start):
    file=root/f'{track}-{index:06}.wav'
    data=bytearray(64000)
    if args.behavior=='impulse':struct.pack_into('<h',data,(8000 if track=='system' else 16000)*2,16384)
    with wave.open(str(file),'wb') as output:output.setnchannels(1);output.setsampwidth(2);output.setframerate(16000);output.writeframes(data)
    with file.open('r+b') as output:os.fsync(output.fileno())
    emit('segment',sessionId=session,track=track,index=index,relativeFile=file.name,format='pcm_s16le',sampleRate=16000,channels=1,startMonotonicNs=start,endMonotonicNs=start+2_000_000_000+(200000 if args.behavior=='clock-drift' else 0),frames=32000,sha256=hashlib.sha256(file.read_bytes()).hexdigest())
emit('ready',protocol=1,platform='fixture',supported=True,modes=['mic','system','both'],inputDevices=[{'id':'mic-fixture','name':'Fixture microphone','default':True}],outputDevices=[{'id':'system-fixture','name':'Fixture output','default':True}])
def heartbeat():
    while not closed.wait(.25):
        if session:
            for track in ['mic','system'] if mode=='both' else [mode]:emit('level',sessionId=session,track=track,peak=0,rms=0,clippedFrames=0,monotonicNs=end)
heart=threading.Thread(target=heartbeat,daemon=True)
if args.behavior!='no-heartbeat':heart.start()
for line in sys.stdin:
    command=json.loads(line);method=command['method'];params=command.get('params',{})
    if method=='start':
        previous=session;session=params['sessionId'];mode=params['mode'];end=origin
        emit('state',sessionId=session,state='requesting',monotonicNs=origin)
        if args.behavior in ['open-failure','open-failure-unsafe']:
            emit('error',sessionId=session,code='INTERNAL',stage='capture-mic/initialize',nativeCode='80070057' if args.behavior=='open-failure' else 'PRIVATE_INVALID_EXCEPTION')
            continue
        if args.behavior=='pending':continue
        if args.behavior=='start-delayed':time.sleep(3)
        emit('state',sessionId=session,state='recording',monotonicNs=origin,originMonotonicNs=origin,inputId='mic-fixture',outputId='system-fixture')
        if previous:emit('level',sessionId=previous,track='mic',peak=.9,rms=.5,clippedFrames=0,monotonicNs=origin)
        if args.behavior=='unsafe':emit('segment',sessionId=session,track='mic',index=0,relativeFile='../escape.wav',format='pcm_s16le',sampleRate=16000,channels=1,startMonotonicNs=origin,frames=32000,sha256='0'*64);continue
        for track in ['system'] if args.behavior=='wrong-track' else ['mic','system'] if mode=='both' else [mode]:segment(track,0,origin)
        end=origin+2_000_000_000
        if args.behavior=='device-lost-once':
            # The first take loses its device after the first committed part; later takes are healthy.
            marker=os.path.join(os.path.dirname(os.path.abspath(args.capture_root)),'.fixture-device-lost')
            if not os.path.exists(marker):
                open(marker,'w').close();lost=session
                threading.Timer(1.5,lambda:emit('error',sessionId=lost,code='DEVICE_LOST',stage='capture-mic/read',nativeCode='88890004')).start()
    elif method=='pause':
        emit('state',sessionId=session,state='paused',monotonicNs=end)
        if args.behavior=='paused-data':segment('mic',1,origin+4_000_000_000)
    elif method=='resume':
        if args.behavior!='resume-delayed':emit('state',sessionId=session,state='recording',monotonicNs=origin+4_000_000_000)
        for track in ['mic','system'] if mode=='both' else [mode]:segment(track,1,origin+4_000_000_000)
        end=origin+6_000_000_000
    elif method=='stop':
        if args.behavior!='ignore-stop':emit('state',sessionId=session,state='idle',monotonicNs=end)
    elif method=='enumerate':emit('devices',inputDevices=[{'id':'mic-fixture','name':'Fixture microphone','default':True}],outputDevices=[{'id':'system-fixture','name':'Fixture output','default':True}])
closed.set()
if heart.is_alive():heart.join(timeout=1)
