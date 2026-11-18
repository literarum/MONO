export const MAX_SEGMENT_SECONDS=240;
export const OVERLAP_SECONDS=0.8;
export const USD_PER_HOUR=0.04;
export function planSegments(duration, chunk=MAX_SEGMENT_SECONDS, overlap=OVERLAP_SECONDS) {
  if (!Number.isFinite(duration)||duration<=0) throw new Error('Некорректная длительность');
  if(!Number.isFinite(chunk)||chunk<=0||!Number.isFinite(overlap)||overlap<0||overlap>=chunk)
    throw new Error('Некорректные параметры сегментации');
  const result=[];
  for(let start=0,index=0;start<duration;index++,start=index*chunk) {
    const end=Math.min(duration,start+chunk);
    result.push({
      index, start, end, mediaStart:Math.max(0,start-overlap),
      mediaEnd:Math.min(duration,end+overlap)
    });
    if(result.length>10000) throw new Error('Слишком много фрагментов');
  }
  return result;
}
/** Move each nominal cut to the middle of the nearest pause (within ±window s), so no word is
 * split between two requests (WhisperX/Baseten cut on VAD silences). Cuts stay strictly
 * increasing and every segment stays ≤ chunk + window; with no pause nearby the cut is kept. */
export function alignToSilence(plans,silences,{window=20,overlap=OVERLAP_SECONDS}={}){
  if(!Array.isArray(silences)||!silences.length||plans.length<2)return plans;
  const duration=plans.at(-1).end,cuts=[];
  for(let i=1;i<plans.length;i++){
    const nominal=plans[i].start,previous=cuts.at(-1)??0;let best=null;
    for(const s of silences){
      if(!(Number.isFinite(s?.start)&&Number.isFinite(s?.end)&&s.end>s.start))continue;
      const mid=(s.start+s.end)/2;if(Math.abs(mid-nominal)>window||mid<=previous+1||mid>=duration-1)continue;
      if(!best||Math.abs(mid-nominal)<Math.abs(best-nominal))best=mid;
    }
    cuts.push(best??nominal);
  }
  const edges=[0,...cuts,duration];
  return edges.slice(0,-1).map((start,index)=>({index,start,end:edges[index+1],mediaStart:Math.max(0,start-overlap),mediaEnd:Math.min(duration,edges[index+1]+overlap),...(cuts[index-1]!==undefined&&cuts[index-1]!==plans[index].start||cuts[index]!==undefined&&cuts[index]!==plans[index+1]?.start?{aligned:true}:{})}));
}
/** ffmpeg silencedetect stderr → [{start,end}] */
export function parseSilences(stderr){
  const out=[];let start=null;
  for(const m of String(stderr||'').matchAll(/silence_(start|end):\s*(-?[\d.]+)/g)){
    const t=Number(m[2]);if(m[1]==='start')start=Math.max(0,t);else if(start!==null){if(t>start)out.push({start,end:t});start=null}
  }
  return out;
}
/** Text the next request is conditioned on: the user's terms first, then the tail of the
 * previous segment (continuity of names and sentence breaks). Bounded well under Groq's
 * 224-token prompt limit. */
export function contextPrompt(userPrompt,previousText,limit=380){
  const terms=String(userPrompt||'').trim();const room=Math.max(0,limit-terms.length-1);
  let tail=String(previousText||'').replace(/\s+/g,' ').trim();
  if(room<40||!tail)return terms;
  if(tail.length>room){tail=tail.slice(-room);const cut=tail.search(/[\s.,!?]/);if(cut>0&&cut<40)tail=tail.slice(cut+1)}
  tail=tail.trim();return terms?`${terms} ${tail}`:tail;
}
/** Groq reports its budget on every response; when the next request would be refused, wait
 * for the reset instead of spending a 429 (Groq does not retry by itself). */
export function rateLimitWait(headers){
  const remaining=Number(headers?.get?.('x-ratelimit-remaining-requests'));
  if(!Number.isFinite(remaining)||remaining>1)return 0;
  const reset=String(headers.get('x-ratelimit-reset-requests')||'');let ms=0;
  for(const [,n,unit] of reset.matchAll(/([\d.]+)(ms|h|m|s)/g))ms+=Number(n)*({ms:1,s:1000,m:60000,h:3600000})[unit];
  return Math.min(10*60000,Math.max(0,ms));
}
export function estimateCostSeconds(seconds) {
  return Math.max(10,Math.max(0,seconds))*USD_PER_HOUR/3600;
}
// Fansub credits Whisper emits over silence (documented for Russian output).
// These never occur as natural speech, so they are removed on sight.
const CREDIT_HALLUCINATION=/^(?:субтитры\s+(?:сделал[аи]?|создал[аи]?|создавал[аи]?|подготовил[аи]?|делал[аи]?)(?!\p{L}).*|(?:редактор|корректор)\s+субтитров(?!\p{L}).*|субтитры\s+(?:от|by)(?!\p{L}).*|subtitles\s+by(?!\p{L}).*)$/iu;
// Plausible speech, but typical silence hallucinations: removed only when the
// provider also reports the segment as probably not speech.
const OUTRO_HALLUCINATION=/^(?:продолжение\s+следует|спасибо\s+за\s+(?:просмотр|внимание)|подписывайтесь\s+на\s+(?:наш\s+)?канал|ставьте\s+лайк\w*|до\s+новых\s+встреч)[.!…\s]*$/iu;
const clean=text=>String(text??'').replace(/[«»"“”]/g,'').replace(/\s+/g,' ').trim();
/** Whisper's own skip rule plus phrase/loop guards. Never drops ordinary speech. */
export function isHallucination(item){
  const text=clean(item?.text).replace(/[.!…]+$/,'');
  if(!text)return false;
  const noSpeech=Number(item?.no_speech_prob),logprob=Number(item?.avg_logprob);
  // openai/whisper transcribe.py: silence only when BOTH thresholds agree.
  if(Number.isFinite(noSpeech)&&Number.isFinite(logprob)&&noSpeech>0.6&&logprob<-1)return true;
  // Whisper's fallback trigger: a highly repetitive decode (gzip ratio > 2.4) that the model
  // itself is unsure of is a loop, not speech.
  const ratio=Number(item?.compression_ratio);
  if(Number.isFinite(ratio)&&Number.isFinite(logprob)&&ratio>2.4&&logprob<-1)return true;
  if(CREDIT_HALLUCINATION.test(text))return true;
  return OUTRO_HALLUCINATION.test(text)&&Number.isFinite(noSpeech)&&noSpeech>0.5;
}
/** Collapse a phrase looping three or more times in a row into one occurrence. */
export function collapseLoops(segments,minimum=3){
  const result=[];
  for(let i=0;i<segments.length;){
    let j=i+1;const key=clean(segments[i].text).toLowerCase();
    while(j<segments.length&&clean(segments[j].text).toLowerCase()===key)j++;
    if(j-i>=minimum)result.push({...segments[i],end:segments[j-1].end});
    else for(let k=i;k<j;k++)result.push(segments[k]);
    i=j;
  }
  return result;
}
/** The 0.8 s overlap can return the same phrase from both neighbouring requests. Only
 * segments from different requests that overlap in time are merged — a real repeat
 * ("Да. Да.") inside one request is speech and stays. */
const same=(a,b)=>clean(a).toLowerCase().replace(/[.!?…,;:]+$/,'')===clean(b).toLowerCase().replace(/[.!?…,;:]+$/,'');
export function dedupeBoundaries(segments){
  const out=[];
  for(const s of segments){const prev=out.at(-1);
    if(prev&&prev.chunk!==undefined&&s.chunk!==prev.chunk&&s.start<prev.end&&same(s.text,prev.text)){prev.end=Math.max(prev.end,s.end);continue}
    out.push({...s})}
  return out.map(({chunk,...s})=>s);
}
export function normalizeSegments(chunks) {
  const result=[];
  for(const {plan,data} of chunks.sort((a,b)=>a.plan.index-b.plan.index)){
    const valid=Array.isArray(data.segments)?data.segments.filter(s=>
      s&&typeof s.text==='string'&&Number.isFinite(Number(s.start))&&Number.isFinite(Number(s.end))&&
      Number(s.end)>=Number(s.start)): [];
    // Provider segments are authoritative: when all are hallucinations, the
    // concatenated `text` must not reintroduce them.
    const speech=valid.filter(s=>!isHallucination(s));
    const fallback={start:0,end:plan.mediaEnd-plan.mediaStart,text:data.text??''};
    const source=valid.length?speech:isHallucination(fallback)?[]:[fallback];
    for(const item of source){
      const a=plan.mediaStart+Number(item.start),b=plan.mediaStart+Number(item.end);
      if(!Number.isFinite(a)||!Number.isFinite(b)||b<a)continue;
      const midpoint=(a+b)/2;
      if(midpoint+0.00001<plan.start||midpoint>=plan.end+0.00001)continue;
      const text=String(item.text??'').trim();
      // Segment-level confidence proxy exp(avg_logprob); uncalibrated, used only to point at doubtful places.
      const logprob=Number(item.avg_logprob),confidence=Number.isFinite(logprob)?Math.round(Math.min(1,Math.exp(logprob))*1000)/1000:undefined;
      if(text)result.push({start:Math.max(0,a),end:b,text,chunk:plan.index,...(confidence!==undefined?{confidence}:{})});
    }
  }
  return collapseLoops(dedupeBoundaries(result.sort((a,b)=>a.start-b.start)));
}
export function safeName(name) {
  return String(name||'').replace(/[^a-zA-Z0-9а-яА-ЯёЁ._-]/g,'_').slice(0,80);
}
