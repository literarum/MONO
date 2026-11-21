import test from 'node:test';
import assert from 'node:assert/strict';
import {audioExtension,validBackupItem,portableRecord} from '../public/backup-core.js';

test('backup audio extension reflects stored MIME',()=>{
  for(const [mime,ext] of [['audio/webm','webm'],['audio/wav','wav'],['audio/mpeg','mp3'],
    ['audio/mp4','m4a'],['audio/aac','aac'],['audio/ogg','ogg'],['audio/flac','flac']]){
    assert.equal(audioExtension(mime),ext);
  }
});
test('portable import rejects path traversal and mismatched IDs',()=>{
 const id='123e4567-e89b-12d3-a456-426614174000';
 const valid={record:{id},audio:`${id}.webm`};
 assert.equal(validBackupItem(valid),true);
 assert.equal(validBackupItem({record:{id},audio:'../../private.key'}),false);
 assert.equal(validBackupItem({record:{id},audio:'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa.webm'}),false);
 assert.equal(validBackupItem(null),false);
});
test('restoration never overwrites ID or resumes an old paid job',()=>{
 const id='123e4567-e89b-12d3-a456-426614174000';
 const next='123e4567-e89b-12d3-a456-426614174001';
 const original={id,title:'Пример',status:'queued',jobId:'a',clientKey:'secret-key',
                 job:{status:'processing'},serverAcked:false,transcript:'Привет'};
 const imported=portableRecord(original,next);
 assert.equal(imported.id,next);
 assert.equal(imported.status,'interrupted');
 assert.equal(imported.jobId,undefined);
 assert.equal(imported.clientKey,undefined);
 assert.equal(imported.transcript,'Привет');
 assert.equal(original.jobId,'a');
});
