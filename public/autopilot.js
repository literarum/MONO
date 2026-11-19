// Pure decisions of the recording autopilot (unit-tested; app.js wires them to the UI).
// Principle (Apple, Cocoa error handling): recover quietly when possible; ask the person
// only for what software cannot decide — a privacy switch, a disabled device.

/** Start failures another path can fix. ACCESS_DENIED, library and disk errors are not here:
 * retrying them would hide a decision or a problem that only the person can resolve. */
export const RETRYABLE=new Set(['START_TIMEOUT','STOP_PENDING','DEVICE_BUSY','BROWSER_OPEN_FAILED','DEVICE_LOST','UNSUPPORTED_FORMAT','CAPTURE_HELPER_UNAVAILABLE','CAPTURE_HELPER_TIMEOUT','CAPTURE_NOT_READY','ACCESS_TIMEOUT','INTERNAL','INVALID_CAPTURE_PROTOCOL']);

/** Recovery ladder for one press of Record: chosen devices → system defaults → the other,
 * dissimilar microphone path (system module ⇄ browser channel). At most two steps, never the
 * same step twice. The browser channel and the system module open the microphone through
 * different Windows stacks, so one may succeed where the other gets "device busy". */
export function recoverySteps(selection,browserAvailable,nativeMicAvailable=false){
 const steps=[];
 if(selection.inputId||selection.outputId)steps.push({...selection,inputId:null,outputId:null});
 if(selection.mode==='mic'&&browserAvailable)steps.push({mode:'browser',inputId:null,outputId:null});
 if(selection.mode==='browser'&&nativeMicAvailable)steps.push({mode:'mic',inputId:null,outputId:null});
 if(!steps.length)steps.push({...selection});
 return steps.slice(0,2);
}

/** The microphone a take will use, from Windows' diagnosis: the chosen one if it is still
 * active, otherwise the default. `fallback` says the chosen one is gone. */
export function pickInput(report,inputId){
 const active=(report?.inputs||[]).filter(d=>d.state==='active');
 const chosen=inputId?active.find(d=>d.id===inputId):null;
 const target=chosen||active.find(d=>d.default)||active[0]||null;
 return {target,fallback:Boolean(inputId&&!chosen),disabledOnly:!active.length&&(report?.inputs||[]).some(d=>d.state==='disabled')};
}

/** Muted in Windows, or an input level so low that speech would be lost. */
export const needsRepair=input=>Boolean(input&&(input.muted===true||typeof input.volume==='number'&&input.volume<.05));
export const REPAIR=input=>({inputId:input.id,mute:false,minimumVolume:.5});
