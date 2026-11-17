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
      if(text)result.push({start:Math.max(0,a),end:b,text});
    }
  }
  return collapseLoops(result.sort((a,b)=>a.start-b.start));
}
export function safeName(name) {
  return String(name||'').replace(/[^a-zA-Z0-9а-яА-ЯёЁ._-]/g,'_').slice(0,80);
}
