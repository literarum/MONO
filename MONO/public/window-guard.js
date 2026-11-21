// One MONO window. The launcher opens its window as /?window=mono; the browser may also bring back a
// MONO window from its last session, or a second click may race the first. Windows opened for MONO
// talk on a BroadcastChannel: the oldest one stays and comes forward, a newer one closes itself
// (allowed: it has a single history entry) or, if the browser refuses, offers to take over.
const CHANNEL='mono-window',FLAG='mono-launcher-window';

export function markLauncherWindow({location=globalThis.location,history=globalThis.history,storage=globalThis.sessionStorage}={}){
 try{
  const params=new URLSearchParams(location.search);
  if(params.get('window')==='mono'){storage.setItem(FLAG,'1');params.delete('window');const query=params.toString();history.replaceState(history.state,'',location.pathname+(query?'?'+query:'')+location.hash)}
  return storage.getItem(FLAG)==='1';
 }catch{return false}
}

export function guardSingleWindow({onDuplicate=()=>{},onFocus=()=>{},Channel=globalThis.BroadcastChannel,started=globalThis.performance?.timeOrigin??Date.now(),close=()=>globalThis.close(),wait=400}={}){
 if(!markLauncherWindow()||typeof Channel!=='function')return {release(){}};
 const id=Math.random().toString(36).slice(2),channel=new Channel(CHANNEL);let retired=false;
 const older=message=>message.started<started||(message.started===started&&message.id<id);
 channel.onmessage=({data})=>{
  if(!data||data.id===id||retired)return;
  if(data.type==='hello'){if(older(data))return;channel.postMessage({type:'present',id,started});onFocus()}
  else if(data.type==='present'&&older(data))retire();
  else if(data.type==='take-over'){retire()}
 };
 function retire(){
  if(retired)return;retired=true;
  try{close()}catch{}
  // If the browser kept the window open, say so instead of running a second copy of MONO.
  setTimeout(()=>{if(!globalThis.closed)onDuplicate(()=>{retired=false;channel.postMessage({type:'take-over',id,started})})},wait);
 }
 channel.postMessage({type:'hello',id,started});
 return {release(){channel.close()}};
}
/** A MONO window the browser brought back from its last session while MONO itself is not running
 * (the page comes from the offline shell): it closes itself instead of showing a dead window. */
export async function closeIfOrphaned({fetchHealth=()=>fetch('/api/health',{cache:'no-store',signal:AbortSignal.timeout(4000)}),close=()=>globalThis.close(),storage=globalThis.sessionStorage}={}){
 try{if(storage.getItem(FLAG)!=='1')return false}catch{return false}
 for(let attempt=0;attempt<3;attempt++){try{const response=await fetchHealth();if(response.ok)return false}catch{}await new Promise(r=>setTimeout(r,1500))}
 try{close()}catch{}return true;
}

/** The launcher's window opens filling the screen; «Без рамок» (fullscreen) needs the person's first
 * click, because browsers allow fullscreen only from a user gesture. */
export function fitLauncherWindow({mode='maximized',win=globalThis,doc=globalThis.document,storage=globalThis.sessionStorage}={}){
 let launcher=false;try{launcher=storage.getItem(FLAG)==='1'}catch{}
 if(!launcher||mode==='window')return false;
 try{const width=win.screen.availWidth,height=win.screen.availHeight;if(win.outerWidth<width-8||win.outerHeight<height-8){win.moveTo(win.screen.availLeft||0,win.screen.availTop||0);win.resizeTo(width,height)}}catch{}
 if(mode==='fullscreen'&&doc.documentElement.requestFullscreen&&!doc.fullscreenElement){
  const enter=()=>{doc.documentElement.requestFullscreen({navigationUI:'hide'}).catch(()=>{})};
  doc.addEventListener('pointerdown',enter,{once:true,capture:true});doc.addEventListener('keydown',enter,{once:true,capture:true});
 }
 return true;
}
