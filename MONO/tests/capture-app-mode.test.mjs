import test from 'node:test';import assert from 'node:assert/strict';
import {CaptureSources,MODES} from '../public/native-sources.js';

const library=(apps,{available=true,reason}={})=>({calls:[],async json(path,options={}){this.calls.push(path);
 if(path==='/preferences')return {capture:{mode:'app',inputId:null,outputId:null,appName:'zoom'}};
 if(path==='/capture/applications')return available?{available:true,applications:apps}:{available:false,reason,applications:[]};
 throw new Error('unexpected '+path)}});

test('«Что записывать» lists microphone, computer sound, both and a chosen application',()=>{
 assert.deepEqual(MODES.filter(mode=>!mode.optional).map(mode=>mode.name),['Микрофон','Звук компьютера','Звук компьютера + микрофон','Выбранное приложение']);
});

test('the chosen application is found by name in today\'s processes',async()=>{
 const model=new CaptureSources({},library([{processId:4242,processName:'zoom',name:'Zoom Workplace',title:''}]));
 model.value={mode:'app',appName:'zoom'};model.capability={modes:['browser','mic','system','both','app']};
 assert.deepEqual(await model.selection(),{mode:'app',inputId:null,outputId:null,processId:4242,appName:'Zoom Workplace'});
 const closed=new CaptureSources({},library([]));closed.value={mode:'app',appName:'zoom'};closed.capability={modes:['app']};
 assert.equal((await closed.selection()).processId,null,'a closed program is not guessed — the core asks to open it');
});

test('an unavailable mode explains itself and offers the fix',()=>{
 const model=new CaptureSources({},library([]));
 model.capability={modes:['browser','mic','system','both'],windowsBuild:19045};
 const app=model.unavailable('app');assert.match(app.text,/Windows 11/);assert.match(app.text,/19045/);assert.deepEqual(app.fix,{mode:'system'});
 assert.equal(model.unavailable('system'),null);
 globalThis.navigator??={};const agent=Object.getOwnPropertyDescriptor(globalThis.navigator,'userAgent');
 Object.defineProperty(globalThis.navigator,'userAgent',{value:'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',configurable:true});
 try{model.capability={modes:['browser']};const helper=model.unavailable('both');assert.equal(helper.install,true);assert.equal(helper.action,'Установить модуль')}
 finally{if(agent)Object.defineProperty(globalThis.navigator,'userAgent',agent);else delete globalThis.navigator.userAgent}
});
