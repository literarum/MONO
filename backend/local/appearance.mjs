// Windows accent colour (Settings → Personalization → Colors), so the app tint
// follows the system like native apps. HKCU\Software\Microsoft\Windows\DWM\AccentColor
// is a DWORD in ABGR order. Best effort: any failure means "no system accent".
import {execFile} from 'node:child_process';
export function parseAccent(output){
 const match=/AccentColor\s+REG_DWORD\s+0x([0-9a-f]{1,8})/i.exec(String(output||''));if(!match)return null;
 const v=parseInt(match[1],16),hex=n=>n.toString(16).padStart(2,'0');
 return '#'+hex(v&255)+hex(v>>>8&255)+hex(v>>>16&255);
}
export function systemAccent({platform=process.platform,run=execFile}={}){
 if(platform!=='win32')return Promise.resolve(null);
 return new Promise(resolve=>{try{run('reg',['query','HKCU\\Software\\Microsoft\\Windows\\DWM','/v','AccentColor'],{timeout:3000,windowsHide:true},(error,stdout)=>resolve(error?null:parseAccent(stdout)))}catch{resolve(null)}});
}
