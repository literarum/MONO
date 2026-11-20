import test from 'node:test';import assert from 'node:assert/strict';import {execFileSync} from 'node:child_process';import {mkdtemp,rm,stat} from 'node:fs/promises';import {tmpdir} from 'node:os';import path from 'node:path';
import {extractionPlan,extractAudio,probeAudio} from '../backend/local/media-extract.mjs';
const have=tool=>{try{execFileSync(tool,['-version'],{stdio:'ignore'});return true}catch{return false}};
const skip=!(have('ffmpeg')&&have('ffprobe'))&&'ffmpeg is not installed';

test('the audio stream is copied when the browser plays it as is, re-encoded otherwise',()=>{
 assert.deepEqual(extractionPlan('aac'),{format:'ipod',mime:'audio/mp4',args:['-c:a','copy','-movflags','+faststart']});
 assert.equal(extractionPlan('opus').mime,'audio/webm');assert.equal(extractionPlan('mp3').mime,'audio/mpeg');
 assert.deepEqual(extractionPlan('pcm_s16le').args,['-c:a','libopus','-b:a','96k']);
});
test('a real video becomes its audio track; a silent video is refused clearly',{skip},async t=>{
 const dir=await mkdtemp(path.join(tmpdir(),'mono-video-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const video=path.join(dir,'talk.mp4'),silent=path.join(dir,'silent.mp4'),out=path.join(dir,'out');
 execFileSync('ffmpeg',['-v','error','-f','lavfi','-i','testsrc=size=160x120:rate=10','-f','lavfi','-i','sine=frequency=440:sample_rate=44100','-t','3','-c:v','libx264','-pix_fmt','yuv420p','-c:a','aac','-shortest',video]);
 execFileSync('ffmpeg',['-v','error','-f','lavfi','-i','testsrc=size=160x120:rate=10','-t','1','-c:v','libx264','-pix_fmt','yuv420p',silent]);
 const result=await extractAudio({ffmpeg:'ffmpeg',ffprobe:'ffprobe',input:video,output:out});
 assert.equal(result.mime,'audio/mp4');assert.equal(result.copied,true);assert.ok(result.duration>2.5&&result.duration<3.6,String(result.duration));
 const probed=await probeAudio('ffprobe',out);assert.equal(probed.codec,'aac');
 const streams=execFileSync('ffprobe',['-v','error','-show_entries','stream=codec_type','-of','csv=p=0',out]).toString().trim().split(/\s+/);
 assert.deepEqual(streams,['audio'],'no video stream is kept');
 assert.ok((await stat(out)).size<(await stat(video)).size);
 await assert.rejects(extractAudio({ffmpeg:'ffmpeg',ffprobe:'ffprobe',input:silent,output:out}),error=>error.code==='NO_AUDIO');
});
test('«Авто» chooses processing from the measurement of the original, conservatively',async()=>{
 const {recommendProfile,publicProfiles}=await import('../backend/audio/profiles.mjs');
 const m=(integrated,range,clip=0,valid=true,reason=null)=>({loudness:{valid,integrated,range,reason},clipping:{fraction:clip}});
 assert.equal(recommendProfile(m(-20,6)).profile,'gentle','a normal recording is only cleaned of rumble');
 assert.equal(recommendProfile(m(-27,6)).profile,'level');assert.equal(recommendProfile(m(-21,11)).profile,'level');
 assert.equal(recommendProfile(m(-35,8)).profile,'quiet');assert.equal(recommendProfile(m(-22,16)).profile,'quiet');
 assert.equal(recommendProfile(m(-35,8,.01)).profile,'gentle','clipped audio is never boosted');
 assert.equal(recommendProfile(m(null,null,0,false,'below-gate')).profile,'quiet');
 assert.equal(recommendProfile(m(null,null,0,false,'too-short')).profile,'original');
 assert.match(recommendProfile(m(-35,8)).reason,/-35 LUFS/);
 const list=publicProfiles();assert.equal(list[0].id,'auto');assert.equal(list.find(p=>p.recommended).id,'auto');
 for(const id of ['quiet','speech'])assert.ok(list.some(p=>p.id===id));
});
test('spectral waveform: loudness per slice and brightness (vowel-like low, hiss-like high)',{skip},async t=>{
 const {computePeaks,binsFrom}=await import('../backend/audio/peaks.mjs');
 assert.deepEqual(binsFrom({rms:[],zcr:[]},10),{peaks:[],brightness:[]});
 const dir=await mkdtemp(path.join(tmpdir(),'mono-peaks-'));t.after(()=>rm(dir,{recursive:true,force:true}));const file=path.join(dir,'a.wav');
 // 2 s of a low tone, then 2 s of white noise
 execFileSync('ffmpeg',['-v','error','-f','lavfi','-i','sine=frequency=150:duration=2','-f','lavfi','-i','anoisesrc=color=white:duration=2:amplitude=0.3','-filter_complex','[0][1]concat=n=2:v=0:a=1','-ar','16000',file]);
 const value=await computePeaks([file],{ffmpeg:'ffmpeg',bins:8});
 assert.ok(value.duration>3.9&&value.duration<4.1,String(value.duration));assert.equal(value.peaks.length,8);
 assert.ok(value.brightness.slice(0,3).every(b=>b<.3),'tone is dark: '+value.brightness);assert.ok(value.brightness.slice(5).every(b=>b>.7),'noise is bright: '+value.brightness);
 assert.ok(value.peaks.every(p=>p>0&&p<=1));
});
