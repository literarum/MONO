// Windows CI: the whole offline update path on a real portable MONO.
//   node scripts/ci/update-roundtrip.mjs <portable folder>
// 1. A throwaway key pair; its public key goes into the portable app (as a release key would).
// 2. A signed update to version current+0.0.1 is built from a copy of the app.
// 3. MONO.exe starts MONO; the update is uploaded through the same API Settings uses.
// 4. MONO.exe starts again: it must swap app/ for the verified folder and record applied.json.
import {generateKeyPairSync} from 'node:crypto';import {spawn} from 'node:child_process';import {cp,readFile,writeFile,readdir,stat,rm} from 'node:fs/promises';import path from 'node:path';import os from 'node:os';
import {buildPackage} from '../../backend/local/update-package.mjs';

const portable=path.resolve(process.argv[2]);const exe=path.join(portable,'MONO.exe'),app=path.join(portable,'app'),base='http://127.0.0.1:4173';
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const {publicKey,privateKey}=generateKeyPairSync('ed25519');
await writeFile(path.join(app,'backend','local','update-key.pem'),publicKey.export({type:'spki',format:'pem'}));
const current=JSON.parse(await readFile(path.join(app,'package.json'),'utf8')).version,[a,b,c]=current.split('.').map(Number),next=`${a}.${b}.${c+1}`;
const copy=path.join(os.tmpdir(),'mono-next-app');await rm(copy,{recursive:true,force:true});await cp(app,copy,{recursive:true});
const pkg=JSON.parse(await readFile(path.join(copy,'package.json'),'utf8'));pkg.version=next;await writeFile(path.join(copy,'package.json'),JSON.stringify(pkg,null,2));
const files=[];const walk=async dir=>{for(const name of await readdir(dir)){const full=path.join(dir,name),rel=path.relative(copy,full).split(path.sep).join('/');if(/__pycache__/.test(rel))continue;(await stat(full)).isDirectory()?await walk(full):files.push(rel)}};await walk(copy);
const update=path.join(os.tmpdir(),`MONO-update-${next}.monoupdate`);await buildPackage({root:copy,files,version:next,privateKeyPem:privateKey.export({type:'pkcs8',format:'pem'}),output:update});
console.log(`update ${current} → ${next}: ${files.length} files`);

const env={...process.env,Path:`${process.env.SystemRoot}\\system32;${process.env.SystemRoot}`};delete env.MONO_HOME;
async function run(hold){spawn(exe,['--smoke','--smoke-hold',String(hold)],{env,detached:true,stdio:'ignore'}).unref();for(let i=0;i<90;i++){await sleep(1000);try{const r=await fetch(base+'/api/health');if(r.ok)return await r.json()}catch{}}throw new Error('MONO did not start')}
async function stopped(){for(let i=0;i<120;i++){await sleep(1000);try{await fetch(base+'/api/health')}catch{return}}throw new Error('MONO did not stop')}

const first=await run(45);if(first.version!==current)throw new Error(`expected ${current}, got ${first.version}`);
const session=await fetch(base+'/api/local/session'),cookie=session.headers.get('set-cookie').split(';')[0],{csrf}=await session.json();
const headers={Cookie:cookie,Origin:base,'X-Mono-CSRF':csrf};
const tampered=Buffer.from(await readFile(update));tampered[tampered.length-2]^=1;
const refused=await fetch(base+'/api/local/update',{method:'POST',headers:{...headers,'Content-Type':'application/octet-stream'},body:tampered});
if(refused.status!==400)throw new Error('a tampered update was not refused: '+refused.status);
const accepted=await fetch(base+'/api/local/update',{method:'POST',headers:{...headers,'Content-Type':'application/octet-stream'},body:await readFile(update)});
const staged=await accepted.json();console.log('staged',JSON.stringify(staged));if(!accepted.ok||staged.version!==next)throw new Error('update was not staged');
await stopped();
const second=await run(10);console.log('after restart',second.version);
const applied=JSON.parse(await readFile(path.join(portable,'MONO-DATA','updates','applied.json'),'utf8'));console.log('applied',JSON.stringify(applied));
if(second.version!==next||applied.result!=='ok'||applied.version!==next)throw new Error('MONO.exe did not apply the update');
if(!(await stat(path.join(portable,'app.previous'))).isDirectory())throw new Error('the previous version was not kept for rollback');
await stopped();console.log('offline update: verified, staged, applied, previous kept');
