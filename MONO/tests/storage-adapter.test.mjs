import test from 'node:test';import assert from 'node:assert/strict';import {pathToFileURL} from 'node:url';import {localServer,wavFixture} from './helpers/local-server.mjs';
test('desktop facade never opens IndexedDB and uses the chosen file library',async t=>{
 const server=await localServer(t),nativeFetch=globalThis.fetch;let cookie='',idbCalls=0;
 globalThis.indexedDB={open(){idbCalls++;throw new Error('Desktop must not open IndexedDB')}};
 globalThis.fetch=async(route,options={})=>{const headers=new Headers(options.headers);headers.set('Origin',server.url);if(cookie)headers.set('Cookie',cookie);const response=await nativeFetch(new URL(route,server.url),{...options,headers});if(response.headers.get('set-cookie'))cookie=response.headers.get('set-cookie').split(';')[0];return response};
 t.after(()=>{globalThis.fetch=nativeFetch;delete globalThis.indexedDB});
 const db=await import(process.env.MONO_DB_MODULE?pathToFileURL(process.env.MONO_DB_MODULE).href:'../public/db.js');
 await db.openDB();assert.equal(db.storageDetails().local,true);assert.deepEqual(await db.listRecordings(),[]);
 await db.configureLibrary({useDefault:true});const id=crypto.randomUUID();
 await db.saveImportedRecording({id,title:'Файловый архив',mime:'audio/wav',duration:.1,status:'saved'},new Blob([wavFixture()]));
 assert.equal((await db.listRecordings())[0].id,id);assert.match(db.audioURL(id),/\/audio\?variant=original$/);
 await assert.rejects(db.getBlob({id}),{code:'STREAM_REQUIRED'});assert.equal(idbCalls,0);
 const deleted=await db.removeRecording(id);assert.deepEqual(await db.listRecordings(),[]);await db.restoreRecording(id,deleted.version);assert.equal((await db.listRecordings()).length,1);
});
