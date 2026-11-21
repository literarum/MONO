import {audioError} from './process.mjs';
export const PREPARATION_PIPELINE='audio-prepare-1';
// Approved initial candidates. Speech-quality tuning/recommendations require corpus evidence.
const profiles=Object.freeze({
 // «Авто» is resolved per record from the measurement of the original (recommendProfile).
 auto:Object.freeze({id:'auto',title:'Авто',hint:'MONO измерит запись и выберет обработку сам.',preFilter:'',normalize:false}),
 // «Умная обработка» is assembled per record from the measured defects (smartPreset); this entry only names it.
 smart:Object.freeze({id:'smart',title:'Умная обработка',hint:'MONO находит дефекты записи и исправляет только их.',preFilter:'',normalize:true}),
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
export const publicProfiles=()=>Object.values(profiles).filter(({id})=>id!=='smart').map(({id,title,hint})=>({id,title,hint,recommended:id==='auto'}));
/** The processing «Авто» chooses, from the measurement of the original. Conservative: Whisper copes
 * with most recordings as they are, so strong processing is chosen only for clearly quiet audio.
 * Returns {profile, reason} — the reason is shown to the person. */
/** The repair chain for one record, built only from what was measured. Each step names its reason.
 * Broadband denoising is used only when noise is close to the voice (SNR < 12 dB): studies find it
 * usually hurts Whisper otherwise (arXiv 2512.17562, 2603.04710). Every filter here keeps the timeline
 * sample-exact (checked with an impulse), except afftdn, whose fixed delay is removed. */
export function smartPreset(analysis){
 const d=analysis?.defects,loudness=analysis?.loudness||{},steps=[],found=[],kept=[];
 if(!d)return null;
 const clipped=(analysis?.clipping?.fraction||0)>.0005,snr=d.noise?.snrDb;
 if(Math.abs(d.dcOffset||0)>.003){steps.push('highpass=f=20');found.push(`смещение нуля ${(d.dcOffset*100).toFixed(1)} % — убираем`)}
 steps.push('highpass=f=70');
 if(d.hum){const harmonics=String(d.hum.harmonics||d.hum.hz).split(',').map(Number).filter(Number.isFinite);const depth=Math.min(60,Math.round(d.hum.strengthDb+6));for(const f of harmonics)steps.push(`equalizer=f=${f}:t=q:w=12:g=-${depth}`);found.push(`гул электросети ${d.hum.hz} Гц (+${Math.round(d.hum.strengthDb)} дБ) — вырезаем узко, голос не задет`)}
 if(clipped){steps.push('adeclip');found.push(`перегрузка ${(analysis.clipping.fraction*100).toFixed(2)} % — восстанавливаем срезанные пики`)}
 if(Number.isFinite(snr)&&snr<12){steps.push('aresample=48000','apad=pad_len=1200','afftdn=nf=-30:nr=10','atrim=start_sample=1200','asetpts=N/SR/TB');found.push(`шум почти как голос (сигнал/шум ${Math.round(snr)} дБ) — лёгкое шумоподавление`)}
 else if(Number.isFinite(snr))kept.push(`шум в норме (сигнал/шум ${Math.round(snr)} дБ) — шумоподавление не включаем: оно ухудшает распознавание`);
 const quiet=loudness.valid&&(loudness.integrated<-30||Number.isFinite(loudness.range)&&loudness.range>12);
 if(quiet&&!clipped){steps.push('speechnorm=e=6:r=0.00005:l=1');found.push('голос тихий или неровный — бережно выравниваем речь')}
 const reason=(found.length?'Найдено: '+found.join('; ')+'.':'Дефектов не найдено.')+(kept.length?' '+kept.map(text=>text[0].toUpperCase()+text.slice(1)).join('. ')+'.':'');
 return {id:'smart',title:'Умная обработка',hint:reason,preFilter:steps.join(','),normalize:true,outputRate:steps.includes('afftdn=nf=-30:nr=10')?48000:undefined,findings:found.length,reason};
}
export function recommendProfile(analysis){
 const smart=smartPreset(analysis);if(smart&&smart.findings)return {profile:'smart',preset:smart,reason:smart.reason};
 const base=baseRecommendation(analysis),note=smart?.reason?.startsWith('Дефектов не найдено.')?smart.reason.slice('Дефектов не найдено.'.length).trim():'';
 return note?{...base,reason:`${base.reason} ${note}`}:base;
}
function baseRecommendation(analysis){
 const loudness=analysis?.loudness||{},clipped=(analysis?.clipping?.fraction||0)>.001;
 if(!loudness.valid)return loudness.reason==='below-gate'?{profile:'quiet',reason:'Запись очень тихая.'}:{profile:'original',reason:'Запись слишком короткая для измерений.'};
 const {integrated,range}=loudness;
 if(clipped)return {profile:'gentle',reason:'В записи есть перегрузка — громкость не поднимаем, только убираем гул.'};
 if(integrated<-32||Number.isFinite(range)&&range>14)return {profile:'quiet',reason:`Голос тихий или далёкий (${Math.round(integrated)} LUFS${Number.isFinite(range)?`, перепад ${Math.round(range)} LU`:''}).`};
 if(integrated<-24||Number.isFinite(range)&&range>9)return {profile:'level',reason:`Громкость неровная (${Math.round(integrated)} LUFS${Number.isFinite(range)?`, перепад ${Math.round(range)} LU`:''}).`};
 return {profile:'gentle',reason:'Громкость в порядке — убираем только низкий гул.'};
}
