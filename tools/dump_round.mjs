import fs from 'node:fs';
const S = {0:'你',1:'下家',2:'对家',3:'上家'};
const SYM = {S:'♠',H:'♥',D:'♦',C:'♣'};
const ct = (c) => (c||[]).map(x=>`${SYM[x.suit]}${x.rank}`).join(' ');
const ids = process.argv.slice(2);
const replays = JSON.parse(fs.readFileSync('tools/extracted/replays.json','utf-8'));
for (const r of replays) {
  if (!ids.includes(r.id)) continue;
  console.log(`\n==== ${r.id} 第${r.round}副 level=${r.level} engine=${r.localAiEngine} places=${r.places} finishOrder=${r.finishOrder} winTeam=${r.winTeam} up=${r.upLabel||''}`);
  for (const t of r.trickLog) {
    let line = `turn${String(t.turn).padStart(3)} 轮${t.trickNumber} ${S[t.seat]}:${t.action}`;
    if (t.action==='play') line += ` ${ct(t.cards)}(${t.handType})`;
    line += ` [${t.countsBefore}]`;
    if (t.decisionMeta?.reason) line += ` #${t.decisionMeta.reason.slice(0,70)}`;
    console.log(line);
  }
}
