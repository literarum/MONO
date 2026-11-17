import test from 'node:test';import assert from 'node:assert/strict';import * as capture from '../public/capture-client.js';
test('no confirmed audio never claims preserved fragments, even with a nonzero elapsed duration',()=>{
 assert.equal(typeof capture.captureFailureMessage,'function');
 const text=capture.captureFailureMessage({errorCode:'INTERNAL',savedBytes:0,savedFrames:0,duration:5});assert.match(text,/не нач|не удалось/i);assert.doesNotMatch(text,/фрагменты (?:остались|сохранены)|подтверждённые фрагменты сохранены/i);
});
test('confirmed partial audio and missing confirmation have different recovery messages',()=>{
 assert.equal(typeof capture.captureFailureMessage,'function');
 const saved=capture.captureFailureMessage({errorCode:'INTERNAL',savedBytes:128});assert.match(saved,/подтверждённые фрагменты сохранены/i);
 const unknown=capture.captureFailureMessage({errorCode:'ARCHIVE_SAVE_FAILED'});assert.match(unknown,/сохранение аудио не подтверждено/i);assert.notEqual(saved,unknown);
});
