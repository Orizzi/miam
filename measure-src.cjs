const db = require('better-sqlite3')('/app/data/players.db');
const g = k => { const r = db.prepare('SELECT value FROM scan_state WHERE key=?').get(k); return r && r.value != null ? parseInt(r.value) : 0; };
const keys = db.prepare("SELECT key, value FROM scan_state WHERE key LIKE 'src_%'").all();
console.log('Cles src_* presentes:', JSON.stringify(keys));
const t0 = g('src_tor_1'), p0 = g('src_proxy_1'), gt = Date.now();
setTimeout(() => {
  const t1 = g('src_tor_1'), p1 = g('src_proxy_1'), s = (Date.now() - gt) / 1000;
  console.log('TOR   : ' + ((t1 - t0) / s).toFixed(1) + '/s (cumul ' + t1 + ')');
  console.log('PROXY : ' + ((p1 - p0) / s).toFixed(1) + '/s (cumul ' + p1 + ')');
  console.log('TOTAL : ' + ((t1 - t0 + p1 - p0) / s).toFixed(1) + '/s');
  db.close();
}, 30000);
