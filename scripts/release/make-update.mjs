// Build a signed update file from a staged app folder.
//   MONO_UPDATE_SIGNING_KEY="<pem>" node scripts/release/make-update.mjs <app folder> <version> <output.monoupdate>
import {readdirSync,statSync} from 'node:fs';import path from 'node:path';import {buildPackage} from '../../backend/local/update-package.mjs';
const [root,version,output]=process.argv.slice(2);const key=process.env.MONO_UPDATE_SIGNING_KEY;
if(!root||!version||!output){console.error('usage: make-update.mjs <app folder> <version> <output>');process.exit(2)}
if(!key){console.error('MONO_UPDATE_SIGNING_KEY is not set: an unsigned update would be refused by MONO, so none is built.');process.exit(3)}
const files=[];const walk=dir=>{for(const name of readdirSync(dir)){const full=path.join(dir,name);const rel=path.relative(root,full).split(path.sep).join('/');if(/(^|\/)(__pycache__|\.git|node_modules)(\/|$)/.test(rel))continue;statSync(full).isDirectory()?walk(full):files.push(rel)}};walk(root);
await buildPackage({root,files,version,privateKeyPem:key,output});console.log(`${output}: ${files.length} files, version ${version}`);
