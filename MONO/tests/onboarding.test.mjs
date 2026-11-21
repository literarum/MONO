import test from 'node:test';import assert from 'node:assert/strict';
let nextSetupStep;try{({nextSetupStep}=await import('../public/onboarding-model.js'))}catch{}
test('first run resumes from folder/key/sound progress while key skip never grants verified status',()=>{
 assert.ok(nextSetupStep,'Resumable setup model is missing');
 assert.equal(nextSetupStep({library:{libraryConfigured:false,libraryAvailable:false},key:{configured:false},progress:{completed:false,keySkipped:false}}),'folder');
 assert.equal(nextSetupStep({library:{libraryConfigured:true,libraryAvailable:false},key:{configured:true},progress:{completed:true}}),'reconnect');
 assert.equal(nextSetupStep({library:{libraryConfigured:true,libraryAvailable:true},key:{configured:false},progress:{completed:false,keySkipped:false}}),'key');
 assert.equal(nextSetupStep({library:{libraryConfigured:true,libraryAvailable:true},key:{configured:false},progress:{completed:false,keySkipped:true}}),'sound');
 assert.equal(nextSetupStep({library:{libraryConfigured:true,libraryAvailable:true},key:{configured:true},progress:{completed:false}}),'sound');
 assert.equal(nextSetupStep({library:{libraryConfigured:true,libraryAvailable:true},key:{configured:false},progress:{completed:true,keySkipped:true,soundTested:false}}),null);
});
