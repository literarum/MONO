// MONO behaves as an application, not as a web page: the browser's own context menu, dragging of
// page elements and images, selecting interface text, save/print/view-source shortcuts and the
// browser's find bar are switched off. What stays is what MONO itself offers: typing and selecting
// in fields and in the transcript, dropping audio/video files to import them, MONO's search on
// Ctrl+F, and its own buttons.
const EDITABLE='input,textarea,select,[contenteditable]:not([contenteditable="false"]),#editor-segments,.transcript-paragraph,.summary-body,[data-selectable]';
export function editable(target){return Boolean(target?.closest?.(EDITABLE))}

export function guardAppShell({doc=globalThis.document,onFind=()=>false}={}){
 const stop=event=>{event.preventDefault()};
 doc.addEventListener('contextmenu',event=>{if(!editable(event.target))stop(event)},{capture:true});
 doc.addEventListener('dragstart',event=>{if(!editable(event.target))stop(event)},{capture:true}); // files dropped from outside still work
 doc.addEventListener('selectstart',event=>{if(!editable(event.target))stop(event)},{capture:true});
 doc.addEventListener('keydown',event=>{
  const key=event.key.toLowerCase(),mod=event.ctrlKey||event.metaKey;
  if(mod&&['s','u','p','o','j','h','d'].includes(key)&&!event.altKey){stop(event);return} // save, source, print, open, downloads, history, bookmark
  if(mod&&key==='f'){stop(event);onFind(event);return} // never the browser's find bar
  if(key==='f3'||(mod&&key==='g')){stop(event);onFind(event);return}
  if(event.key==='F5'||(mod&&key==='r')){/* reload keeps the work (state is restored) — allowed */}
 },{capture:true});
 // Ctrl+wheel and pinch would zoom the page out of its layout; the app has «Размер текста» in Settings.
 doc.addEventListener('wheel',event=>{if(event.ctrlKey)stop(event)},{capture:true,passive:false});
 doc.documentElement.classList.add('app-shell-guarded');
}
