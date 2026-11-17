// Cross-platform syntax check (npm runs scripts with cmd.exe on Windows).
import {spawnSync} from 'node:child_process';import {readdirSync,statSync} from 'node:fs';import path from 'node:path';
const roots=['server.mjs','core.mjs','healthcheck.mjs','public','backend','scripts'];
const files=[];
const walk=entry=>{const stat=statSync(entry);if(stat.isDirectory()){for(const name of readdirSync(entry))walk(path.join(entry,name))}else if(/\.(m?js)$/.test(entry))files.push(entry)};
for(const root of roots)walk(root);
let failed=0;for(const file of files){const result=spawnSync(process.execPath,['--check',file],{encoding:'utf8'});if(result.status!==0){failed++;process.stderr.write(result.stderr)}}
console.log(`${files.length-failed}/${files.length} files OK`);process.exit(failed?1:0);
