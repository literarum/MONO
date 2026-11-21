/** Deterministic Web Locks protocol model for Node 20/22 unit tests.
 * Browser acceptance remains required; this is not a browser API polyfill.
 */
export class TestLockManager{
 constructor(){this.names=new Map()}
 request(name,{mode='exclusive',signal,ifAvailable=false}={},callback){
  return new Promise((resolve,reject)=>{
   if(signal?.aborted){reject(signal.reason);return}
   let group=this.names.get(name);if(!group){group={held:new Set(),queue:[]};this.names.set(name,group)}
   const busy=group.queue.length||[...group.held].some(entry=>mode==='exclusive'||entry.mode==='exclusive');
   if(ifAvailable&&busy){queueMicrotask(()=>Promise.resolve().then(()=>callback(null)).then(resolve,reject));return}
   const entry={mode,signal,callback,resolve,reject,abort:null};entry.abort=()=>{const index=group.queue.indexOf(entry);if(index<0)return;group.queue.splice(index,1);reject(signal.reason);this.drain(name,group)};
   signal?.addEventListener('abort',entry.abort,{once:true});group.queue.push(entry);this.drain(name,group);
  });
 }
 drain(name,group){
  while(group.queue.length){
   const entry=group.queue[0];if(group.held.size&&(entry.mode==='exclusive'||[...group.held].some(held=>held.mode==='exclusive')))break;
   group.queue.shift();entry.signal?.removeEventListener('abort',entry.abort);group.held.add(entry);
   queueMicrotask(()=>Promise.resolve().then(()=>entry.callback({name,mode:entry.mode})).then(value=>this.release(name,group,entry,null,value),error=>this.release(name,group,entry,error)));
  }
  if(!group.held.size&&!group.queue.length)this.names.delete(name);
 }
 release(name,group,entry,error,value){group.held.delete(entry);this.drain(name,group);error?entry.reject(error):entry.resolve(value)}
}
