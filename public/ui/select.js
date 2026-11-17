import {nextOption,findOption} from './select-model.js';
import {openLayer} from './layers.js';
import {mountScrollArea} from './scroll-area.js';
const instances=new WeakMap();let serial=0;
export function mountSelect(select){
 if(instances.has(select))return instances.get(select);
 const abort=new AbortController(),{signal}=abort,host=document.createElement('div'),button=document.createElement('button');
 host.className='select-wrap '+[...select.classList].filter(x=>x!=='select').join(' ');
 button.type='button';button.className='select-control';button.id=(select.id||`select-${++serial}`)+'-control';
 button.setAttribute('role','combobox');button.setAttribute('aria-haspopup','listbox');button.setAttribute('aria-expanded','false');
 const label=select.labels?.[0];if(label){label.id||=`select-label-${++serial}`;button.setAttribute('aria-labelledby',label.id);label.addEventListener('click',()=>button.focus(),{signal})}
 else button.setAttribute('aria-label',select.getAttribute('aria-label')||'Выбрать вариант');
 select.before(host);host.append(select,button);
 const previousHidden=select.hidden;select.hidden=true;
 let popup=null,layer=null,scroll=null,active=-1,query='',queryTimer=0;
 const options=()=>[...select.options];
 const sync=()=>{button.textContent=select.selectedOptions[0]?.textContent||'Выберите';button.disabled=select.disabled;button.setAttribute('aria-invalid',select.getAttribute('aria-invalid')||'false');if(select.disabled)layer?.close('disabled')};
 const paint=()=>{if(!popup)return;popup.querySelectorAll('[role=option]').forEach((o,i)=>{o.classList.toggle('active',i===active);o.setAttribute('aria-selected',String(i===select.selectedIndex))});const el=popup.querySelector(`[data-index="${active}"]`);if(el){button.setAttribute('aria-activedescendant',el.id);el.scrollIntoView({block:'nearest'})}};
 const choose=i=>{if(i<0||select.options[i]?.disabled)return;const changed=select.selectedIndex!==i;select.selectedIndex=i;sync();layer?.close('select');if(changed){select.dispatchEvent(new Event('input',{bubbles:true}));select.dispatchEvent(new Event('change',{bubbles:true}))}};
 const open=()=>{
  if(popup||select.disabled)return;
  popup=document.createElement('div');popup.className='select-popup glass';popup.id=`select-popup-${++serial}`;popup.setAttribute('role','listbox');popup.setAttribute('aria-label',button.getAttribute('aria-label')||label?.textContent||'Варианты');
  const list=document.createElement('div');list.className='select-options';popup.append(list);
  options().forEach((option,i)=>{const el=document.createElement('div');el.role='option';el.id=`${popup.id}-${i}`;el.dataset.index=String(i);el.className='select-option';el.textContent=option.label;el.setAttribute('aria-disabled',String(option.disabled));el.addEventListener('pointerdown',e=>e.preventDefault());el.addEventListener('click',()=>choose(i));list.append(el)});
  document.body.append(popup);scroll=mountScrollArea(list,{axes:'y'});
  active=select.options[select.selectedIndex]?.disabled?nextOption(options(),-1,'Home'):select.selectedIndex;
  button.setAttribute('aria-controls',popup.id);button.setAttribute('aria-expanded','true');
  layer=openLayer({element:popup,anchor:button,onClose:()=>{scroll?.destroy();popup?.remove();popup=null;layer=null;button.setAttribute('aria-expanded','false');button.removeAttribute('aria-activedescendant');button.removeAttribute('aria-controls')}});paint();
 };
 button.addEventListener('click',()=>popup?layer.close('toggle'):open(),{signal});
 button.addEventListener('keydown',e=>{
  if(e.isComposing)return;
  if(['ArrowDown','ArrowUp','Home','End'].includes(e.key)){e.preventDefault();open();active=nextOption(options(),active,e.key);paint()}
  else if(e.key==='Enter'||e.key===' '){e.preventDefault();if(popup)choose(active);else open()}
  else if(e.key==='Tab'){layer?.close('tab',false)}
  else if(e.key.length===1&&!e.ctrlKey&&!e.metaKey&&!e.altKey){e.preventDefault();clearTimeout(queryTimer);query+=e.key;queryTimer=setTimeout(()=>query='',600);const i=findOption(options(),query,active);if(i>=0){if(popup){active=i;paint()}else choose(i)}}
 },{signal});
 select.addEventListener('change',sync,{signal});
 const observer=new MutationObserver(()=>{if(popup)layer?.close('options-changed');sync()});observer.observe(select,{attributes:true,childList:true,subtree:true,characterData:true});
 const api={sync,destroy(){layer?.close('destroy',false);abort.abort();observer.disconnect();clearTimeout(queryTimer);select.hidden=previousHidden;host.before(select);host.remove();instances.delete(select)}};
 instances.set(select,api);sync();return api;
}
