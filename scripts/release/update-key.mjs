// One-time: create the key pair that signs MONO update files.
//   node scripts/release/update-key.mjs
// Writes backend/local/update-key.pem (public, commit it) and prints where the private key went.
// Put the private key into the repository secret MONO_UPDATE_SIGNING_KEY; never commit it.
import {generateKeyPairSync} from 'node:crypto';import {writeFileSync,existsSync,mkdirSync} from 'node:fs';import path from 'node:path';import os from 'node:os';
const pub=path.resolve('backend/local/update-key.pem');
if(existsSync(pub)&&!process.argv.includes('--force')){console.error('backend/local/update-key.pem already exists (use --force to replace it: older MONO builds will then refuse new updates).');process.exit(1)}
const {publicKey,privateKey}=generateKeyPairSync('ed25519');
writeFileSync(pub,publicKey.export({type:'spki',format:'pem'}));
const dir=path.join(os.homedir(),'.mono-release');mkdirSync(dir,{recursive:true,mode:0o700});const secret=path.join(dir,'update-signing-key.pem');
writeFileSync(secret,privateKey.export({type:'pkcs8',format:'pem'}),{mode:0o600});
console.log(`Public key: ${pub} — commit it.\nPrivate key: ${secret} — add its contents as the repository secret MONO_UPDATE_SIGNING_KEY, keep a backup offline, never commit it.`);
