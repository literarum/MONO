import {drawerTransition} from './drawer-model.js';
import {openLayer} from './layers.js';
// When the stylesheet turns the drawer into a tab bar (trigger hidden), the
// navigation is always visible and must stay interactive.
const tabBarMode=trigger=>typeof getComputedStyle==='function'&&getComputedStyle(trigger).display==='none';
export function mountDrawer({sidebar,trigger,content}){
 const abort=new AbortController(),{signal}=abort,backdrop=document.createElement('div');backdrop.className='drawer-backdrop';backdrop.hidden=true;document.body.append(backdrop);
 let opened=false,layer=null;
 trigger.setAttribute('aria-controls',sidebar.id);trigger.setAttribute('aria-expanded','false');
 const update=event=>{
  const next=drawerTransition(opened,event,innerWidth);if(next===opened)return;
  opened=next;sidebar.inert=innerWidth<=990&&!opened&&!tabBarMode(trigger);sidebar.classList.toggle('open',opened);backdrop.hidden=!opened;document.body.classList.toggle('drawer-open',opened);trigger.setAttribute('aria-expanded',String(opened));
  if(opened){sidebar.setAttribute('role','dialog');sidebar.setAttribute('aria-modal','true');sidebar.setAttribute('aria-label','Основное меню');layer=openLayer({element:sidebar,modal:true,background:content,onClose:()=>update('close')});sidebar.querySelector('a,button')?.focus()}
  else{const closing=layer;layer=null;sidebar.removeAttribute('role');sidebar.removeAttribute('aria-modal');closing?.close(event);trigger.focus({preventScroll:true})}
 };
 trigger.addEventListener('click',()=>update('toggle'),{signal});window.addEventListener('resize',()=>update('resize'),{signal});window.addEventListener('hashchange',()=>update('route'),{signal});
 // A translated drawer must also be absent from keyboard navigation when closed.
 const responsive=()=>{sidebar.inert=innerWidth<=990&&!opened&&!tabBarMode(trigger)};window.addEventListener('resize',responsive,{signal});
 const api={open(){update('open');responsive()},close(reason='close'){update(reason);responsive()},destroy(){api.close();abort.abort();backdrop.remove();sidebar.inert=false}};
 trigger.addEventListener('click',responsive,{signal});backdrop.addEventListener('pointerdown',()=>api.close('outside'),{signal});responsive();return api;
}
