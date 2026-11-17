import {spawn} from 'node:child_process';import {randomUUID} from 'node:crypto';import {fileURLToPath} from 'node:url';import {existsSync} from 'node:fs';
export class WorkerClient{
 constructor(){this.pending=new Map();this.child=null;this.ready=null;this.closing=null}
 async start(){
  if(this.closing)throw new Error('WORKER_CLOSED');
  if(this.ready)return this.ready;
  this.ready=new Promise((resolve,reject)=>{
   const script=fileURLToPath(new URL('../../launcher/local_core/worker.py',import.meta.url));
   const executable=process.env.MONO_CORE_EXECUTABLE||'python';
   const args=process.env.MONO_CORE_PACKAGED==='1'?['--core-worker']:[process.env.MONO_CORE_SCRIPT||script];
   if(process.env.MONO_LAUNCHER==='1'&&!process.env.MONO_CORE_EXECUTABLE){reject(new Error('LOCAL_CORE_UNAVAILABLE'));return}
   if(process.env.MONO_CORE_PACKAGED!=='1'&&!existsSync(args[0])){reject(new Error('LOCAL_CORE_UNAVAILABLE'));return}
   const child=spawn(executable,args,{stdio:['pipe','pipe','ignore'],windowsHide:true,env:{...process.env,PYTHONUTF8:'1'}});this.child=child;
   child.stdout.setEncoding('utf8');
   let buffer='';const timer=setTimeout(()=>{child.kill();reject(new Error('WORKER_START_TIMEOUT'))},25000);
   const fail=()=>{clearTimeout(timer);reject(new Error('WORKER_UNAVAILABLE'));for(const item of this.pending.values()){clearTimeout(item.timer);item.cleanup();item.reject(new Error('WORKER_UNAVAILABLE'))}this.pending.clear();this.child=null;this.ready=null};
   child.on('error',fail);child.on('exit',fail);child.stdin.on('error',()=>{});
   child.stdout.on('data',chunk=>{
    buffer+=chunk.toString('utf8');
    if(Buffer.byteLength(buffer)>131072){child.kill();return}
    while(buffer.includes('\n')){
     const i=buffer.indexOf('\n'),line=buffer.slice(0,i);buffer=buffer.slice(i+1);
     let message;try{message=JSON.parse(line)}catch{child.kill();return}
     if(message.event==='ready'&&message.protocol===1){clearTimeout(timer);resolve();continue}
     const item=this.pending.get(message.id);if(!item)continue;
     this.pending.delete(message.id);clearTimeout(item.timer);item.cleanup();
     if(message.error){const error=new Error(message.error.message);error.code=message.error.code;item.reject(error)}else item.resolve(message.result);
    }
   });
  });return this.ready;
 }
 async call(method,params={}, {signal,timeoutMs=15000}={}){
  await this.start();if(signal?.aborted)throw new Error('CANCELLED');
  const id=randomUUID(),line=JSON.stringify({v:1,id,method,params})+'\n';if(Buffer.byteLength(line)>65536)throw new Error('REQUEST_TOO_LARGE');
  return new Promise((resolve,reject)=>{
   const cancel=()=>{const item=this.pending.get(id);if(!item)return;clearTimeout(item.timer);this.pending.delete(id);item.cleanup();reject(new Error('CANCELLED'))};
   const cleanup=()=>signal?.removeEventListener('abort',cancel);
   const timer=setTimeout(()=>{this.pending.delete(id);cleanup();reject(new Error('WORKER_TIMEOUT'))},timeoutMs);
   this.pending.set(id,{resolve,reject,timer,cleanup});signal?.addEventListener('abort',cancel,{once:true});
   this.child.stdin.write(line,error=>{if(error)cancel()});
  });
 }
 close(){
  if(this.closing)return this.closing;
  const child=this.child;if(!child)return this.closing=Promise.resolve();
  this.closing=new Promise((resolve,reject)=>{
   const timer=setTimeout(()=>{child.kill();reject(new Error('WORKER_STOP_TIMEOUT'))},5000);
   child.once('exit',code=>{clearTimeout(timer);if(code===0)resolve();else reject(new Error('WORKER_STOP_FAILED'))});
   child.stdin.end();
  });return this.closing;
 }
}
