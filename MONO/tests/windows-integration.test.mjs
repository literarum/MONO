import test from 'node:test';import assert from 'node:assert/strict';
import {parseConsent,microphonePrivacy} from '../backend/local/privacy.mjs';
import {parseAccent,systemAccent} from '../backend/local/appearance.mjs';
import {preflight} from '../backend/local/preflight.mjs';
const reg=answers=>(cmd,args,options,done)=>{const key=args[1];const hit=Object.entries(answers).find(([k])=>key.endsWith(k));hit?done(null,`\r\n${key}\r\n    Value    REG_SZ    ${hit[1]}\r\n`):done(new Error('not found'))};
test('Windows microphone privacy: a denied switch is detected for the system and for desktop apps',async()=>{
 assert.equal(parseConsent('    Value    REG_SZ    Deny'),'deny');assert.equal(parseConsent(''),null);
 assert.deepEqual(await microphonePrivacy({platform:'win32',run:reg({'microphone':'Allow','NonPackaged':'Deny'})}),{blocked:true,scope:'desktop'});
 assert.deepEqual(await microphonePrivacy({platform:'win32',run:reg({'microphone':'Deny'})}),{blocked:true,scope:'system'});
 assert.deepEqual(await microphonePrivacy({platform:'win32',run:reg({})}),{blocked:false,scope:null});
 assert.equal(await microphonePrivacy({platform:'linux'}),null);
});
test('a blocked microphone is a pre-flight caution with the exact Settings path, not a recording block',async()=>{
 const worker={call:async m=>m==='status'?{libraryConfigured:false}:{ready:true,modes:['mic','system']}};
 const result=await preflight({worker,runtime:()=>({ffmpeg:true,ffprobe:true}),keyManager:{status:async()=>({configured:true})},privacy:async()=>({blocked:true,scope:'desktop'})});
 const item=result.checks.find(c=>c.id==='mic-privacy');assert.equal(item.level,'caution');assert.match(item.action,/Конфиденциальность/);
});
test('Windows accent colour: DWM ABGR DWORD becomes #rrggbb',async()=>{
 assert.equal(parseAccent('    AccentColor    REG_DWORD    0xffd77800'),'#0078d7');assert.equal(parseAccent('nothing'),null);
 assert.equal(await systemAccent({platform:'darwin'}),null);
 assert.equal(await systemAccent({platform:'win32',run:(c,a,o,done)=>done(null,'AccentColor    REG_DWORD    0xff2a8c00')}),'#008c2a');
});
import {newer,checkUpdate} from '../backend/local/updates.mjs';
import {localServer} from './helpers/local-server.mjs';
test('update check offers only a newer, non-draft release with an https installer link',async()=>{
 assert.equal(newer('v0.5.0','0.4.0'),true);assert.equal(newer('0.4.0','0.4.0'),false);assert.equal(newer('0.3.9','0.4.0'),false);assert.equal(newer('1.0','0.9.9'),true);
 const feed=release=>async()=>({ok:true,json:async()=>release});
 assert.deepEqual(await checkUpdate({current:'0.4.0',enabled:true,fetch:feed({tag_name:'v0.5.0',assets:[{name:'MONO-Setup-0.5.0.exe',browser_download_url:'https://example.test/s.exe'}]})}),{version:'0.5.0',url:'https://example.test/s.exe',notes:''});
 assert.equal(await checkUpdate({current:'0.4.0',enabled:true,fetch:feed({tag_name:'v0.5.0',prerelease:true})}),null);
 assert.equal(await checkUpdate({current:'0.4.0',enabled:true,fetch:async()=>{throw new Error('offline')}}),null);
 assert.equal(await checkUpdate({current:'0.4.0',enabled:false,fetch:feed({tag_name:'v9'})}),null);
});
test('global hotkey: only the launcher token is accepted and the window receives the event',async t=>{
 const server=await localServer(t,{MONO_LAUNCHER_TOKEN:'t'.repeat(43)});
 assert.equal((await fetch(server.url+'/api/launcher/hotkey',{method:'POST',headers:{'X-Mono-Launcher-Token':'wrong'}})).status,403);
 assert.equal((await fetch(server.url+'/api/local/events')).status,401);
 const headers=await server.session(),controller=new AbortController();t.after(()=>controller.abort());
 const events=await fetch(server.url+'/api/local/events',{headers:{Cookie:headers.Cookie},signal:controller.signal});assert.equal(events.status,200);
 const reader=events.body.getReader(),decoder=new TextDecoder();await reader.read();
 assert.equal((await fetch(server.url+'/api/launcher/hotkey',{method:'POST',headers:{'X-Mono-Launcher-Token':'t'.repeat(43)}})).status,204);
 let text='';while(!text.includes('event: hotkey')){const {value}=await reader.read();text+=decoder.decode(value)}
 assert.match(text,/toggle-recording/);
});
test('storage endpoint reports free space and the worst-case recording rate',async t=>{
 const server=await localServer(t);const headers=await server.session();
 await fetch(server.url+'/api/local/library/configure',{method:'POST',headers:{...headers,'Content-Type':'application/json'},body:JSON.stringify({useDefault:true})});
 const body=await (await fetch(server.url+'/api/local/storage',{headers:{Cookie:headers.Cookie}})).json();
 assert.ok(body.freeBytes>0);assert.equal(body.bytesPerMinute,48000*2*4*60);
});
test('pre-flight write probe and OneDrive detection',async()=>{
 const {writeProbe,oneDriveRoot}=await import('../backend/local/preflight.mjs');const {mkdtemp}=await import('node:fs/promises');const {tmpdir}=await import('node:os');const path=await import('node:path');
 assert.equal(await writeProbe(await mkdtemp(path.join(tmpdir(),'mono-probe-'))),'ok');
 assert.equal(await writeProbe(path.join(tmpdir(),'does-not-exist-'+Date.now())),'unknown');
 const root=path.resolve(tmpdir(),'OneDrive');
 assert.equal(oneDriveRoot(path.join(root,'Документы','MONO'),{OneDrive:root}),root.toLowerCase());
 assert.equal(oneDriveRoot(path.join(tmpdir(),'Other'),{OneDrive:root}),null);
});
test('microphone users: an open session (Stop = 0) is reported, finished ones and MONO\'s own engines are not',async()=>{
 const {parseMicrophoneUsers,microphoneUsers}=await import('../backend/local/privacy.mjs');
 const key='HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\CapabilityAccessManager\\ConsentStore\\microphone';
 const out=[key,'    Value    REG_SZ    Allow','',key+'\\NonPackaged','',key+'\\NonPackaged\\C:#Users#a#Discord#Discord.exe','    LastUsedTimeStart    REG_QWORD    0x1db3f1a2b3c4d5e','    LastUsedTimeStop    REG_QWORD    0x0','',
  key+'\\NonPackaged\\C:#Program Files#Google#Chrome#Application#chrome.exe','    LastUsedTimeStart    REG_QWORD    0x1db3f1a2b3c4d5e','    LastUsedTimeStop    REG_QWORD    0x0','',
  key+'\\NonPackaged\\C:#Zoom#Zoom.exe','    LastUsedTimeStart    REG_QWORD    0x1db3f1a2b3c4d5e','    LastUsedTimeStop    REG_QWORD    0x1db3f1a2b3c4d6f','',
  key+'\\Microsoft.WindowsSoundRecorder_8wekyb3d8bbwe','    LastUsedTimeStart    REG_QWORD    0x1db3f1a2b3c4d5e','    LastUsedTimeStop    REG_QWORD    0x0'].join('\r\n');
 assert.deepEqual(parseMicrophoneUsers(out),['Discord','WindowsSoundRecorder']);
 assert.deepEqual(await microphoneUsers({platform:'linux'}),[]);
});
