import {audioError} from './process.mjs';
export const PREPARATION_PIPELINE='audio-prepare-1';
// Approved initial candidates. Speech-quality tuning/recommendations require corpus evidence.
const profiles=Object.freeze({
 // «Авто» is resolved per record from the measurement of the original (recommendProfile).
 auto:Object.freeze({id:'auto',title:'Авто',hint:'MONO измерит запись и выберет обработку сам.',preFilter:'',normalize:false}),
 original:Object.freeze({id:'original',title:'Оригинал',hint:'Подготовка формата без фильтров.',preFilter:'',normalize:false}),
 gentle:Object.freeze({id:'gentle',title:'Бережно',hint:'Ослабить низкочастотный гул.',preFilter:'highpass=f=70',normalize:false}),
 level:Object.freeze({id:'level',title:'Выровнять голос',hint:'Согласовать громкость по всей записи.',preFilter:'highpass=f=75',normalize:true}),
 // afftdn emits a two-hop delay (2 * 48000 / 80 = 1200 frames).
 // Pad before it to flush the original tail, then remove only that filter delay.
 // A quiet or distant voice: a compressor without look-ahead (no added delay) lifts quiet passages,
 // then linear loudness normalization sets the level.
 quiet:Object.freeze({id:'quiet',title:'Тихий голос',hint:'Для тихой или далёкой речи: подтягивает тихие места.',preFilter:'highpass=f=80,acompressor=threshold=-30dB:ratio=3:attack=10:release=250:makeup=4',normalize:true}),
 // Speech band only: removes rumble below 80 Hz and hiss above 7.8 kHz, where speech carries little.
 speech:Object.freeze({id:'speech',title:'Чистая речь',hint:'Срезать гул и высокочастотное шипение вне голоса.',preFilter:'highpass=f=80,lowpass=f=7800',normalize:true}),
 denoise:Object.freeze({id:'denoise',title:'Убрать ровный шум',hint:'Для постоянного фонового шума. Сначала сравните на слух.',preFilter:'aresample=48000,highpass=f=90,apad=pad_len=1200,afftdn=nf=-28,atrim=start_sample=1200,asetpts=N/SR/TB',outputRate:48000,normalize:true})
});
export function getProfile(id){if(!Object.hasOwn(profiles,id))throw audioError('INVALID_PROFILE');return profiles[id]}
export const publicProfiles=()=>Object.values(profiles).map(({id,title,hint})=>({id,title,hint,recommended:id==='auto'}));
/** The processing «Авто» chooses, from the measurement of the original. Conservative: Whisper copes
 * with most recordings as they are, so strong processing is chosen only for clearly quiet audio.
 * Returns {profile, reason} — the reason is shown to the person. */
export function recommendProfile(analysis){
 const loudness=analysis?.loudness||{},clipped=(analysis?.clipping?.fraction||0)>.001;
 if(!loudness.valid)return loudness.reason==='below-gate'?{profile:'quiet',reason:'Запись очень тихая.'}:{profile:'original',reason:'Запись слишком короткая для измерений.'};
 const {integrated,range}=loudness;
 if(clipped)return {profile:'gentle',reason:'В записи есть перегрузка — громкость не поднимаем, только убираем гул.'};
 if(integrated<-32||Number.isFinite(range)&&range>14)return {profile:'quiet',reason:`Голос тихий или далёкий (${Math.round(integrated)} LUFS${Number.isFinite(range)?`, перепад ${Math.round(range)} LU`:''}).`};
 if(integrated<-24||Number.isFinite(range)&&range>9)return {profile:'level',reason:`Громкость неровная (${Math.round(integrated)} LUFS${Number.isFinite(range)?`, перепад ${Math.round(range)} LU`:''}).`};
 return {profile:'gentle',reason:'Громкость в порядке — убираем только низкий гул.'};
}
