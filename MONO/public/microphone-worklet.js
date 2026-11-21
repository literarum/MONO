import {PcmCapture} from './microphone-pcm.js';
class MicrophoneProcessor extends AudioWorkletProcessor{
 constructor(){
  super();this.core=new PcmCapture(sampleRate,part=>this.port.postMessage({type:'chunk',...part},[part.pcm]),frames=>this.port.postMessage({type:'ended',frames}));
  this.meter={peak:0,squares:0,frames:0,clips:0};
  this.port.onmessage=event=>{
   const {id,type}=event.data||{};
   try{
    if(type==='pause'||type==='resume'){const frames=this.core.setPaused(type==='pause');this.port.postMessage({type:'ack',id,frames})}
    else if(type==='stop'){this.core.stop();this.port.postMessage({type:'ack',id,frames:this.core.frames})}
   }catch{this.port.postMessage({type:'fault'})}
  };
 }
 process(inputs){try{const value=this.core.append(inputs[0]||[]);if(value?.frames){const meter=this.meter;meter.peak=Math.max(meter.peak,value.peak);meter.squares+=value.rms**2*value.frames;meter.frames+=value.frames;meter.clips+=value.clippedFrames;if(meter.frames>=sampleRate/10){this.port.postMessage({type:'level',value:{peak:meter.peak,rms:Math.sqrt(meter.squares/meter.frames),clippedFrames:meter.clips}});this.meter={peak:0,squares:0,frames:0,clips:0}}}return !this.core.stopped}catch{this.port.postMessage({type:'fault'});return false}}
}
registerProcessor('mono-microphone',MicrophoneProcessor);
