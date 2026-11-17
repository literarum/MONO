export function scrollMetrics({content,viewport,position,track,minThumb=24}){
 content=Math.max(0,Number(content)||0);viewport=Math.max(0,Number(viewport)||0);track=Math.max(0,Number(track)||0);
 const max=Math.max(0,content-viewport),p=Math.max(0,Math.min(max,Number(position)||0));
 const thumb=max?Math.min(track,Math.max(minThumb,content?track*viewport/content:track)):track;
 return {thumb,offset:max?(track-thumb)*p/max:0,max,atStart:p<=0,atEnd:p>=max};
}
