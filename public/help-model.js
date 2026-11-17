const hint=(id,title,text,action=null)=>({id,title,text,action});
export class GuidanceModel{
 constructor(){this.session=null;this.tracks=new Map();this.lastUpdate=null}
 update({capture={},mode='mic',dismissed=[]},now=Date.now()){
  if(capture.sessionId!==this.session||this.lastUpdate!==null&&now-this.lastUpdate>1500){this.tracks.clear();this.session=capture.sessionId}this.lastUpdate=now;
  const visible=value=>value&&!dismissed.includes(value.id)?value:null;
  if(!capture.connected||capture.errorCode){this.tracks.clear();return null}
  if(capture.state!=='recording'){
   this.tracks.clear();
   if(capture.state==='paused')return visible(hint('pause-timeline','Запись на паузе','Звук сейчас не записывается. На временной шкале сохранится пауза.'));
   if(capture.state==='ready'&&capture.recordId)return visible(hint('after-recording','Сначала прослушайте','Проверьте начало записи и слышимость участников. Расшифровку можно запустить после прослушивания.','listen'));
   if(!['idle','ready'].includes(capture.state))return null;
   return visible(['mic','browser'].includes(mode)?hint('first-mic','Перед началом','Пять секунд проверки помогут убедиться, что выбран нужный микрофон.','sound-test'):hint('meeting','Перед встречей','Выберите «Микрофон и компьютер», если нужен ваш голос. Наушники помогут избежать эха.','sound-test'));
  }
  let quiet=null,loud=null;
  for(const track of ['mic','system']){
   const level=capture.levels?.[track],fresh=level&&Number.isFinite(level.ageMs)&&level.ageMs<=1000&&level.ageMs>=0;
   if(!fresh){this.tracks.delete(track);continue}
   const state=this.tracks.get(track)||{quietSince:null,clips:0,overloadUntil:-1},name=track==='mic'?'микрофона':'компьютера';
   if(level.peak>=.99||level.clippedFrames>state.clips)state.overloadUntil=now+4000;state.clips=level.clippedFrames||0;
   state.quietSince=level.rms<=.001?(state.quietSince??now):null;this.tracks.set(track,state);
   if(now<=state.overloadUntil)loud||=hint('overload-'+track,'Громкий сигнал '+name,track==='mic'?'Уменьшите входную громкость или отодвиньте микрофон: перегрузка может искажать речь.':'Уменьшите громкость воспроизводящего приложения, если слышны искажения.');
   if(state.quietSince!==null&&now-state.quietSince>=8000)quiet||=hint('quiet-'+track,'Тихий сигнал '+name,track==='mic'?'Если вы сейчас говорите, проверьте подключение и выбранный микрофон. Сменить источник можно после завершения записи.':'Если приложение сейчас воспроизводит звук, проверьте выбранный выход. Тишина остаётся частью записи.');
  }
  return visible(loud)||visible(quiet);
 }
}
