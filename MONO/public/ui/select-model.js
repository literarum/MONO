export function nextOption(options,current,key){
 const enabled=options.map((o,i)=>!o.disabled?i:-1).filter(i=>i>=0);
 if(!enabled.length)return -1;
 if(key==='Home')return enabled[0];if(key==='End')return enabled.at(-1);
 const dir=key==='ArrowUp'?-1:1;
 const candidates=enabled.filter(i=>dir>0?i>current:i<current);
 return candidates.length?(dir>0?candidates[0]:candidates.at(-1)):(enabled.includes(current)?current:dir>0?enabled[0]:enabled.at(-1));
}
export function findOption(options,query,current=-1){
 const q=query.normalize('NFKC').toLocaleLowerCase('ru');
 for(let step=1;step<=options.length;step++){
  const i=(Math.max(-1,current)+step)%options.length;
  if(!options[i].disabled&&options[i].label.normalize('NFKC').toLocaleLowerCase('ru').startsWith(q))return i;
 }return -1;
}
