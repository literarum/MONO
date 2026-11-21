export function drawerTransition(open,event,width){
 if(width>990)return false;
 if(['outside','escape','route','close'].includes(event))return false;
 if(event==='toggle')return !open;if(event==='open')return true;return open;
}
