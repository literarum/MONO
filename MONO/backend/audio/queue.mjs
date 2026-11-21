import {audioError} from './process.mjs';
/** One bounded CPU preparation lane, shared with native reference rendering. */
export class AudioWorkQueue{
 constructor({limit=8}={}){this.limit=limit;this.pending=0;this.tail=Promise.resolve();this.closed=false}
 run(work,{signal}={}){
  if(this.closed||signal?.aborted)return Promise.reject(audioError('CANCELLED'));
  if(this.pending>=this.limit)return Promise.reject(audioError('PREPARATION_BUSY'));
  this.pending++;const operation=this.tail.then(()=>{if(this.closed||signal?.aborted)throw audioError('CANCELLED');return work()}).finally(()=>this.pending--);this.tail=operation.catch(()=>{});return operation;
 }
 async close(){this.closed=true;await this.tail}
}
