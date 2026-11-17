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
export function normalizeSegments(chunks) {
  const result=[];
  for(const {plan,data} of chunks.sort((a,b)=>a.plan.index-b.plan.index)){
    const valid=Array.isArray(data.segments)?data.segments.filter(s=>
      s&&typeof s.text==='string'&&Number.isFinite(Number(s.start))&&Number.isFinite(Number(s.end))&&
      Number(s.end)>=Number(s.start)): [];
    const source=valid.length?valid:[{start:0,end:plan.mediaEnd-plan.mediaStart,text:data.text??''}];
    for(const item of source){
      const a=plan.mediaStart+Number(item.start),b=plan.mediaStart+Number(item.end);
      if(!Number.isFinite(a)||!Number.isFinite(b)||b<a)continue;
      const midpoint=(a+b)/2;
      if(midpoint+0.00001<plan.start||midpoint>=plan.end+0.00001)continue;
      const text=String(item.text??'').trim();
      if(text)result.push({start:Math.max(0,a),end:b,text});
    }
  }
  return result.sort((a,b)=>a.start-b.start);
}
export function safeName(name) {
  return String(name||'').replace(/[^a-zA-Z0-9а-яА-ЯёЁ._-]/g,'_').slice(0,80);
}
