import {readdir} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import path from 'node:path';
async function walk(dir){
 const out=[];
 for(const e of await readdir(dir,{withFileTypes:true})){
  const p=path.join(dir,e.name);if(e.isDirectory())out.push(...await walk(p));else if(/\.(m?js)$/.test(p))out.push(p);
 }return out;
}
const files=['server.mjs','core.mjs','healthcheck.mjs',...await walk('public')];
try{files.push(...await walk('backend'))}catch(e){if(e.code!=='ENOENT')throw e}
for(const file of files){const r=spawnSync(process.execPath,['--check',file],{stdio:'inherit'});if(r.status!==0)process.exit(r.status||1)}
console.log(`PASS: syntax checked ${files.length} source modules`);
