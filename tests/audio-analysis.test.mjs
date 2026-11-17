import test from 'node:test';import assert from 'node:assert/strict';import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';import {tmpdir} from 'node:os';import path from 'node:path';import {createHash} from 'node:crypto';import {spawnSync} from 'node:child_process';
let analyzeAudio;try{({analyzeAudio}=await import('../backend/audio/analyze.mjs'))}catch{}
function wave({rate=48000,channels=1,duration=2,amplitude=.25,antiPhase=false,clipped=false,silenceAfter=Infinity}={}){
 const frames=Math.round(rate*duration),bytes=Buffer.alloc(44+frames*channels*2);bytes.write('RIFF');bytes.writeUInt32LE(bytes.length-8,4);bytes.write('WAVEfmt ',8);bytes.writeUInt32LE(16,16);bytes.writeUInt16LE(1,20);bytes.writeUInt16LE(channels,22);bytes.writeUInt32LE(rate,24);bytes.writeUInt32LE(rate*channels*2,28);bytes.writeUInt16LE(channels*2,32);bytes.writeUInt16LE(16,34);bytes.write('data',36);bytes.writeUInt32LE(frames*channels*2,40);
 for(let frame=0;frame<frames;frame++){const raw=frame/rate>=silenceAfter?0:clipped?(frame%100<50?32767:-32768):Math.round(amplitude*32767*Math.sin(2*Math.PI*1000*frame/rate));for(let channel=0;channel<channels;channel++)bytes.writeInt16LE(channel&&antiPhase?-raw:raw,44+(frame*channels+channel)*2)}return bytes;
}
async function fixture(t,bytes){assert.ok(analyzeAudio,'Read-only whole-record analysis is missing');const root=await mkdtemp(path.join(tmpdir(),"mono-analysis-quote's-"));t.after(()=>rm(root,{recursive:true,force:true,maxRetries:10,retryDelay:50}));const file=path.join(root,'original.wav');await writeFile(file,bytes);return {root,file,hash:createHash('sha256').update(bytes).digest('hex')}}
const finiteJSON=value=>assert.ok(!JSON.stringify(value).match(/NaN|Infinity|"-inf"/));

test('whole-record analysis measures independent PCM peak/RMS/frame count and preserves anti-phase source bytes',async t=>{
 const source=wave({channels:2,antiPhase:true,silenceAfter:1}),{file,hash}=await fixture(t,source),analysis=await analyzeAudio(file);assert.equal(analysis.sampleRate,48000);assert.equal(analysis.channels,2);assert.equal(analysis.frames,96000);assert.equal(analysis.duration,2);assert.equal(analysis.format.codec,'pcm_s16le');
 let peak=0,sum=0;for(let position=44;position<source.length;position+=2){const sample=source.readInt16LE(position)/32768;peak=Math.max(peak,Math.abs(sample));sum+=sample*sample}assert.ok(Math.abs(analysis.peak-20*Math.log10(peak))<.00001);assert.ok(Math.abs(analysis.rms-20*Math.log10(Math.sqrt(sum/(96000*2))))<.00001);assert.ok(analysis.truePeak>=analysis.peak-.06);assert.equal(analysis.loudness.valid,true);assert.ok(Number.isFinite(analysis.loudness.integrated));assert.ok(Math.abs(analysis.silence.fraction-.5)<.021);assert.equal(analysis.silence.heuristic,true);assert.equal(analysis.noiseHeuristic,null);assert.equal(createHash('sha256').update(await readFile(file)).digest('hex'),hash);finiteJSON(analysis);
 const reference=spawnSync('ffmpeg',['-hide_banner','-nostdin','-i',file,'-af','ebur128=peak=true','-f','null','-'],{encoding:'utf8',maxBuffer:1024**2});assert.equal(reference.status,0);const integrated=/Integrated loudness:\s+I:\s+(-?[\d.]+) LUFS/.exec(reference.stderr),truePeak=/True peak:\s+Peak:\s+(-?[\d.]+) dBFS/.exec(reference.stderr);assert.ok(integrated&&truePeak,'Separate ebur128 scanner summary is required');assert.ok(Math.abs(analysis.loudness.integrated-Number(integrated[1]))<.15);assert.ok(Math.abs(analysis.truePeak-Number(truePeak[1]))<.06);
});

test('silence, sub-gate and short audio use explicit unavailable LUFS/noise, never fabricated finite loudness',async t=>{
 for(const [name,options,reason] of [['silence',{amplitude:0},'below-gate'],['quiet',{amplitude:1/32767},'below-gate'],['short',{duration:.1},'too-short']]){const {file}=await fixture(t,wave(options)),value=await analyzeAudio(file);assert.equal(value.loudness.valid,false,name);assert.equal(value.loudness.integrated,null,name);assert.equal(value.loudness.reason,reason);assert.equal(value.noiseHeuristic,null);if(name==='silence'){assert.equal(value.peak,null);assert.equal(value.truePeak,null);assert.equal(value.rms,null);assert.equal(value.silence.fraction,1)}finiteJSON(value)}
});

test('full-scale excursion accounting distinguishes quiet audio; clipping remains an explicitly labeled heuristic',async t=>{
 const {file}=await fixture(t,wave({clipped:true})),value=await analyzeAudio(file);assert.equal(value.clipping.samples,96000);assert.equal(value.clipping.fraction,1);assert.equal(value.clipping.heuristic,true);assert.ok(value.peak<=0&&value.peak>-.001);assert.ok(value.truePeak>=value.peak);assert.equal(value.noiseHeuristic,null);
});

test('different rates and actual compressed decoder padding use decoded frames, not container duration guesses',async t=>{
 const {file,root}=await fixture(t,wave({rate:44100,duration:1.123})),compressed=path.join(root,'encoded.m4a');const encoded=spawnSync('ffmpeg',['-v','error','-i',file,'-c:a','aac',compressed]);assert.equal(encoded.status,0,encoded.stderr?.toString());const value=await analyzeAudio(compressed),decoded=spawnSync('ffmpeg',['-v','error','-i',compressed,'-map','0:a:0','-f','f32le','-c:a','pcm_f32le','pipe:1'],{maxBuffer:2*1024**2});assert.equal(decoded.status,0);assert.equal(value.frames,decoded.stdout.length/4);assert.equal(value.duration,value.frames/44100);assert.equal(value.sampleRate,44100);assert.equal(value.channels,1);finiteJSON(value);
});

test('invalid input, network protocols and playlists fail closed without exposing private media text',async t=>{
 const {file,root}=await fixture(t,Buffer.from('PRIVATE_SENTINEL_NOT_AN_AUDIO'));for(const input of [file,'https://example.invalid/private.wav'])await assert.rejects(analyzeAudio(input),error=>Boolean(error.code)&&!error.message.includes('PRIVATE_SENTINEL'));
 const playlist=path.join(root,'private.m3u8');await writeFile(playlist,'#EXTM3U\n#EXT-X-TARGETDURATION:1\n#EXTINF:1,\nfile:///private-sentinel.wav\n#EXT-X-ENDLIST\n');await assert.rejects(analyzeAudio(playlist),error=>Boolean(error.code));
});

test('cancellation reaches the real decoder and leaves the original intact',async t=>{
 const {file,hash}=await fixture(t,wave({duration:15})),controller=new AbortController();let progress=0;await assert.rejects(analyzeAudio(file,{signal:controller.signal,onProgress:seconds=>{if(seconds>0){progress++;controller.abort()}}}),error=>error.code==='CANCELLED');assert.ok(progress>0);assert.equal(createHash('sha256').update(await readFile(file)).digest('hex'),hash);
});

test('missing analysis runtime is distinguished from a damaged recording without leaking its path',async t=>{
 const {file,root}=await fixture(t,wave());await assert.rejects(analyzeAudio(file,{ffprobe:path.join(root,'missing-private-tool.exe')}),error=>error.code==='AUDIO_TOOL_UNAVAILABLE'&&!error.message.includes(root));
});
