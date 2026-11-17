import {audioError} from './process.mjs';
export const PREPARATION_PIPELINE='audio-prepare-1';
// Approved initial candidates. Speech-quality tuning/recommendations require corpus evidence.
const profiles=Object.freeze({
 original:Object.freeze({id:'original',title:'Оригинал',hint:'Подготовка формата без фильтров.',preFilter:'',normalize:false}),
 gentle:Object.freeze({id:'gentle',title:'Бережно',hint:'Ослабить низкочастотный гул.',preFilter:'highpass=f=70',normalize:false}),
 level:Object.freeze({id:'level',title:'Выровнять голос',hint:'Согласовать громкость по всей записи.',preFilter:'highpass=f=75',normalize:true}),
 // afftdn emits a two-hop delay (2 * 48000 / 80 = 1200 frames).
 // Pad before it to flush the original tail, then remove only that filter delay.
 denoise:Object.freeze({id:'denoise',title:'Убрать ровный шум',hint:'Для постоянного фонового шума. Сначала сравните на слух.',preFilter:'aresample=48000,highpass=f=90,apad=pad_len=1200,afftdn=nf=-28,atrim=start_sample=1200,asetpts=N/SR/TB',outputRate:48000,normalize:true})
});
export function getProfile(id){if(!Object.hasOwn(profiles,id))throw audioError('INVALID_PROFILE');return profiles[id]}
export const publicProfiles=()=>Object.values(profiles).map(({id,title,hint})=>({id,title,hint,recommended:false}));
