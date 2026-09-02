import fs from 'node:fs';
const S = {0:'你',1:'下家',2:'对家',3:'上家'};
const SYM = {S:'♠',H:'♥',D:'♦',C:'♣'};
const ct = (c) => (c||[]).map(x=>`${SYM[x.suit]}${x.rank}`).join(' ');
const replays = JSON.parse(fs.readFileSync('tools/extracted/replays.json','utf-8'));
const today = replays.filter(r => String(r.endedAt||'').slice(0,10)==='2026-08-31');
let total=0;
for (const r of today) {
  const log=r.trickLog;
  let curTrickStart=0; let lastPlaySeat=null; let lastPlay=null; let lastPlayCards=null; let lastPlayType=null;
  const hits=[];
  for (let i=0;i<log.length;i++){
    const t=log[i];
    if(i===0||t.trickNumber!==log[i-1].trickNumber){ curTrickStart=i; lastPlaySeat=null; lastPlay=null; lastPlayCards=null; lastPlayType=null; }
    if(t.action==='play'){
      // 对家(2)在轮到它时直接压了台面上最后一手，且最后一手是队友(0或2自己刚出)
      if(t.seat===2 && lastPlaySeat===0){
        hits.push(`轮${t.trickNumber} turn${t.turn}: 你出 ${ct(lastPlayCards)}(${lastPlayType}) -> 对家压 ${ct(t.cards)}(${t.handType})`);
      }
      lastPlaySeat=t.seat; lastPlay=t; lastPlayCards=t.cards; lastPlayType=t.handType;
    }
  }
  if(hits.length){ total+=hits.length; console.log(`第${r.round}副 places=${r.places} winTeam=${r.winTeam}:`); hits.forEach(h=>console.log('  '+h)); }
}
console.log('对家直接压你合计:',total);
