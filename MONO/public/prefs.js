// Personal settings of this window's person: small, local, with defaults. Settings that the launcher
// or the server must also know (work in the background) live in the archive preferences instead.
const KEY='mono-prefs-1';
export const PREF_DEFAULTS=Object.freeze({
 accent:'system',          // system | blue | violet | teal | pink | orange | green
 glass:'full',             // full | reduced — less transparency and blur
 motion:'full',            // full | reduced
 textSize:'normal',        // normal | large | larger
 checkSoundEveryTime:false,// a five-second sound check before each new recording
 countdown:0,              // 0 | 3 | custom seconds before recording starts
 countdownCustom:5,        // «Свой» seconds
 titleCustom:'',           // «Своё название…» base for new recordings
 silenceWarning:true,      // tell when nothing is heard during a recording
 clipWarning:true,         // tell when the voice overloads
 floatingRecorder:true,    // a movable recording panel outside the studio
 titleTemplate:'date',     // date | meeting | voice | custom
 offerTranscription:true,  // after a recording, offer to transcribe (always asks before sending)
 showDoubts:true,          // highlight uncertain words in the transcript
 libraryView:'grid',       // grid | list
 librarySort:'newest',     // newest | oldest | longest | title
 toastDuration:'normal',   // normal | long
 doneSound:true,           // a soft chime when a transcription is ready
 doneNotification:false,   // a system notification when MONO is in the background
 rateAuto:true,            // USD→RUB from the Bank of Russia every 6 hours
 groqReminder:true,        // offer to connect Groq at start while it is not connected
 tourDone:false            // the feature tour has been seen
});
const listeners=new Set();
function read(){try{const value=JSON.parse(localStorage.getItem(KEY)||'{}');return value&&typeof value==='object'?value:{}}catch{return {}}}
let stored=read();
export const prefs={
 get(key){return Object.hasOwn(stored,key)?stored[key]:PREF_DEFAULTS[key]},
 set(key,value){if(!Object.hasOwn(PREF_DEFAULTS,key))throw new RangeError(`Unknown preference ${key}`);stored={...stored,[key]:value};try{localStorage.setItem(KEY,JSON.stringify(stored))}catch{}for(const listener of listeners)listener(key,value)},
 reset(){stored={};try{localStorage.removeItem(KEY)}catch{}for(const listener of listeners)listener(null,null)},
 subscribe(listener){listeners.add(listener);return()=>listeners.delete(listener)},
 all(){return {...PREF_DEFAULTS,...stored}}
};
/** Visual preferences become classes and variables on <body>, so CSS does the rest. */
export const ACCENTS=Object.freeze({blue:'#0a84ff',violet:'#7d5cff',teal:'#22b5c9',pink:'#ff4f8b',orange:'#ff9500',green:'#30c25a'});
export function applyVisualPrefs(body=document.body){
 body.dataset.accent=prefs.get('accent');body.classList.toggle('reduce-glass',prefs.get('glass')==='reduced');body.classList.toggle('reduce-motion',prefs.get('motion')==='reduced');body.dataset.textSize=prefs.get('textSize');
}
