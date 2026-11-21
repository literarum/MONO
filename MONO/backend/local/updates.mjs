// Update check: one request to the release feed per launch (no user data is sent).
// A newer release is offered in the app; the installer upgrades in place and keeps
// the archive, settings and Groq key (same Inno Setup AppId). MONO_UPDATE_CHECK=0 disables it.
export const DEFAULT_FEED='https://api.github.com/repos/literarum/MONO/releases/latest';
const parts=v=>String(v||'').replace(/^v/i,'').split(/[.+-]/).slice(0,3).map(n=>Number.parseInt(n,10)||0);
export function newer(candidate,current){const a=parts(candidate),b=parts(current);for(let i=0;i<3;i++){if(a[i]!==b[i])return a[i]>b[i]}return false}
export async function checkUpdate({current,feed=process.env.MONO_UPDATE_URL||DEFAULT_FEED,fetch:get=globalThis.fetch,enabled=process.env.MONO_UPDATE_CHECK!=='0'}={}){
 if(!enabled||!get)return null;
 try{
  const response=await get(feed,{headers:{Accept:'application/vnd.github+json','User-Agent':'MONO-Transcribe-update-check'},signal:AbortSignal.timeout(8000)});
  if(!response.ok)return null;const release=await response.json();
  if(release.draft||release.prerelease||!newer(release.tag_name,current))return null;
  const asset=(release.assets||[]).find(a=>/^MONO-Setup-.*\.exe$/i.test(a.name));
  const url=asset?.browser_download_url||release.html_url;if(!/^https:\/\//.test(url||''))return null;
  return {version:String(release.tag_name).replace(/^v/i,''),url,notes:String(release.name||'').slice(0,200)};
 }catch{return null}
}
