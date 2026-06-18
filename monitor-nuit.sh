#!/bin/bash
# Monitoring nuit — log l'état du scraper toutes les 5 min avec timestamp.
LOG=/opt/wpds/journal_nuit_serveur.log
echo "=== Monitoring nuit démarré $(date '+%F %T') ===" >> "$LOG"
while true; do
  TS=$(date '+%F %T')
  READ=$(sudo docker exec wpds1 node -e "
    const db=require('better-sqlite3')('/app/data/players.db',{readonly:true});
    const g=k=>{const r=db.prepare('SELECT value FROM scan_state WHERE key=?').get(k);return r?parseInt(String(r.value).replace(/[^0-9-]/g,''))||0:0;};
    const players=db.prepare('SELECT COUNT(*) c FROM players').get().c;
    const dead=db.prepare('SELECT COUNT(*) c FROM dead_ids').get().c;
    const pend=db.prepare('SELECT COUNT(*) c FROM error_ids WHERE resolved=0').get().c;
    let tor=0,prox=0; for(let i=1;i<=8;i++){tor+=g('src_tor_'+i);prox+=g('src_proxy_'+i);}
    console.log('players='+players+' dead='+dead+' resolved='+(players+dead)+' pending='+pend+' torCum='+tor+' proxyCum='+prox);
    db.close();
  " 2>/dev/null)
  POOL=$(sudo docker logs wpds1 --since 6m 2>&1 | grep -oE 'Proxy pool : [0-9]+ vivants' | tail -1)
  PF=$(sudo docker logs wpds1 --since 6m 2>&1 | grep -oE 'proxyFails/[0-9]+\] ok=[0-9]+ timeout=[0-9]+ neterr=[0-9]+ 403=[0-9]+ 4xx=[0-9]+ 5xx=[0-9]+ 429=[0-9]+' | tail -1)
  echo "[$TS] $READ | ${POOL:-pool:?} | ${PF:-fails:?}" >> "$LOG"
  sleep 300
done
