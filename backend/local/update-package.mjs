// Offline updates: a single signed file, no server.
//
//   .monoupdate = "MONOUPD1" | uint32 manifest length | manifest (UTF-8 JSON) | 64-byte Ed25519
//                 signature of the manifest | the files' bytes, in manifest order
//
// The manifest lists every file of the new app/ folder with its size and SHA-256, so the signature
// covers every byte. MONO verifies the signature with the public key it ships with, checks each
// file's hash while unpacking into updates/staging, and only then marks it ready. The small
// MONO.exe swaps app/ for the ready folder on the next start (and rolls back if it cannot).
import {createReadStream} from 'node:fs';import {open,mkdir,rm,rename,writeFile,readFile,stat} from 'node:fs/promises';
import {createHash,createPublicKey,verify,sign,createPrivateKey} from 'node:crypto';import path from 'node:path';

export const MAGIC=Buffer.from('MONOUPD1');
export const FORMAT='mono-update-1';
const MAX_MANIFEST=8*1024**2,MAX_FILES=20000,MAX_TOTAL=4*1024**3;

export function compareVersions(a,b){const x=String(a).split('.').map(Number),y=String(b).split('.').map(Number);for(let i=0;i<Math.max(x.length,y.length);i++){const d=(x[i]||0)-(y[i]||0);if(d)return Math.sign(d)}return 0}
const fail=(code,message)=>Object.assign(new Error(message),{code});

/** A file path inside the package: relative, forward slashes, no '..', no drive, no control characters. */
export function safeRelative(value){
 if(typeof value!=='string'||!value||value.length>400||/[\0-\x1f\\:*?"<>|]/.test(value)||value.startsWith('/'))return false;
 return value.split('/').every(part=>part&&part!=='.'&&part!=='..'&&!/[. ]$/.test(part));
}
export function validManifest(manifest,{current}={}){
 if(!manifest||manifest.format!==FORMAT||typeof manifest.version!=='string'||!/^\d+\.\d+\.\d+$/.test(manifest.version))return 'Это не файл обновления MONO';
 if(!Array.isArray(manifest.files)||!manifest.files.length||manifest.files.length>MAX_FILES)return 'Файл обновления повреждён';
 let total=0;const seen=new Set();
 for(const file of manifest.files){
  if(!safeRelative(file?.path)||seen.has(file.path.toLowerCase())||!Number.isSafeInteger(file.size)||file.size<0||!/^[a-f0-9]{64}$/.test(file.sha256))return 'Файл обновления повреждён';
  seen.add(file.path.toLowerCase());total+=file.size;
 }
 if(total>MAX_TOTAL)return 'Файл обновления слишком большой';
 if(!manifest.files.some(file=>file.path==='launcher/mono_launcher.py')||!manifest.files.some(file=>file.path==='server.mjs'))return 'В обновлении нет частей приложения';
 if(current&&compareVersions(manifest.version,current)<=0)return `Это не новая версия: установлена ${current}, в файле ${manifest.version}`;
 return null;
}

/** Build a package from a folder (used by the release script and tests). */
export async function buildPackage({root,files,version,privateKeyPem,output}){
 const entries=[];for(const relative of files){const full=path.join(root,...relative.split('/'));const bytes=await readFile(full);entries.push({path:relative,size:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex'),bytes})}
 const manifest=Buffer.from(JSON.stringify({format:FORMAT,version,createdAt:new Date().toISOString(),files:entries.map(({bytes,...rest})=>rest)}));
 const signature=sign(null,manifest,createPrivateKey(privateKeyPem));const length=Buffer.alloc(4);length.writeUInt32BE(manifest.length);
 await writeFile(output,Buffer.concat([MAGIC,length,manifest,signature,...entries.map(entry=>entry.bytes)]));
}

async function readExactly(handle,position,length){const buffer=Buffer.alloc(length);const {bytesRead}=await handle.read(buffer,0,length,position);if(bytesRead!==length)throw fail('UPDATE_DAMAGED','Файл обновления обрезан');return buffer}

/** Read and verify the header. Returns {manifest, dataOffset}. */
export async function readHeader(file,{publicKeyPem,current}){
 if(!publicKeyPem)throw fail('UPDATE_KEY_MISSING','В этой сборке не настроена подпись обновлений: файл обновления не может быть проверен');
 const handle=await open(file,'r');
 try{
  if(!(await readExactly(handle,0,8)).equals(MAGIC))throw fail('UPDATE_INVALID','Это не файл обновления MONO');
  const length=(await readExactly(handle,8,4)).readUInt32BE();if(!length||length>MAX_MANIFEST)throw fail('UPDATE_INVALID','Файл обновления повреждён');
  const bytes=await readExactly(handle,12,length),signature=await readExactly(handle,12+length,64);
  let ok=false;try{ok=verify(null,bytes,createPublicKey(publicKeyPem),signature)}catch{ok=false}
  if(!ok)throw fail('UPDATE_SIGNATURE','Подпись файла обновления не подтверждена: файл изменён или выпущен не автором MONO');
  let manifest;try{manifest=JSON.parse(bytes.toString('utf8'))}catch{throw fail('UPDATE_INVALID','Файл обновления повреждён')}
  const problem=validManifest(manifest,{current});if(problem)throw fail(problem.startsWith('Это не новая')?'UPDATE_NOT_NEWER':'UPDATE_INVALID',problem);
  const expected=12+length+64+manifest.files.reduce((sum,entry)=>sum+entry.size,0);if((await handle.stat()).size!==expected)throw fail('UPDATE_DAMAGED','Файл обновления обрезан или дополнен');
  return {manifest,dataOffset:12+length+64};
 }finally{await handle.close()}
}

/** Verify and unpack into <home>/updates/ready/app. Returns {version}. Nothing is left half-written. */
export async function stageUpdate(file,{home,publicKeyPem,current}){
 const {manifest,dataOffset}=await readHeader(file,{publicKeyPem,current});
 const updates=path.join(home,'updates'),staging=path.join(updates,'staging'),ready=path.join(updates,'ready');
 await rm(staging,{recursive:true,force:true});await mkdir(path.join(staging,'app'),{recursive:true});
 try{
  let offset=dataOffset;
  for(const entry of manifest.files){
   const target=path.join(staging,'app',...entry.path.split('/'));await mkdir(path.dirname(target),{recursive:true});
   const out=await open(target,'wx');const hash=createHash('sha256');let written=0;
   try{if(entry.size)for await(const chunk of createReadStream(file,{start:offset,end:offset+entry.size-1})){hash.update(chunk);let at=0;while(at<chunk.length){const {bytesWritten}=await out.write(chunk,at,chunk.length-at);at+=bytesWritten}written+=chunk.length}await out.sync()}finally{await out.close()}
   if(written!==entry.size||hash.digest('hex')!==entry.sha256)throw fail('UPDATE_DAMAGED',`Файл обновления повреждён (${entry.path})`);
   offset+=entry.size;
  }
  await writeFile(path.join(staging,'READY'),JSON.stringify({version:manifest.version,files:manifest.files.length,stagedAt:new Date().toISOString()}));
  await rm(ready,{recursive:true,force:true});await rename(staging,ready);
  return {version:manifest.version,files:manifest.files.length};
 }catch(error){await rm(staging,{recursive:true,force:true});throw error}
}

/** What the launcher will do on the next start, and what it last did. */
export async function updateStatus(home){
 const read=async name=>{try{return JSON.parse(await readFile(path.join(home,'updates',name),'utf8'))}catch{return null}};
 const ready=await read('ready/READY'),applied=await read('applied.json');
 let readyOk=false;if(ready){try{readyOk=(await stat(path.join(home,'updates','ready','app'))).isDirectory()}catch{}}
 return {pending:readyOk?ready.version:null,applied};
}
