"""Server-owned browser microphone session; audio is acknowledged only after commit."""
import math,time,uuid,wave,struct,sqlite3
from local_core.capture import wave_descriptor,integer
from local_core.protocol import CoreError

def fail(code):raise CoreError(code,code)

class BrowserSession:
 def __init__(self,config,now_ns=time.monotonic_ns):
  self.config=config;self.clock=now_ns;self.state='idle';self.error=None;self.session_id=None;self.record_id=None
  self.frames=0;self.saved_bytes=0;self.rate=0;self.next_index=0;self.pause_frame=None;self.pause_ranges=[];self.last_transition=0;self.last_seen=0;self.levels={};self.level_seen=0;self.stop_deadline=None;self.test_deadline=None
 @property
 def active(self):return self.state in ['recording','paused','stopping']
 def status(self):
  levels={track:{**value,'ageMs':max(0,(self.clock()-self.level_seen)//1_000_000)} for track,value in self.levels.items()}
  return {'state':self.state,'sessionId':self.session_id,'recordId':self.record_id,'errorCode':self.error,'levels':levels,'duration':self.frames/self.rate if self.rate else 0,'savedFrames':self.frames,'savedBytes':self.saved_bytes,'pendingAction':'stop' if self.state=='stopping' else None,'engine':'browser'}
 def start(self,params):
  if self.active:fail('CAPTURE_BUSY')
  if set(params)-{'sampleRate','inputId','test'}:fail('INVALID_CAPTURE')
  rate=params.get('sampleRate');device=params.get('inputId')
  if type(rate) is not int or not 8000<=rate<=192000:fail('INVALID_CAPTURE_FORMAT')
  if device is not None and (not isinstance(device,str) or not 1<=len(device)<=4096):fail('INVALID_CAPTURE')
  if type(params.get('test',False)) is not bool:fail('INVALID_CAPTURE')
  if self.config.transfers.active:fail('LIBRARY_BUSY')
  self.library=self.config.get_library();self.session_id=str(uuid.uuid4());self.origin=self.clock();self.last_seen=self.origin;self.last_audio=self.origin
  self.rate=rate;self.frames=0;self.saved_bytes=0;self.next_index=0;self.pause_frame=None;self.pause_ranges=[];self.last_transition=0;self.levels={};self.error=None;self.stop_deadline=None
  record=self.library.create_record({'title':'Проверка звука' if params.get('test') else 'Запись '+time.strftime('%d.%m.%Y %H:%M'),'mime':'audio/wav','source':'Микрофон','status':'recording'})
  self.record_id=record['id'];raw=self.library._raw(self.record_id);raw['_capture']={'sessionId':self.session_id,'mode':'mic','engine':'browser','inputId':device,'originMonotonicNs':self.origin,'temporary':params.get('test',False)};raw['version']+=1;self.library._commit(raw)
  self.state='recording';self.test_deadline=self.origin+5_000_000_000 if params.get('test') else None
  return self.status()
 def check(self,params):
  if params.get('sessionId')!=self.session_id:fail('INVALID_CAPTURE_SESSION')
  if not self.active:fail('INVALID_CAPTURE_STATE')
 def heartbeat(self,params):
  self.check(params);self.last_seen=self.clock();return self.status()
 def segment(self,params):
  self.check(params);index=params.get('index')
  if type(index) is not int or not 0<=index<=999999:fail('INVALID_CAPTURE_SEQUENCE')
  file=self.config.stage_path(params.get('stagingId'));descriptor=wave_descriptor(file)
  frames=descriptor['frames']
  if descriptor['formatTag']!=1 or descriptor['bitsPerSample']!=16 or descriptor['channels']!=1 or descriptor['sampleRate']!=self.rate or not 1<=frames<=2*self.rate:fail('INVALID_CAPTURE_FORMAT')
  checksum=params.get('sha256')
  if index<self.next_index:
   receipt=self.library.commit_segment(self.record_id,'mic',index,file,frames,checksum)
   return {'sessionId':self.session_id,'index':index,'frames':self.frames,'count':frames,'sha256':checksum,'version':receipt['version'],'state':self.status()}
  if index!=self.next_index:fail('INVALID_CAPTURE_SEQUENCE')
  if self.frames+frames>30*86400*self.rate:fail('INVALID_CAPTURE_FRAMES')
  with wave.open(str(file),'rb') as source:data=source.readframes(frames)
  ranges=self.pause_ranges+([(self.pause_frame,self.frames+frames)] if self.pause_frame is not None else [])
  for begin,finish in ranges:
   first=max(begin-self.frames,0);last=min(finish-self.frames,frames)
   if first<last and any(data[first*2:last*2]):fail('INVALID_PAUSED_AUDIO')
  peak=0;squares=0;clips=0
  for (sample,) in struct.iter_unpack('<h',data):
   value=sample/32768;peak=max(peak,abs(value));squares+=value*value;clips+=int(sample in [-32768,32767])
  start=self.origin+round(self.frames*1_000_000_000/self.rate);end=self.origin+round((self.frames+frames)*1_000_000_000/self.rate)
  info={key:descriptor[key] for key in ['sampleRate','channels','bitsPerSample','formatTag']};info.update(startMonotonicNs=start,endMonotonicNs=end)
  receipt=self.library.commit_segment(self.record_id,'mic',index,file,frames,checksum,format_info=info,record_updates={'duration':(self.frames+frames)/self.rate})
  self.frames+=frames;self.next_index+=1;self.last_seen=self.clock();self.last_audio=self.last_seen;self.level_seen=self.last_seen;self.levels={'mic':{'peak':peak,'rms':math.sqrt(squares/frames),'clippedFrames':clips}}
  self.saved_bytes=self.library._raw(self.record_id)['size']
  ack={'sessionId':self.session_id,'index':index,'frames':self.frames,'count':frames,'sha256':checksum,'version':receipt['version']}
  return {**ack,'state':self.status()}
 def transition_frame(self,params):
  self.check(params);frame=params.get('frames')
  if not integer(frame) or frame<self.last_transition or frame>self.frames+2*self.rate:fail('INVALID_CAPTURE_FRAMES')
  self.last_transition=frame;self.last_seen=self.clock();return frame
 def patch(self,**fields):
  raw=self.library._raw(self.record_id);raw.update(fields);raw['version']+=1;self.library._commit(raw)
 def pause(self,params):
  if self.state!='recording':fail('INVALID_CAPTURE_STATE')
  self.pause_frame=self.transition_frame(params);self.state='paused';self.patch(status='paused');return self.status()
 def gap(self,end):
  if self.pause_frame is None:return
  if end<self.pause_frame:fail('INVALID_CAPTURE_FRAMES')
  raw=self.library._raw(self.record_id);raw.setdefault('gapMarkers',[]).append({'start':self.pause_frame/self.rate,'end':end/self.rate,'reason':'paused'});raw['version']+=1;self.library._commit(raw);self.pause_ranges.append((self.pause_frame,end));self.pause_frame=None
 def resume(self,params):
  if self.state!='paused':fail('INVALID_CAPTURE_STATE')
  frame=self.transition_frame(params);self.gap(frame);self.state='recording';self.patch(status='recording');return self.status()
 def request_stop(self):
  if self.active and self.state!='stopping':self.state='stopping';self.stop_deadline=self.clock()+5_000_000_000
  return self.status()
 def finish(self,params):
  self.check(params)
  if type(params.get('frames')) is not int or params['frames']!=self.frames or self.pause_frame is not None and self.pause_frame>self.frames:fail('INVALID_CAPTURE_FRAMES')
  if not self.frames:self.interrupt('NO_AUDIO_CAPTURED');return self.status()
  self.gap(self.frames);self.patch(status='saved',duration=self.frames/self.rate);self.state='ready';self.error=None;self.stop_deadline=None;return self.status()
 def interrupt(self,code='BROWSER_CAPTURE_LOST'):
  if not self.active:return self.status()
  # A pause boundary not yet received as audio must not invent saved duration.
  self.error=code;self.state='interrupted';self.stop_deadline=None
  try:
   if self.pause_frame is not None and self.pause_frame<=self.frames:self.gap(self.frames)
   self.patch(status='interrupted',duration=self.frames/self.rate)
  except (CoreError,OSError,sqlite3.Error):self.error='ARCHIVE_SAVE_FAILED'
  return self.status()
 def abort(self,params):self.check(params);return self.interrupt()
 def grace(self,seconds):
  ns=int(seconds*1_000_000_000);self.last_seen+=ns;self.last_audio+=ns
  if self.stop_deadline is not None:self.stop_deadline+=ns
  if self.test_deadline is not None:self.test_deadline+=ns
 def tick(self):
  if not self.active:return
  now=self.clock()
  if now-self.last_seen>5_000_000_000:self.interrupt();return
  if now-self.last_audio>7_000_000_000:self.interrupt('NO_AUDIO_CAPTURED' if not self.frames else 'BROWSER_AUDIO_ERROR');return
  if self.stop_deadline is not None and now>self.stop_deadline:self.interrupt('CAPTURE_STOP_TIMEOUT');return
  if self.test_deadline is not None and now>=self.test_deadline:self.test_deadline=None;self.request_stop()
 def close(self):
  if self.active:self.interrupt()
