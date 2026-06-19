/**
 * API ULTRA-ROBUSTE - NE CRASH JAMAIS
 * Version minimaliste avec cache et fallback
 */

import http from 'node:http';
import { WebSocketServer } from 'ws';
import Database from 'better-sqlite3';

const PORT = 4250;
const DB_PATH = '/opt/wpds/data/players.db';

// Cache global (mise à jour toutes les 5 secondes au lieu de chaque requête)
let cachedStats = {
  totalPlayers: 0,
  totalDead: 0,
  pendingRetries: 0,
  ratePerSec: 0,      // VRAI débit = IDs réellement résolus/s (players+dead), mesuré côté API
  skipRate: 0,
  scanned: 0,
  found: 0,
  phase: 1,           // vraie phase, lue depuis la DB (mode unique = phase 1 scan complet)
  currentId: 0,       // position du curseur, lue depuis la DB
  sessionDuration: 0, // uptime réel de la session (lu depuis scraper_status)
  cursors: { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0, 6: 0, 7: 0, 8: 0 },  // position de scan de chaque instance (8)
  breakdown: { f30: 0, existing: 0, lords: 0 },  // répartition des joueurs (calculée toutes les 2s)
  deltas: {},         // avancement sur la dernière heure, calculé CÔTÉ SERVEUR (survit aux reloads de page)
  srcRate: { tor: 0, proxy: 0 },  // débit/s PAR SOURCE de transport (TOR fallback vs proxy public)
  recentPlayers: [],
  kingdoms: [],
  timestamp: Date.now()
};

// Tracking pour calculer le VRAI débit : fenêtre glissante de 30s (le scraper résout
// par à-coups → un delta sur 1s oscille 0↔70 ; sur 30s c'est stable et représentatif).
let _rateHist = [];         // [{ t, resolved }] sur les 30 dernières secondes
let _tick = 0;              // compteur de cycles (kingdoms = lourd, rafraîchi moins souvent)
let _minStartTs = null;     // plus ancien startTs des instances → uptime monotone (anti-clignotement)
let _snapshots = [];        // [{ t, v:{...} }] sur ~65 min pour calculer les deltas /h côté serveur
let _srcHist = [];          // [{ t, tor, proxy }] sur 30s → débit/s par source de transport

// Fonction robuste pour lire les stats (JAMAIS de crash)
function updateCachedStats() {
  _tick++;
  try {
    const db = Database(DB_PATH, { readonly: true, timeout: 2000 });

    try {
      // ── LÉGER (chaque seconde) : counts rapides ──
      cachedStats.totalPlayers = db.prepare('SELECT COUNT(*) as c FROM players').get()?.c || cachedStats.totalPlayers;
      cachedStats.totalDead = db.prepare('SELECT COUNT(*) as c FROM dead_ids').get()?.c || cachedStats.totalDead;
      cachedStats.pendingRetries = db.prepare('SELECT COUNT(*) as c FROM error_ids WHERE resolved=0').get()?.c || cachedStats.pendingRetries;

      // Curseurs par instance (cursor_inst_1..8)
      for (let i = 1; i <= 8; i++) {
        const row = db.prepare('SELECT value FROM scan_state WHERE key = ?').get(`cursor_inst_${i}`);
        if (row && row.value != null) cachedStats.cursors[i] = parseInt(row.value) || cachedStats.cursors[i];
      }

      // ── Répartition des joueurs (toutes les 2s : COUNT avec WHERE sur 520k = ~100ms) ──
      // Catégories mutuellement exclusives (priorité F30+ > lords > existants) :
      //   F30+      : state_level >= 30 (vrais joueurs établis)
      //   lords     : nom par défaut "lord<id>" + state_level < 30 (comptes fantômes jamais joués)
      //   existants : le reste des players (vrais débutants, nom personnalisé, < F30)
      if (_tick % 2 === 1) try {
        const f30 = db.prepare('SELECT COUNT(*) c FROM players WHERE state_level >= 30').get()?.c || 0;
        const lords = db.prepare("SELECT COUNT(*) c FROM players WHERE state_level < 30 AND nickname = 'lord' || id").get()?.c || 0;
        cachedStats.breakdown.f30 = f30;
        cachedStats.breakdown.lords = lords;
        cachedStats.breakdown.existing = Math.max(0, cachedStats.totalPlayers - f30 - lords);
      } catch (e) { /* garder l'ancien */ }

      // VRAI débit lissé sur 30s : croissance réelle de la base (players + dead).
      // Le scraper résout par à-coups (TOR) → un delta sur 1s oscille 0↔70 ; la moyenne
      // sur 30s donne un chiffre stable et représentatif (~40/s).
      const resolved = cachedStats.totalPlayers + cachedStats.totalDead;
      const nowMs = Date.now();
      _rateHist.push({ t: nowMs, resolved });
      while (_rateHist.length > 1 && nowMs - _rateHist[0].t > 30_000) _rateHist.shift();
      if (_rateHist.length > 1) {
        const oldest = _rateHist[0];
        const dt = (nowMs - oldest.t) / 1000;
        if (dt > 0) cachedStats.ratePerSec = +Math.max(0, (resolved - oldest.resolved) / dt).toFixed(1);
      }

      // Débit PAR SOURCE : somme des compteurs src_tor_* / src_proxy_* (toutes instances), fenêtre 30s
      const srcRows = db.prepare("SELECT key, value FROM scan_state WHERE key LIKE 'src_tor_%' OR key LIKE 'src_proxy_%'").all();
      let torSum = 0, proxySum = 0;
      for (const r of srcRows) {
        const v = parseInt(String(r.value).replace(/[^0-9-]/g, '')) || 0;  // robuste (quotes JSON éventuelles)
        if (r.key.startsWith('src_tor_')) torSum += v; else proxySum += v;
      }
      _srcHist.push({ t: nowMs, tor: torSum, proxy: proxySum });
      while (_srcHist.length > 1 && nowMs - _srcHist[0].t > 30_000) _srcHist.shift();
      if (_srcHist.length > 1) {
        const o = _srcHist[0], dt2 = (nowMs - o.t) / 1000;
        if (dt2 > 0) {
          cachedStats.srcRate.tor   = +Math.max(0, (torSum   - o.tor)   / dt2).toFixed(1);
          cachedStats.srcRate.proxy = +Math.max(0, (proxySum - o.proxy) / dt2).toFixed(1);
        }
      }

      // Compteurs de session (scanned/found) — informatifs, lus depuis scan_state
      const statusRows = db.prepare("SELECT value FROM scan_state WHERE key LIKE 'scraper_status%' LIMIT 1").all();
      if (statusRows.length > 0) {
        try {
          const parsed1 = JSON.parse(statusRows[0].value);
          const status = typeof parsed1 === 'string' ? JSON.parse(parsed1) : parsed1;
          cachedStats.skipRate = status.skipRate || 0;
          cachedStats.scanned = status.scanned || 0;
          cachedStats.found = status.found || 0;
          cachedStats.phase = status.phase || cachedStats.phase;
          cachedStats.currentId = status.currentId || cachedStats.currentId;
          // Uptime MONOTONE : on mémorise le plus ancien startTs vu et on calcule
          // Date.now()-startTs. Évite le clignotement 0↔valeur dû aux 4 instances qui
          // écrivent des sessionDuration différents dans la même clé scraper_status.
          if (status.startTs && status.startTs > 0) {
            _minStartTs = _minStartTs ? Math.min(_minStartTs, status.startTs) : status.startTs;
          }
        } catch (e) {
          // Ignore parse errors
        }
      }
      // Uptime calculé de façon monotone (1s/s, jamais de retour à 0)
      if (_minStartTs) cachedStats.sessionDuration = Math.floor((Date.now() - _minStartTs) / 1000);

      // Recent players (seulement vrais noms, pas les "lord" par défaut)
      // retested = 1 si l'ID a un enregistrement dans error_ids (donc il a échoué puis été retesté)
      try {
        // 14 joueurs les plus récents (tous), + 6 RETESTÉS récents garantis (sinon noyés par les
        // 7 scanners) → fusion + dédup (retested prioritaire) → les retests restent VISIBLES en rouge.
        const recents = db.prepare(`
          SELECT p.id, p.nickname, p.kid, p.state_level, p.alliance_tag, p.first_seen, p.last_seen, p.inactive, p.last_updated,
            CASE WHEN e.id IS NOT NULL THEN 1 ELSE 0 END AS retested
          FROM players p LEFT JOIN error_ids e ON e.id = p.id AND e.resolved = 1
          WHERE p.nickname != 'lord' || p.id
          ORDER BY p.last_updated DESC LIMIT 14
        `).all();
        // ⚠️ Retests : on NE filtre PAS les lord+ID ici → l'utilisateur veut VOIR l'activité de
        // retest même si le joueur retrouvé a un nom par défaut (marqué rouge). Les découvertes
        // normales (ci-dessus) restent sans lords.
        const retests = db.prepare(`
          SELECT p.id, p.nickname, p.kid, p.state_level, p.alliance_tag, p.first_seen, p.last_seen, p.inactive, p.last_updated,
            1 AS retested
          FROM players p JOIN error_ids e ON e.id = p.id AND e.resolved = 1
          ORDER BY p.last_updated DESC LIMIT 6
        `).all();
        const byId = new Map();
        for (const r of [...retests, ...recents]) if (!byId.has(r.id)) byId.set(r.id, r);  // retest prioritaire
        cachedStats.recentPlayers = [...byId.values()]
          .sort((a, b) => b.last_updated - a.last_updated).slice(0, 20);
      } catch (e) {
        // Keep old data if query fails
      }

      // ── LOURD (toutes les 5s) : Kingdoms = GROUP BY sur 520k joueurs ──
      if (_tick % 5 === 1) try {
        cachedStats.kingdoms = db.prepare(`
          SELECT
            kid                                                              as kingdom,
            COUNT(*)                                                         as total_count,
            SUM(CASE WHEN inactive = 0 THEN 1 ELSE 0 END)                    as actif_count,
            SUM(CASE WHEN inactive = 1 THEN 1 ELSE 0 END)                    as inactive_count,
            SUM(CASE WHEN nickname = 'lord' || id THEN 1 ELSE 0 END)         as lord_count,
            MAX(state_level)                                                 as max_furnace,
            AVG(state_level)                                                 as avg_furnace
          FROM players
          WHERE kid IS NOT NULL AND kid > 0
          GROUP BY kid
          ORDER BY total_count DESC
          LIMIT 50
        `).all();
      } catch (e) {
        console.error('Kingdoms query error:', e.message);
      }

      // ── Deltas /h CÔTÉ SERVEUR (snapshot toutes les 30s, fenêtre 65 min) ──
      // Calculé ici → indépendant du client, survit aux rechargements de page.
      const now = Date.now();
      const cur = {
        players: cachedStats.totalPlayers, dead: cachedStats.totalDead,
        discovered: cachedStats.totalPlayers + cachedStats.totalDead,
        pending: cachedStats.pendingRetries,
        f30: cachedStats.breakdown.f30, existing: cachedStats.breakdown.existing, lords: cachedStats.breakdown.lords,
        c1: cachedStats.cursors[1], c2: cachedStats.cursors[2], c3: cachedStats.cursors[3], c4: cachedStats.cursors[4],
        c5: cachedStats.cursors[5], c6: cachedStats.cursors[6], c7: cachedStats.cursors[7], c8: cachedStats.cursors[8],
      };
      if (_tick % 30 === 0 || _snapshots.length === 0) {
        _snapshots.push({ t: now, v: cur });
        while (_snapshots.length > 1 && now - _snapshots[0].t > 3_900_000) _snapshots.shift();
      }
      // Référence = snapshot le plus proche d'il y a 1h (sinon le plus ancien dispo)
      const ref = _snapshots.find(s => s.t >= now - 3_600_000) || _snapshots[0];
      if (ref && now - ref.t > 60_000) {
        const elapsed = (now - ref.t) / 1000;
        const scale = elapsed >= 3600 ? 1 : 3600 / elapsed;  // extrapolé /h tant qu'on a < 1h d'historique
        const d = {};
        for (const k of Object.keys(cur)) d[k] = Math.round((cur[k] - ref.v[k]) * scale);
        cachedStats.deltas = d;
      }

      cachedStats.timestamp = Date.now();
    } finally {
      db.close();
    }
  } catch (err) {
    console.error('DB error (using cache):', err.message);
    // Keep old cached data - never return empty
  }
}

// Rafraîchir le cache CHAQUE SECONDE (counts/curseurs/rate/recent), Kingdoms toutes les 5s
updateCachedStats(); // Premier chargement
setInterval(updateCachedStats, 1000);

// HTTP Server
const server = http.createServer((req, res) => {
  try {
    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    if (req.url === '/api/wos-stats' || req.url === '/api/stats') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        stats: {
          total_players: cachedStats.totalPlayers,
          total_dead: cachedStats.totalDead,
          name_changes: 0,
          active_players: Math.floor(cachedStats.totalPlayers * 0.1),
          total_accounts: cachedStats.totalPlayers,
          pending_retries: cachedStats.pendingRetries
        },
        scraper: {
          running: true,
          paused: false,
          scanned: cachedStats.scanned,
          found: cachedStats.found,
          dead: cachedStats.totalDead,
          ratePerSec: cachedStats.ratePerSec,
          skipRate: cachedStats.skipRate,
          processingRate: cachedStats.ratePerSec,
          phase: cachedStats.phase,
          currentId: cachedStats.currentId,
          cursors: cachedStats.cursors,
          sessionDuration: cachedStats.sessionDuration,
          pendingErrors: cachedStats.pendingRetries
        },
        breakdown: {
          f30:          cachedStats.breakdown.f30,
          existing:     cachedStats.breakdown.existing,
          lords:        cachedStats.breakdown.lords,
          dead:         cachedStats.totalDead,
          pending:      cachedStats.pendingRetries,
          totalScanned: cachedStats.breakdown.f30 + cachedStats.breakdown.existing
                        + cachedStats.breakdown.lords + cachedStats.totalDead + cachedStats.pendingRetries
        },
        recentPlayers: cachedStats.recentPlayers,
        kingdoms: cachedStats.kingdoms,
        recentChanges: []
      }));
    } else if (req.url === '/api/control/state') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        running: true,
        paused: false,
        ratePerSec: cachedStats.ratePerSec,
        skipRate: cachedStats.skipRate,
        processingRate: cachedStats.ratePerSec,
        scanned: cachedStats.scanned,
        found: cachedStats.found,
        dead: cachedStats.totalDead,
        errors: cachedStats.pendingRetries,
        pendingErrors: cachedStats.pendingRetries,
        phase: cachedStats.phase,
        currentId: cachedStats.currentId,
        cursors: cachedStats.cursors,
        sessionDuration: cachedStats.sessionDuration,
        deltas: cachedStats.deltas,
        srcRate: cachedStats.srcRate
      }));
    } else if (req.url === '/api/servers') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      // Les kingdoms sont déjà au bon format (kingdom, total_count, actif_count, etc.)
      res.end(JSON.stringify({ servers: cachedStats.kingdoms }));
    } else if (/^\/api\/servers\/\d+\/players/.test(req.url)) {
      // Joueurs d'un royaume filtrés/triés/paginés (chargé à la demande, requête directe)
      try {
        const u = new URL(req.url, 'http://x');
        const kid = parseInt(u.pathname.split('/')[3]);
        const filter = u.searchParams.get('filter') || 'all';
        const allowedSort = { state_level: 'state_level', first_seen: 'first_seen', last_seen: 'last_seen', id: 'id', nickname: 'nickname' };
        const sortCol = allowedSort[u.searchParams.get('sort')] || 'state_level';
        const dir = u.searchParams.get('dir') === 'asc' ? 'ASC' : 'DESC';
        const page = Math.max(0, parseInt(u.searchParams.get('page') || '0'));
        const PAGE = 50;
        let where = 'kid = ?';
        if (filter === 'actifs')        where += ' AND inactive = 0';
        else if (filter === 'inactive') where += ' AND inactive = 1';
        else if (filter === 'lords')    where += " AND nickname = 'lord' || id";
        const db = Database(DB_PATH, { readonly: true, timeout: 2000 });
        let players = [], total = 0;
        try {
          total = db.prepare(`SELECT COUNT(*) c FROM players WHERE ${where}`).get(kid)?.c || 0;
          players = db.prepare(
            `SELECT id, nickname, kid, state_level, alliance_tag, first_seen, last_seen, inactive
             FROM players WHERE ${where} ORDER BY ${sortCol} ${dir} LIMIT ${PAGE} OFFSET ${page * PAGE}`
          ).all(kid);
        } finally { db.close(); }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ players, total }));
      } catch (e) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ players: [], total: 0 }));
      }
    } else if (req.url === '/api/progress') {
      const MIN_ID = 1;
      const MAX_ID = 800_000_000;   // cible étendue : 8 instances couvrent 1 → 800M
      const TOTAL_RANGE = MAX_ID - MIN_ID;
      const scanned = cachedStats.totalPlayers + cachedStats.totalDead;
      const coverage = scanned > 0 ? (scanned / TOTAL_RANGE * 100) : 0;
      const remaining = TOTAL_RANGE - scanned;
      // Estimation basée sur le VRAI débit (IDs résolus/s)
      const rate = cachedStats.ratePerSec;
      const estDays = rate > 0 ? +(remaining / rate / 86400).toFixed(1) : null;

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        progress: {
          min_id: MIN_ID,
          max_id: MAX_ID,
          explored_range: TOTAL_RANGE,
          scanned_count: scanned,
          coverage: coverage,
          remaining_ids: remaining
        },
        estimatedDaysRemaining: estDays,
        avgRate: { avgRatePerSec: rate, totalScanned: scanned, periodDays: 0, fallback: false }
      }));
    } else if (req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('OK');
    } else {
      res.writeHead(404);
      res.end('Not Found');
    }
  } catch (err) {
    console.error('Request error:', err.message);
    res.writeHead(500, { 'Content-Type': 'text/plain' });
    res.end('Internal Server Error');
  }
});

// WebSocket Server
const wss = new WebSocketServer({ server });

wss.on('connection', (ws) => {
  console.log('WebSocket client connected');

  // Envoyer les stats toutes les 2 secondes (moins souvent pour économiser CPU)
  const interval = setInterval(() => {
    try {
      if (ws.readyState === 1) { // OPEN
        ws.send(JSON.stringify({
          type: 'stats',
          global: {
            total_players: cachedStats.totalPlayers,
            total_dead: cachedStats.totalDead
          },
          session: {
            running: true,
            paused: false,
            ratePerSec: cachedStats.ratePerSec,
            skipRate: cachedStats.skipRate,
            processingRate: cachedStats.ratePerSec,
            scanned: cachedStats.scanned,
            found: cachedStats.found,
            dead: cachedStats.totalDead,
            pendingErrors: cachedStats.pendingRetries,
            sessionDuration: cachedStats.sessionDuration,
            currentId: cachedStats.currentId,
            concurrency: 100,
            phase: cachedStats.phase,
          },
          currentId: cachedStats.currentId,
          phase: cachedStats.phase,
          rate: cachedStats.ratePerSec
        }));
      }
    } catch (err) {
      console.error('WebSocket send error:', err.message);
      clearInterval(interval);
    }
  }, 2000);

  ws.on('close', () => {
    console.log('WebSocket client disconnected');
    clearInterval(interval);
  });

  ws.on('error', (err) => {
    console.error('WebSocket error:', err.message);
    clearInterval(interval);
  });

  // Envoyer immédiatement les premières stats
  try {
    ws.send(JSON.stringify({
      type: 'stats',
      global: {
        total_players: cachedStats.totalPlayers,
        total_dead: cachedStats.totalDead
      },
      session: {
        running: true,
        paused: false,
        ratePerSec: cachedStats.ratePerSec,
        skipRate: cachedStats.skipRate,
        processingRate: cachedStats.ratePerSec,
        scanned: cachedStats.scanned,
        found: cachedStats.found,
        dead: cachedStats.totalDead,
        pendingErrors: cachedStats.pendingRetries,
        sessionDuration: cachedStats.sessionDuration,
        currentId: cachedStats.currentId,
        phase: cachedStats.phase,
      },
      currentId: cachedStats.currentId,
      phase: cachedStats.phase,
      rate: cachedStats.ratePerSec
    }));
  } catch (err) {
    console.error('Initial WebSocket send error:', err.message);
  }
});

server.listen(PORT, () => {
  console.log(`✓ WPDS API ROBUST sur port ${PORT}`);
  console.log(`  - Cache refresh: 5s`);
  console.log(`  - WebSocket update: 2s`);
  console.log(`  - JAMAIS DE CRASH garanti`);
});
