// Reset des curseurs de scan à leur SCAN_START → re-vérification (gap-fill) des bandes déjà
// scannées : les scanners re-parcourent en SKIPPANT players+dead (rapide) et re-testent les trous.
// Lancé dans un conteneur temporaire, instances arrêtées (pas de race d'écrasement).
const db = require('better-sqlite3')('/app/data/players.db');
const set = (k, v) => db.prepare('INSERT OR REPLACE INTO scan_state (key,value) VALUES (?,?)').run(k, JSON.stringify(v));
const starts = { 1: 1, 2: 167000000, 3: 334000000, 5: 500000000, 6: 575000000, 7: 650000000, 8: 725000000 };
for (const [inst, start] of Object.entries(starts)) {
  const before = (() => { const r = db.prepare("SELECT value FROM scan_state WHERE key=?").get(`cursor_inst_${inst}`); return r ? JSON.parse(r.value) : '?'; })();
  set(`cursor_inst_${inst}`, start);
  console.log(`cursor_inst_${inst}: ${before} → ${start}`);
}
db.close();
console.log('✓ curseurs reset (gap-fill prêt)');
