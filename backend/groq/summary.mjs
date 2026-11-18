// Meeting summary through Groq's OpenAI-compatible chat API.
// Text only, on the person's explicit request; audio never leaves for this.
// Long meetings: map (each part → notes) then reduce (notes → one summary), because a
// single prompt over a long transcript loses details and may exceed per-minute token limits.

/** Production chat models first. Preview models may disappear without notice (Groq docs),
 * so they are used only when nothing better is listed. */
const PREFERRED=[/^openai\/gpt-oss-120b$/,/^openai\/gpt-oss-20b$/,/llama-3\.3-70b/,/qwen/i,/llama/];
const NOT_CHAT=/whisper|tts|playai|guard|safeguard|distil|embed|orpheus|compound/i;
export function chooseChatModel(ids){
 const list=(ids||[]).filter(id=>typeof id==='string'&&!NOT_CHAT.test(id));
 for(const pattern of PREFERRED){const hit=list.find(id=>pattern.test(id));if(hit)return hit}
 return list[0]||null;
}

const stamp=t=>{const s=Math.max(0,Math.floor(Number(t)||0));const h=Math.floor(s/3600),m=Math.floor(s%3600/60),r=s%60;return (h?String(h)+':':'')+String(m).padStart(2,'0')+':'+String(r).padStart(2,'0')};
export function parseStamp(value){
 if(Number.isFinite(value))return Math.max(0,value);
 const match=/^\s*(?:(\d+):)?(\d{1,2}):(\d{2})\s*$/.exec(String(value??''));if(!match)return null;
 return Number(match[1]||0)*3600+Number(match[2])*60+Number(match[3]);
}
const SPEAKER={me:'Я',others:'Собеседники'};
/** Transcript lines «[mm:ss] Я: текст», split into parts of at most `maxChars`. */
export function transcriptParts(segments,maxChars=14000){
 const parts=[];let current='';
 for(const s of segments||[]){
  const text=String(s?.text||'').replace(/\s+/g,' ').trim();if(!text)continue;
  const line=`[${stamp(s.start)}] ${s.speaker&&SPEAKER[s.speaker]?SPEAKER[s.speaker]+': ':''}${text}\n`;
  if(current&&current.length+line.length>maxChars){parts.push(current);current=''}
  current+=line.length>maxChars?line.slice(0,maxChars)+'\n':line;
 }
 if(current)parts.push(current);return parts;
}

const RULES=`Ты составляешь конспект встречи по её расшифровке на русском языке.
Правила:
- Только факты из расшифровки. Ничего не додумывай. Если чего-то нет — пустой массив.
- Расшифровка сделана автоматически и может содержать ошибки распознавания; не исправляй смысл.
- Ответственный (owner) — только если он явно назван в тексте; иначе не указывай поле.
- Срок (due) — только если он явно прозвучал, словами из текста.
- Поле at — время в формате мм:сс или чч:мм:сс из квадратных скобок строки, где это прозвучало.
- Пиши кратко и конкретно, без вводных слов.
Ответ — строго JSON без пояснений:
{"overview":"2–4 предложения: о чём встреча и чем закончилась",
 "topics":[{"title":"тема","points":["ключевая мысль"],"at":"мм:сс"}],
 "decisions":[{"text":"что решили","at":"мм:сс"}],
 "actions":[{"text":"что сделать","owner":"кто","due":"когда","at":"мм:сс"}],
 "questions":[{"text":"что осталось открытым","at":"мм:сс"}]}`;

const clip=(value,limit)=>typeof value==='string'?value.replace(/\s+/g,' ').trim().slice(0,limit):'';
/** Validate a model answer into the archive shape; anything unexpected is dropped. */
export function normalizeSummary(raw,{duration=Infinity}={}){
 const value=raw&&typeof raw==='object'?raw:{};
 const at=v=>{const t=parseStamp(v);return t===null||t>duration+5?undefined:t};
 const rows=(list,map)=>(Array.isArray(list)?list:[]).slice(0,60).map(map).filter(Boolean);
 const withAt=(row,item)=>{const t=at(item?.at);if(t!==undefined)row.at=t;return row};
 const text=item=>{const t=clip(typeof item==='string'?item:item?.text,1000);return t?withAt({text:t},item):null};
 return {
  overview:clip(value.overview,4000),
  topics:rows(value.topics,item=>{const title=clip(item?.title,300);if(!title)return null;return withAt({title,points:(Array.isArray(item.points)?item.points:[]).map(p=>clip(p,600)).filter(Boolean).slice(0,12)},item)}),
  decisions:rows(value.decisions,text),
  actions:rows(value.actions,item=>{const row=text(item);if(!row)return null;const owner=clip(item?.owner,200),due=clip(item?.due,200);if(owner)row.owner=owner;if(due)row.due=due;return row}),
  questions:rows(value.questions,text)
 };
}
/** JSON from a chat answer, tolerating a fenced block or text around the object. */
export function extractJSON(content){
 const text=String(content||'').trim();
 for(const candidate of [text,text.replace(/^```(?:json)?\s*|\s*```$/g,''),text.slice(text.indexOf('{'),text.lastIndexOf('}')+1)]){try{const v=JSON.parse(candidate);if(v&&typeof v==='object')return v}catch{}}
 return null;
}

function failure(code,message,extra={}){const e=new Error(message);e.code=code;Object.assign(e,extra);return e}
const sleep=(ms,signal)=>new Promise((resolve,reject)=>{const t=setTimeout(resolve,ms);signal?.addEventListener('abort',()=>{clearTimeout(t);reject(failure('CANCELLED','Отменено'))},{once:true})});
function retryDelay(response,attempt){
 const after=Number(response.headers.get('retry-after'));if(Number.isFinite(after)&&after>=0)return Math.min(90000,after*1000+250);
 return Math.min(60000,2000*2**attempt);
}

export class Summarizer{
 constructor({getKey,base='https://api.groq.com/openai/v1',fetch=globalThis.fetch,partChars=14000,timeoutMs=120000,sleep:wait=sleep}={}){
  Object.assign(this,{getKey,base:base.replace(/\/+$/,''),fetch,partChars,timeoutMs,wait});this.models=null;
 }
 async model(signal){
  if(this.models&&Date.now()-this.models.at<6*3600e3)return this.models.id;
  let id=null;
  try{const r=await this.fetch(this.base+'/models',{headers:{Authorization:`Bearer ${await this.getKey()}`},signal:AbortSignal.any([signal||new AbortController().signal,AbortSignal.timeout(15000)])});
   if(r.ok)id=chooseChatModel(((await r.json())?.data||[]).map(m=>m?.id));
   else if(r.status===401)throw failure('INVALID_KEY','Ключ Groq не принят');}
  catch(e){if(e.code)throw e}
  id||='openai/gpt-oss-120b';this.models={id,at:Date.now()};return id;
 }
 async chat(model,messages,signal,{json=true}={}){
  for(let attempt=0;;attempt++){
   const body={model,messages,temperature:.2,max_completion_tokens:6000,...(json?{response_format:{type:'json_object'}}:{})};
   const r=await this.fetch(this.base+'/chat/completions',{method:'POST',headers:{Authorization:`Bearer ${await this.getKey()}`,'Content-Type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.any([signal||new AbortController().signal,AbortSignal.timeout(this.timeoutMs)])});
   if(r.ok){const data=await r.json();const parsed=extractJSON(data?.choices?.[0]?.message?.content);if(parsed)return {parsed,model:data.model||model};if(attempt<1)continue;throw failure('BAD_ANSWER','Модель вернула ответ не в том формате')}
   // Some models reject JSON mode (HTTP 400): ask again with the same rules but without it.
   if(r.status===400&&json){json=false;continue}
   if(r.status===401)throw failure('INVALID_KEY','Ключ Groq не принят');
   if(r.status===413)throw failure('TOO_LONG','Слишком длинный фрагмент для модели');
   if((r.status===429||r.status>=500)&&attempt<4){await this.wait(retryDelay(r,attempt),signal);continue}
   throw failure(r.status===429?'RATE_LIMITED':'PROVIDER_UNAVAILABLE',r.status===429?'Groq временно ограничил запросы':`Groq вернул HTTP ${r.status}`);
  }
 }
 /** segments: [{start,text,speaker?}] → normalized summary. onProgress({done,total,stage}). */
 async summarize({segments,title='',duration=Infinity,signal,onProgress=()=>{}}){
  const parts=transcriptParts(segments,this.partChars);if(!parts.length)throw failure('EMPTY','В расшифровке нет текста');
  const model=await this.model(signal);const total=parts.length+(parts.length>1?1:0);
  const header=title?`Название записи: ${title}\n`:'';
  if(parts.length===1){
   onProgress({done:0,total,stage:'Составляем конспект'});
   const {parsed,model:used}=await this.chat(model,[{role:'system',content:RULES},{role:'user',content:header+'Расшифровка:\n'+parts[0]}],signal);
   onProgress({done:1,total,stage:'Готово'});return {...normalizeSummary(parsed,{duration}),model:used};
  }
  const notes=[];
  for(const [i,part] of parts.entries()){
   onProgress({done:i,total,stage:`Читаем часть ${i+1} из ${parts.length}`});
   const {parsed}=await this.chat(model,[{role:'system',content:RULES},{role:'user',content:`${header}Это часть ${i+1} из ${parts.length} длинной встречи. Составь конспект только этой части.\nРасшифровка:\n${part}`}],signal);
   notes.push(normalizeSummary(parsed,{duration}));
  }
  onProgress({done:parts.length,total,stage:'Сводим части в один конспект'});
  const compact=notes.map((n,i)=>`Часть ${i+1}: ${JSON.stringify({...n,topics:n.topics.map(t=>({...t,at:t.at===undefined?undefined:stamp(t.at)})),decisions:n.decisions.map(d=>({...d,at:d.at===undefined?undefined:stamp(d.at)})),actions:n.actions.map(a=>({...a,at:a.at===undefined?undefined:stamp(a.at)})),questions:n.questions.map(q=>({...q,at:q.at===undefined?undefined:stamp(q.at)}))})}`).join('\n');
  const {parsed,model:used}=await this.chat(model,[{role:'system',content:RULES+'\nТебе даны конспекты частей одной встречи по порядку. Объедини их: убери повторы, сохрани все решения и задачи, вопрос, решённый в более поздней части, не считай открытым. Время at бери из конспектов частей.'},{role:'user',content:header+compact}],signal);
  onProgress({done:total,total,stage:'Готово'});return {...normalizeSummary(parsed,{duration}),model:used};
 }
}
