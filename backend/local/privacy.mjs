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
