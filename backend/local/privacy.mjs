// Windows microphone privacy switch (Settings → Privacy & security → Microphone).
// When it is off, WASAPI capture fails with E_ACCESSDENIED (0x80070005) and
// Chromium's getUserMedia fails too, for every microphone. Read-only check of
// HKCU/HKLM …\CapabilityAccessManager\ConsentStore\microphone[\NonPackaged] "Value".
import {execFile} from 'node:child_process';
const KEY='Software\\Microsoft\\Windows\\CurrentVersion\\CapabilityAccessManager\\ConsentStore\\microphone';
export function parseConsent(output){const match=/Value\s+REG_SZ\s+(\w+)/i.exec(String(output||''));return match?match[1].toLowerCase():null}
function query(run,hive,suffix){return new Promise(resolve=>{try{run('reg',['query',`${hive}\\${KEY}${suffix}`,'/v','Value'],{timeout:3000,windowsHide:true},(error,stdout)=>resolve(error?null:parseConsent(stdout)))}catch{resolve(null)}})}
/** {blocked:boolean, scope:'system'|'desktop'|null}; never throws, null on other platforms. */
export async function microphonePrivacy({platform=process.platform,run=execFile}={}){
 if(platform!=='win32')return null;
 const [machine,user,desktop]=await Promise.all([query(run,'HKLM',''),query(run,'HKCU',''),query(run,'HKCU','\\NonPackaged')]);
 if(machine==='deny'||user==='deny')return {blocked:true,scope:'system'};
 if(desktop==='deny')return {blocked:true,scope:'desktop'};
 return {blocked:false,scope:null};
}

/** Who is using the microphone right now, as Windows records it for its own "in use" list:
 * ConsentStore\microphone\<app> and \NonPackaged\<path#to#app.exe> hold LastUsedTimeStart/Stop;
 * a session that has started and not stopped (Stop = 0) is treated as "using it now".
 * Heuristic (the rule is inferred from forensic write-ups, not documented by Microsoft), so the
 * app only says "may be using" and never blocks on it. Returns display names, MONO's own
 * browser engines excluded. */
export function parseMicrophoneUsers(output){
 const users=[];let current=null,start=0,stop=null;
 const flush=()=>{if(current&&start>0&&stop===0)users.push(current);current=null;start=0;stop=null};
 for(const line of String(output||'').split(/\r?\n/)){
  if(/^HKEY_/i.test(line.trim())){flush();const key=line.trim().split('\\').pop();if(key&&!/^(microphone|NonPackaged)$/i.test(key))current=key;continue}
  const value=/^\s+(LastUsedTimeStart|LastUsedTimeStop)\s+REG_QWORD\s+0x([0-9a-f]+)/i.exec(line);
  if(value&&current){const n=parseInt(value[2],16);if(/Start/i.test(value[1]))start=n;else stop=n}
 }
 flush();
 const name=key=>{const exe=key.split('#').pop();return /\.exe$/i.test(exe)?exe.replace(/\.exe$/i,''):key.replace(/_[a-z0-9]{13}$/i,'').split('.').pop()};
 return [...new Set(users.map(name))].filter(n=>!/^(chrome|msedge|brave|vivaldi|opera|MonoAudio|python|pythonw|node)$/i.test(n));
}
export function microphoneUsers({platform=process.platform,run=execFile}={}){
 if(platform!=='win32')return Promise.resolve([]);
 return new Promise(resolve=>{try{run('reg',['query',`HKCU\\${KEY}`,'/s'],{timeout:4000,windowsHide:true,maxBuffer:4*1024*1024},(error,stdout)=>resolve(error?[]:parseMicrophoneUsers(stdout)))}catch{resolve([])}});
}
