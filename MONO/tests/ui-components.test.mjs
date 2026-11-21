import test from 'node:test';import assert from 'node:assert/strict';
const m=await import('../public/ui/select-model.js').catch(()=>({}));
const options=[{label:'Альфа',disabled:false},{label:'Бета',disabled:true},{label:'Язык',disabled:false}];
test('select keyboard skips disabled options, clamps boundaries and supports Cyrillic search',()=>{
 assert.equal(typeof m.nextOption,'function','Select model is missing');
 assert.equal(m.nextOption(options,0,'ArrowDown'),2);assert.equal(m.nextOption(options,2,'ArrowDown'),2);
 assert.equal(m.nextOption(options,2,'Home'),0);assert.equal(m.nextOption(options,0,'End'),2);
 assert.equal(m.findOption(options,'я',0),2);assert.equal(m.findOption(options,'б',0),-1);
});
test('empty and fully disabled selects have no selectable active option',()=>{
 assert.equal(typeof m.nextOption,'function');assert.equal(m.nextOption([],0,'Home'),-1);
 assert.equal(m.nextOption([{disabled:true}],0,'End'),-1);
});
