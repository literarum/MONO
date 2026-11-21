// USD → RUB for the cost estimates: the Bank of Russia's official daily rate, refreshed every six
// hours (and at start). Only the public rate page is fetched — nothing about the person is sent.
// Sources: https://cbr.ru/development/SXML/ (XML_daily.asp, USD = R01235); a JSON mirror of the
// same data (cbr-xml-daily.ru) is used if the Bank's site does not answer.
import {readFile,writeFile,mkdir} from 'node:fs/promises';import path from 'node:path';
export const REFRESH_MS=6*3600*1000;
const SOURCES=[
 {name:'Банк России',url:'https://www.cbr.ru/scripts/XML_daily.asp',parse:text=>{const block=/<Valute ID="R01235">([\s\S]*?)<\/Valute>/.exec(text)?.[1];if(!block)return null;const value=Number(/<Value>([\d,]+)<\/Value>/.exec(block)?.[1]?.replace(',','.'));const nominal=Number(/<Nominal>(\d+)<\/Nominal>/.exec(block)?.[1]||1);const date=/Date="(\d\d\.\d\d\.\d{4})"/.exec(text)?.[1]||null;return Number.isFinite(value)&&nominal>0?{rate:value/nominal,date}:null}},
 {name:'Банк России (зеркало cbr-xml-daily.ru)',url:'https://www.cbr-xml-daily.ru/daily_json.js',parse:text=>{const data=JSON.parse(text);const usd=data?.Valute?.USD;return usd&&Number.isFinite(usd.Value)&&usd.Nominal>0?{rate:usd.Value/usd.Nominal,date:String(data.Date||'').slice(0,10)}:null}}
];
export function parseRate(source,text){try{const found=source.parse(text);return found&&found.rate>1&&found.rate<1000?found:null}catch{return null}}
export class ExchangeRate{
 constructor({file,fetcher=globalThis.fetch,now=()=>Date.now(),sources=SOURCES}){Object.assign(this,{file,fetcher,now,sources});this.value=null;this.timer=null}
 async load(){try{this.value=JSON.parse(await readFile(this.file,'utf8'))}catch{this.value=null}return this.value}
 fresh(){return this.value&&this.now()-Date.parse(this.value.fetchedAt)<REFRESH_MS}
 async refresh({force=false}={}){
  if(!force&&this.fresh())return this.value;
  for(const source of this.sources){
   try{const response=await this.fetcher(source.url,{signal:AbortSignal.timeout(12000),headers:{'Accept':'*/*'}});if(!response.ok)continue;
    const buffer=Buffer.from(await response.arrayBuffer());const text=/windows-1251/i.test(response.headers.get('content-type')||'')||/encoding="windows-1251"/i.test(buffer.subarray(0,120).toString('latin1'))?new TextDecoder('windows-1251').decode(buffer):buffer.toString('utf8');
    const found=parseRate(source,text);if(!found)continue;
    this.value={usdRub:Math.round(found.rate*10000)/10000,date:found.date,source:source.name,fetchedAt:new Date(this.now()).toISOString()};
    await mkdir(path.dirname(this.file),{recursive:true});await writeFile(this.file,JSON.stringify(this.value),{mode:0o600});return this.value;
   }catch{/* next source */}
  }
  return this.value; // offline: the last known rate stays
 }
 start(){if(this.timer)return;void this.load().then(()=>this.refresh());this.timer=setInterval(()=>void this.refresh({force:true}),REFRESH_MS);this.timer.unref?.()}
 stop(){clearInterval(this.timer);this.timer=null}
}
