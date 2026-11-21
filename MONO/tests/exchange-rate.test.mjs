import test from 'node:test';import assert from 'node:assert/strict';import {mkdtemp,rm,readFile} from 'node:fs/promises';import {tmpdir} from 'node:os';import path from 'node:path';
import {ExchangeRate,parseRate,REFRESH_MS} from '../backend/local/exchange-rate.mjs';
const XML='<?xml version="1.0" encoding="windows-1251"?><ValCurs Date="21.11.2026" name="Foreign Currency Market"><Valute ID="R01235"><NumCode>840</NumCode><CharCode>USD</CharCode><Nominal>1</Nominal><Name>Доллар США</Name><Value>81,4567</Value></Valute></ValCurs>';
test('the Bank of Russia XML and its JSON mirror are read; nonsense is refused',()=>{
 const cbr={parse:text=>{const block=/<Valute ID="R01235">([\s\S]*?)<\/Valute>/.exec(text)?.[1];const value=Number(/<Value>([\d,]+)<\/Value>/.exec(block)?.[1]?.replace(',','.'));return {rate:value,date:/Date="([^"]+)"/.exec(text)[1]}}};
 assert.deepEqual(parseRate(cbr,XML),{rate:81.4567,date:'21.11.2026'});
 assert.equal(parseRate({parse:()=>({rate:0.5})},''),null);assert.equal(parseRate({parse:()=>{throw new Error()}},''),null);
});
test('refreshes every six hours, falls back to the mirror, keeps the last rate offline, and stores it',async t=>{
 const dir=await mkdtemp(path.join(tmpdir(),'mono-rate-'));t.after(()=>rm(dir,{recursive:true,force:true}));let now=Date.parse('2026-11-21T10:00:00Z'),calls=[];
 const fetcher=async url=>{calls.push(url);if(url.includes('cbr.ru/scripts'))return {ok:false};return {ok:true,headers:new Headers({'content-type':'application/json'}),arrayBuffer:async()=>new TextEncoder().encode(JSON.stringify({Date:'2026-11-21T11:30:00+03:00',Valute:{USD:{Nominal:1,Value:82.5}}})).buffer}};
 const rate=new ExchangeRate({file:path.join(dir,'rate.json'),fetcher,now:()=>now});
 const first=await rate.refresh();assert.equal(first.usdRub,82.5);assert.match(first.source,/зеркало/);assert.equal(calls.length,2);
 await rate.refresh();assert.equal(calls.length,2,'fresh for six hours');
 now+=REFRESH_MS+1;const offline=new ExchangeRate({file:path.join(dir,'rate.json'),fetcher:async()=>{throw new Error('offline')},now:()=>now});await offline.load();
 assert.equal((await offline.refresh()).usdRub,82.5,'the last known rate stays');assert.equal(JSON.parse(await readFile(path.join(dir,'rate.json'),'utf8')).usdRub,82.5);
});
