// On-device transcript intelligence: pure functions, no network, no surprises.
// Every rule is conservative on purpose: when unsure, MONO keeps the person's words.

const words=text=>String(text||'').match(/[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu)||[];

/** Whisper's own fallback rule treats avg_logprob < −1 as a failed decode; exp(−1) ≈ 0.37.
 * The score is a per-segment proxy and is not calibrated, so we only flag clear cases. */
export const DOUBT_THRESHOLD=Math.exp(-1);
export function confidenceOf(segment){
 const value=Number(segment?.confidence);return Number.isFinite(value)&&value>=0&&value<=1?value:null;
}
export function isDoubtful(segment){const c=confidenceOf(segment);return c!==null&&c<DOUBT_THRESHOLD}
/** Index of the next doubtful segment after `from` (wraps around), or −1. */
export function nextDoubtful(segments,from=-1){
 const list=segments||[];for(let step=1;step<=list.length;step++){const i=(from+step+list.length)%list.length;if(isDoubtful(list[i]))return i}return -1;
}

/** Reading paragraphs: a new paragraph on a long pause, a speaker change, or when the
 * paragraph grows too long (cut only at a sentence end when possible). */
export function paragraphs(segments,{pause=1.6,maxChars=900,speakerOf=()=>null}={}){
 const out=[];let current=null;
 for(const [index,s] of (segments||[]).entries()){
  const text=String(s?.text||'').trim();if(!text)continue;
  const speaker=speakerOf(s)||null,gap=current?Number(s.start)-current.end:0;
  const sentenceEnded=current&&/[.!?…]["»)]?$/.test(current.text);
  const split=!current||speaker!==current.speaker||gap>=pause||(current.text.length>=maxChars&&sentenceEnded)||current.text.length>=maxChars*1.6;
  if(split){current={start:Number(s.start)||0,end:Number(s.end)||0,speaker,text,indices:[index]};out.push(current)}
  else{current.text+=' '+text;current.end=Math.max(current.end,Number(s.end)||0);current.indices.push(index)}
 }
 return out;
}

/** Smart Speed: pauses between phrases longer than `minGap` are shortened to `keep` seconds.
 * Built from the transcript's own timings, so music or speech without text is never cut
 * inside a segment. Returns [{from,to}] — playback at `from` jumps to `to`. */
export function silenceSkips(segments,{minGap=1.2,keep=.45,duration=Infinity}={}){
 const list=[...(segments||[])].filter(s=>Number.isFinite(Number(s?.start))&&Number.isFinite(Number(s?.end))).sort((a,b)=>a.start-b.start);
 const skips=[];let lastEnd=0;
 for(const s of list){
  const start=Number(s.start),from=lastEnd+keep/2,to=start-keep/2;
  if(start-lastEnd>=minGap&&to-from>.2)skips.push({from,to});
  lastEnd=Math.max(lastEnd,Number(s.end));
 }
 if(Number.isFinite(duration)&&duration-lastEnd>=minGap&&list.length)skips.push({from:lastEnd+keep/2,to:Math.max(lastEnd+keep/2,duration-.05)});
 return skips;
}
/** Where playback should continue from, or null to keep playing. */
export function skipTarget(skips,time){
 for(const skip of skips||[]){if(time<skip.from)return null;if(time<skip.to-.05)return skip.to}
 return null;
}
export const savedSeconds=skips=>(skips||[]).reduce((sum,s)=>sum+Math.max(0,s.to-s.from),0);

/** «Чистый текст»: only sound hesitations, «это самое» and stutter repeats go away.
 * Words like «вот», «там», «типа», «ну» often carry meaning in Russian speech (HSE corpus
 * study), so they stay. A repeat across punctuation («Да. Да.») is speech and stays too. */
const HESITATION=/(^|[\s,(«"])(?:э+-?э*|э-?м+|м-?м+|а-?а+|ммм+|хм+|эм+)(?=[\s,.!?…)»"]|$)[,]?/giu;
export function cleanText(text){
 let value=String(text||'');
 value=value.replace(HESITATION,'$1').replace(/(^|[\s,])это самое,?(?=\s|$)/giu,'$1');
 value=value.replace(/(?<![\p{L}\p{N}])([\p{L}\p{N}]+)(?:\s+\1)+(?![\p{L}\p{N}])/giu,'$1');
 value=value.replace(/\s+,/g,',').replace(/,\s*([.!?…])/g,'$1').replace(/^[\s,]+/,'').replace(/\s{2,}/g,' ').trim();
 return value.charAt(0).toUpperCase()+value.slice(1);
}

/** Speaking statistics. `speakerOf` comes from the two-track loudness profile when available. */
export function transcriptStats(segments,{speakerOf=()=>null,duration=0}={}){
 let count=0,spoken=0;const people={};
 for(const s of segments||[]){
  const n=words(s?.text).length,length=Math.max(0,Number(s?.end)-Number(s?.start))||0;count+=n;spoken+=length;
  const who=speakerOf(s);if(who){people[who]??={seconds:0,words:0};people[who].seconds+=length;people[who].words+=n}
 }
 const total=Object.values(people).reduce((sum,p)=>sum+p.seconds,0);
 for(const p of Object.values(people))p.share=total?p.seconds/total:0;
 return {words:count,spokenSeconds:spoken,wordsPerMinute:spoken>=20?Math.round(count/(spoken/60)):null,silenceShare:duration>0?Math.max(0,1-spoken/duration):null,speakers:people};
}

/** Vocabulary learned from corrections: a word the person typed that the model did not
 * produce, written like a term (capital letter inside the sentence, Latin, digits or
 * a hyphenated name). Lowercase ordinary words are never learned. */
const TERMLIKE=/^(?:[A-ZА-ЯЁ][\p{L}\p{N}'’-]{1,}|[\p{L}]*[A-Za-z][\p{L}\p{N}'’-]*|[\p{L}]+[0-9][\p{L}\p{N}-]*)$/u;
export function learnTerms(original,edited){
 const before=new Set(words(original).map(w=>w.toLowerCase()));const result=[];const source=String(edited||'');
 for(const match of source.matchAll(/[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu)){
  const w=match[0];
  if(w.length<3||before.has(w.toLowerCase())||!TERMLIKE.test(w))continue;
  // A capital at the start of a sentence is grammar, not a name — unless the word is Latin, has digits or inner capitals.
  const sentenceStart=/(?:^|[.!?…])\s*$/.test(source.slice(0,match.index));
  if(sentenceStart&&!/[A-Za-z0-9]/.test(w)&&!/.[A-ZА-ЯЁ]/u.test(w))continue;
  if(!result.includes(w))result.push(w);
 }
 return result;
}
/** Merge newly learned terms into a {term:count} book; most used first, at most 60. */
export function rememberTerms(book,terms){
 const next={...(book&&typeof book==='object'?book:{})};
 for(const t of terms||[])if(typeof t==='string'&&t.length<=40)next[t]=(next[t]||0)+1;
 return Object.fromEntries(Object.entries(next).sort((a,b)=>b[1]-a[1]).slice(0,60));
}
/** Terms for the transcription prompt: the person's own text first, then learned terms
 * that are not already in it, within Groq's prompt budget. */
export function promptWithTerms(prompt,book,limit=350){
 let value=String(prompt||'').trim();const have=value.toLowerCase();
 const extra=Object.keys(book||{}).filter(t=>!have.includes(t.toLowerCase()));
 for(const term of extra){const next=value?`${value}, ${term}`:term;if(next.length>limit)break;value=next}
 return value;
}
