import test from 'node:test';import assert from 'node:assert/strict';
let captureSelection,selectionKey;try{({captureSelection,selectionKey}=await import('../public/transcription-selection.js'))}catch{}
test('cloud confirmation freezes the currently audible record/version and settings; identity binds all submitted choices',async()=>{
 assert.equal(typeof captureSelection,'function','confirmation selection is missing');const settings={profile:'standard',prompt:'Согласованный контекст'},review={selected:{recordId:'record-a',versionId:'a'.repeat(64),profile:'level',title:'Выровнять голос'}};
 const selection=captureSelection('record-a',review.selected,settings);settings.profile='enhanced';settings.prompt='Другой';review.selected.versionId='b'.repeat(64);
 assert.equal(selection.preparedVersionId,'a'.repeat(64));assert.equal(selection.profile,'standard');assert.equal(selection.prompt,'Согласованный контекст');assert.equal(selection.title,'Выровнять голос');assert.ok(Object.isFrozen(selection));
 const original=captureSelection('record-b',review.selected,settings);assert.equal(original.preparedVersionId,undefined);assert.equal(original.title,'Оригинал');assert.notEqual(await selectionKey('record-a',selection),await selectionKey('record-a',original));
 assert.equal(await selectionKey('record-a',selection),await selectionKey('record-a',{...selection,title:'Only display changed'}));for(const patch of [{profile:'enhanced'},{prompt:'new'},{preparedVersionId:'c'.repeat(64)}])assert.notEqual(await selectionKey('record-a',selection),await selectionKey('record-a',{...selection,...patch}));
 assert.throws(()=>captureSelection('record-a',{recordId:'record-a',versionId:'invalid'},settings));
});
