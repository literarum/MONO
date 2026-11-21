import test from 'node:test';import assert from 'node:assert/strict';import {mkdtemp,rm,mkdir,writeFile,readFile,stat} from 'node:fs/promises';import {tmpdir} from 'node:os';import path from 'node:path';import {generateKeyPairSync} from 'node:crypto';
import {buildPackage,stageUpdate,readHeader,updateStatus,safeRelative,compareVersions,validManifest,FORMAT} from '../backend/local/update-package.mjs';
import {localServer} from './helpers/local-server.mjs';import {LibraryClient} from '../public/library-client.js';
const keys=()=>{const {publicKey,privateKey}=generateKeyPairSync('ed25519');return {pub:publicKey.export({type:'spki',format:'pem'}),priv:privateKey.export({type:'pkcs8',format:'pem'})}};
async function app(dir,version='9.9.9'){const root=path.join(dir,'app');for(const [rel,text] of [['server.mjs','// server'],['launcher/mono_launcher.py','# launcher'],['package.json',JSON.stringify({version})],['public/index.html','<!doctype html>']]){const full=path.join(root,...rel.split('/'));await mkdir(path.dirname(full),{recursive:true});await writeFile(full,text)}return {root,files:['server.mjs','launcher/mono_launcher.py','package.json','public/index.html']}}

test('versions, paths and manifests are checked strictly',()=>{
 assert.equal(compareVersions('0.9.1','0.9.0'),1);assert.equal(compareVersions('0.10.0','0.9.9'),1);assert.equal(compareVersions('1.0.0','1.0.0'),0);
 for(const bad of ['../x','a/../b','/abs','C:/x','a\\b','a/./b','a/b.','','a//b'])assert.equal(safeRelative(bad),false,bad);
 assert.equal(safeRelative('public/ui/refine.css'),true);
 const files=[{path:'server.mjs',size:1,sha256:'a'.repeat(64)},{path:'launcher/mono_launcher.py',size:1,sha256:'b'.repeat(64)}];
 assert.equal(validManifest({format:FORMAT,version:'1.0.0',files}),null);
 assert.match(validManifest({format:FORMAT,version:'1.0.0',files:[...files,{path:'../evil',size:1,sha256:'c'.repeat(64)}]}),/повреждён/);
 assert.match(validManifest({format:FORMAT,version:'0.9.0',files},{current:'0.9.0'}),/не новая версия/);
});
test('a signed package is verified, unpacked byte for byte and marked ready; tampering and foreign keys are refused',async t=>{
 const dir=await mkdtemp(path.join(tmpdir(),'mono-update-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const {pub,priv}=keys(),other=keys(),{root,files}=await app(dir),file=path.join(dir,'u.monoupdate'),home=path.join(dir,'home');
 await buildPackage({root,files,version:'9.9.9',privateKeyPem:priv,output:file});
 await assert.rejects(stageUpdate(file,{home,publicKeyPem:other.pub,current:'0.9.0'}),e=>e.code==='UPDATE_SIGNATURE','another key');
 await assert.rejects(stageUpdate(file,{home,publicKeyPem:null,current:'0.9.0'}),e=>e.code==='UPDATE_KEY_MISSING');
 await assert.rejects(stageUpdate(file,{home,publicKeyPem:pub,current:'9.9.9'}),e=>e.code==='UPDATE_NOT_NEWER');
 const result=await stageUpdate(file,{home,publicKeyPem:pub,current:'0.9.0'});assert.deepEqual(result,{version:'9.9.9',files:4});
 assert.equal(await readFile(path.join(home,'updates','ready','app','launcher','mono_launcher.py'),'utf8'),'# launcher');
 assert.deepEqual((await updateStatus(home)).pending,'9.9.9');
 // A changed byte in the file bodies: the signature still matches the manifest, the hash does not.
 const bytes=await readFile(file);bytes[bytes.length-3]^=1;await writeFile(file,bytes);
 await assert.rejects(stageUpdate(file,{home,publicKeyPem:pub,current:'0.9.0'}),e=>e.code==='UPDATE_DAMAGED');
 assert.equal((await updateStatus(home)).pending,'9.9.9','a refused file never replaces the verified one');
 await writeFile(file,bytes.subarray(0,bytes.length-5));await assert.rejects(readHeader(file,{publicKeyPem:pub,current:'0.9.0'}),e=>e.code==='UPDATE_DAMAGED');
 await writeFile(file,Buffer.from('not an update'));await assert.rejects(readHeader(file,{publicKeyPem:pub}),e=>e.code==='UPDATE_INVALID');
});
test('HTTP: Settings uploads a signed update; the server stages it and reports it pending',async t=>{
 const dir=await mkdtemp(path.join(tmpdir(),'mono-update-http-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const {pub,priv}=keys(),keyFile=path.join(dir,'key.pem');await writeFile(keyFile,pub);const home=path.join(dir,'home');await mkdir(home);
 const {root,files}=await app(dir),file=path.join(dir,'u.monoupdate');await buildPackage({root,files,version:'9.9.9',privateKeyPem:priv,output:file});
 const server=await localServer(t,{MONO_LAUNCHER_HOME:home,MONO_UPDATE_KEY_FILE:keyFile});
 let cookie='';const client=new LibraryClient({fetch:async(route,options={})=>{const headers=new Headers(options.headers);headers.set('Origin',server.url);if(cookie)headers.set('Cookie',cookie);const r=await fetch(new URL(route,server.url),{...options,headers});if(r.headers.get('set-cookie'))cookie=r.headers.get('set-cookie').split(';')[0];return r}});await client.init();
 const before=await client.json('/update');assert.equal(before.signed,true);assert.equal(before.supported,true);assert.equal(before.pending,null);assert.match(before.version,/^\d+\.\d+\.\d+$/);
 const result=await client.json('/update',{method:'POST',body:new Blob([await readFile(file)]),headers:{'Content-Type':'application/octet-stream'}});
 assert.equal(result.version,'9.9.9');assert.equal(result.restartNeeded,true);assert.equal((await client.json('/update')).pending,'9.9.9');
 await assert.rejects(client.json('/update',{method:'POST',body:new Blob([Buffer.from('MONOUPD1junk')]),headers:{'Content-Type':'application/octet-stream'}}),e=>e.status===400);
 await assert.rejects(stat(path.join(home,'updates','incoming.part')));
});
