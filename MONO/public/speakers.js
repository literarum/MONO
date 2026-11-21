// Labels transcript segments from a two-track loudness profile (see backend/audio/speakers.mjs).
export const SPEAKER_NAMES={me:'Я',others:'Собеседники'};
const power=db=>10**(db/10);
/** 'me' | 'others' | null (both, silence or too close to call: 6 dB margin). */
export function speakerFor(segment,profile,margin=6){
 if(!profile?.tracks?.mic||!profile?.tracks?.system)return null;
 const from=Math.max(0,Math.floor(segment.start/profile.bin)),to=Math.max(from+1,Math.ceil(segment.end/profile.bin));
 const mean=list=>{let sum=0,n=0;for(let i=from;i<to&&i<list.length;i++){sum+=power(list[i]);n++}return n?10*Math.log10(sum/n||1e-12):-120};
 const mic=mean(profile.tracks.mic),system=mean(profile.tracks.system);
 if(Math.max(mic,system)<-55)return null;
 return mic-system>=margin?'me':system-mic>=margin?'others':null;
}
export function labelSegments(segments,profile){return segments.map(segment=>({...segment,speaker:speakerFor(segment,profile)}))}
