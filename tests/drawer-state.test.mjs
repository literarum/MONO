import test from 'node:test';import assert from 'node:assert/strict';
const m=await import('../public/ui/drawer-model.js').catch(()=>({}));
test('drawer closes for outside, escape, navigation and desktop resize; inside is stable',()=>{
 assert.equal(typeof m.drawerTransition,'function');
 assert.equal(m.drawerTransition(false,'toggle',768),true);assert.equal(m.drawerTransition(true,'inside',768),true);
 for(const reason of ['outside','escape','route'])assert.equal(m.drawerTransition(true,reason,768),false);
 assert.equal(m.drawerTransition(true,'resize',991),false);assert.equal(m.drawerTransition(true,'resize',989),true);
 assert.equal(m.drawerTransition(false,'toggle',1440),false);
});
