/**
 * dashboard.mjs — Serveur Express + WebSocket pour le dashboard WPDS
 * Accessible depuis orizzi.io/WPDS
 */

import express from "express";
import { WebSocketServer } from "ws";
import { createServer } from "node:http";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import {
  getStats,
  getRecentChanges,
  getRecentPlayers,
  getRecentLog,
  searchNickname,
  getPlayer,
  getPlayerHistory,
  getState,
  setState,
  popEvents,
  db,
} from "./db.mjs";

const __dir = dirname(fileURLToPath(import.meta.url));

const app = express();
const server = createServer(app);
const wss = new WebSocketServer({ server });

const PORT = process.env.PORT || 4242;

// ─── WebSocket broadcast ──────────────────────────────────────────────────────

const clients = new Set();

wss.on("connection", (ws) => {
  clients.add(ws);
  // Envoyer l'état initial
  ws.send(JSON.stringify({ type: "init", stats: getStats(), log: getRecentLog(50) }));
  ws.on("close", () => clients.delete(ws));
});

function broadcast(data) {
  const msg = JSON.stringify(data);
  for (const client of clients) {
    if (client.readyState === 1) client.send(msg);
  }
}

// ─── Poll SQLite toutes les 2s → push WS ──────────────────────────────────────

let lastEventId = 0;

setInterval(() => {
  if (clients.size === 0) return;

  // 1. Stats du scraper
  const raw = getState("scraper_status", null);
  if (raw) {
    try {
      const s = typeof raw === "string" ? JSON.parse(raw) : raw;
      const stats = getStats();
      broadcast({
        type:      "stats",
        session:   { scanned: s.scanned, found: s.found, dead: s.dead, errors: s.errors },
        global:    stats,
        rate:      { callsPerSec: s.ratePerSec, delayMs: s.delay },
        paused:    s.paused,
        phase:     s.phase,
        currentId: s.currentId,
      });
    } catch {}
  }

  // 2. Nouveaux events (found, changed…) depuis le scraper
  const events = popEvents(lastEventId);
  for (const ev of events) {
    lastEventId = ev.id;
    broadcast({ type: ev.type, ...ev.payload });
  }
}, 2000);

// ─── API REST ────────────────────────────────────────────────────────────────

app.get("/api/stats", (_req, res) => {
  res.json({
    stats: getStats(),
    recentChanges: getRecentChanges(20),
    recentPlayers: getRecentPlayers(20),
    log: getRecentLog(30),
    delay: getState("last_delay", 1500),
    phase: getState("phase", 1),
  });
});

app.get("/api/player/:id", (req, res) => {
  const id = parseInt(req.params.id);
  if (!Number.isFinite(id)) return res.status(400).json({ error: "invalid_id" });
  const player = getPlayer(id);
  if (!player) return res.status(404).json({ error: "not_found" });
  const history = getPlayerHistory(id);
  res.json({ player, history });
});

app.get("/api/search", (req, res) => {
  const q = String(req.query.q ?? "").trim();
  if (!q || q.length < 2) return res.status(400).json({ error: "query_too_short" });
  res.json({ results: searchNickname(q) });
});

// ── Stats par serveur (kingdom) ───────────────────────────────────────────────

app.get("/api/servers", (req, res) => {
  // Résumé : nombre de joueurs et max furnace par kingdom
  const summary = db.prepare(`
    SELECT
      kid                          AS kingdom,
      COUNT(*)                     AS player_count,
      MAX(state_level)             AS max_furnace,
      AVG(state_level)             AS avg_furnace,
      SUM(CASE WHEN alliance_tag != '' THEN 1 ELSE 0 END) AS with_alliance,
      MIN(id)                      AS min_id,
      MAX(id)                      AS max_id
    FROM players
    WHERE LOWER(nickname) != 'lord' || CAST(id AS TEXT)
    GROUP BY kid
    ORDER BY player_count DESC
  `).all();
  res.json({ servers: summary });
});

app.get("/api/servers/:kid/players", (req, res) => {
  const kid    = parseInt(req.params.kid);
  if (!Number.isFinite(kid)) return res.status(400).json({ error: "invalid_kid" });

  const sort  = ["id", "nickname", "state_level", "first_seen", "last_seen"].includes(req.query.sort)
    ? req.query.sort : "id";
  const dir   = req.query.dir === "desc" ? "DESC" : "ASC";
  const page  = Math.max(0, parseInt(req.query.page ?? 0));
  const limit = 100;
  const offset = page * limit;

  const players = db.prepare(`
    SELECT id, nickname, kid, state_level, alliance_tag, first_seen, last_seen
    FROM players
    WHERE kid = ?
      AND LOWER(nickname) != 'lord' || CAST(id AS TEXT)
    ORDER BY ${sort} ${dir}
    LIMIT ? OFFSET ?
  `).all(kid, limit, offset);

  const total = db.prepare(`
    SELECT COUNT(*) AS cnt FROM players
    WHERE kid = ? AND LOWER(nickname) != 'lord' || CAST(id AS TEXT)
  `).get(kid).cnt;

  res.json({ players, total, page, limit });
});

// ─── Contrôle du scraper (via SQLite — fonctionne cross-process) ─────────────

app.use(express.json());

app.post("/api/control", (req, res) => {
  const { action, value } = req.body ?? {};

  switch (action) {
    case "pause":
      setState("cmd_pause", true);
      return res.json({ ok: true, paused: true });

    case "resume":
      setState("cmd_pause", false);
      return res.json({ ok: true, paused: false });

    case "jumpTo": {
      const n = parseInt(value);
      if (!Number.isFinite(n) || n <= 0) return res.json({ ok: false });
      setState("cmd_jump", n);
      return res.json({ ok: true });
    }

    case "resetPhase": {
      const p = value === 2 ? 2 : 1;
      setState("cmd_reset_phase", p);
      return res.json({ ok: true, phase: p });
    }

    default:
      return res.status(400).json({ error: "unknown_action" });
  }
});

app.get("/api/control/state", (_req, res) => {
  const raw = getState("scraper_status", null);
  const s   = raw ? (typeof raw === "string" ? JSON.parse(raw) : raw) : {};
  res.json({
    running:   s.running   ?? true,
    paused:    s.paused    ?? getState("cmd_pause", false),
    delay:     s.delay     ?? getState("last_delay", 1500),
    phase:     s.phase     ?? getState("phase", 1),
    currentId: s.currentId ?? null,
  });
});

// ─── Dashboard HTML ───────────────────────────────────────────────────────────

app.get("/", (_req, res) => {
  res.send(HTML_DASHBOARD);
});

// ─── Démarrage ────────────────────────────────────────────────────────────────

server.listen(PORT, () => {
  console.log(`🖥️  Dashboard WPDS sur http://localhost:${PORT}`);
});

// ─── HTML du dashboard (inline) ───────────────────────────────────────────────

const HTML_DASHBOARD = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>WPDS — WOS Player Data Scraper</title>
<style>
  :root {
    --bg: #0a0f1e;
    --surface: rgba(255,255,255,0.04);
    --surface2: rgba(255,255,255,0.07);
    --border: rgba(255,255,255,0.08);
    --text: #e8edf8;
    --muted: #8090b0;
    --faint: #445060;
    --ember: #ff7a18;
    --ice: #86e7ff;
    --green: #34d399;
    --red: #f87171;
    --amber: #fbbf24;
  }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { background: var(--bg); color: var(--text); font-family: 'Inter', system-ui, sans-serif; font-size: 14px; min-height: 100vh; }
  a { color: var(--ice); text-decoration: none; }
  a:hover { text-decoration: underline; }

  /* Header */
  .header {
    background: rgba(0,0,0,0.3);
    border-bottom: 1px solid var(--border);
    padding: 14px 24px;
    display: flex;
    align-items: center;
    gap: 16px;
    position: sticky;
    top: 0;
    z-index: 10;
    backdrop-filter: blur(12px);
  }
  .header__title { font-size: 18px; font-weight: 700; color: var(--ember); }
  .header__sub { font-size: 12px; color: var(--muted); }
  .status-dot { width: 8px; height: 8px; border-radius: 50%; background: var(--green); box-shadow: 0 0 6px var(--green); animation: pulse 2s infinite; margin-left: auto; }
  .status-dot.offline { background: var(--red); box-shadow: none; animation: none; }
  @keyframes pulse { 0%,100%{opacity:1} 50%{opacity:0.5} }

  /* Layout */
  .container { max-width: 1400px; margin: 0 auto; padding: 20px 24px; }
  .grid { display: grid; gap: 16px; }
  .grid--2 { grid-template-columns: repeat(2, 1fr); }
  .grid--3 { grid-template-columns: repeat(3, 1fr); }
  .grid--4 { grid-template-columns: repeat(4, 1fr); }
  @media(max-width:900px){ .grid--4,.grid--3 { grid-template-columns: repeat(2,1fr); } .grid--2 { grid-template-columns: 1fr; } }
  @media(max-width:500px){ .grid--4,.grid--3,.grid--2 { grid-template-columns: 1fr; } }

  /* Cards */
  .card {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 14px;
    padding: 18px 20px;
  }
  .card__title {
    font-size: 11px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.1em;
    color: var(--muted);
    margin-bottom: 12px;
  }

  /* KPI */
  .kpi { text-align: center; }
  .kpi__val { font-size: 32px; font-weight: 800; color: var(--text); line-height: 1; }
  .kpi__val--ember { color: var(--ember); }
  .kpi__val--green { color: var(--green); }
  .kpi__val--ice   { color: var(--ice);   }
  .kpi__val--amber { color: var(--amber); }
  .kpi__label { font-size: 11px; color: var(--muted); margin-top: 6px; }

  /* Scraper status */
  .scraper-bar {
    display: flex;
    align-items: center;
    gap: 20px;
    flex-wrap: wrap;
  }
  .scraper-stat { display: flex; flex-direction: column; gap: 2px; }
  .scraper-stat__val { font-size: 20px; font-weight: 700; }
  .scraper-stat__label { font-size: 10px; color: var(--muted); text-transform: uppercase; letter-spacing: 0.08em; }

  /* Table */
  .table-wrap { overflow-x: auto; }
  table { width: 100%; border-collapse: collapse; font-size: 13px; }
  th { text-align: left; font-size: 10px; text-transform: uppercase; letter-spacing: 0.08em; color: var(--faint); padding: 6px 10px; border-bottom: 1px solid var(--border); }
  td { padding: 8px 10px; border-bottom: 1px solid rgba(255,255,255,0.03); }
  tr:hover td { background: var(--surface2); }
  .id-link { color: var(--muted); font-size: 12px; font-family: monospace; }
  .id-link:hover { color: var(--ice); }
  .kid-badge { font-size: 11px; color: var(--amber); background: rgba(251,191,36,0.10); padding: 2px 8px; border-radius: 10px; }
  .change-field { font-size: 11px; color: var(--muted); }
  .change-old { color: var(--red); text-decoration: line-through; }
  .change-new { color: var(--green); }

  /* Throughput chart */
  .sparkline { display: flex; align-items: flex-end; gap: 2px; height: 40px; }
  .sparkline__bar { flex: 1; min-width: 3px; border-radius: 2px 2px 0 0; background: var(--ember); opacity: 0.7; transition: height 0.3s; }

  /* Search */
  .search-row { display: flex; gap: 10px; margin-bottom: 16px; }
  .search-input {
    flex: 1;
    background: var(--surface2);
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 8px 14px;
    color: var(--text);
    font-size: 14px;
    outline: none;
  }
  .search-input:focus { border-color: var(--ember); }
  .search-btn {
    background: var(--ember);
    border: none;
    border-radius: 8px;
    padding: 8px 18px;
    color: #000;
    font-weight: 700;
    cursor: pointer;
    font-size: 13px;
  }
  .search-btn:hover { opacity: 0.85; }

  /* Phase badge */
  .phase-badge {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    font-size: 12px;
    font-weight: 700;
    padding: 4px 12px;
    border-radius: 20px;
    background: rgba(255,122,24,0.12);
    color: var(--ember);
    border: 1px solid rgba(255,122,24,0.25);
  }

  /* Control panel */
  .ctrl-panel {
    display: flex;
    gap: 12px;
    flex-wrap: wrap;
    align-items: flex-end;
  }
  .ctrl-group {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .ctrl-label {
    font-size: 10px;
    text-transform: uppercase;
    letter-spacing: 0.09em;
    color: var(--faint);
  }
  .ctrl-row { display: flex; gap: 8px; align-items: center; }
  .ctrl-btn {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 7px 16px;
    border-radius: 8px;
    font-size: 13px;
    font-weight: 600;
    cursor: pointer;
    border: none;
    transition: opacity 0.12s, transform 0.08s;
  }
  .ctrl-btn:active { transform: scale(0.96); }
  .ctrl-btn:hover  { opacity: 0.85; }
  .ctrl-btn--pause  { background: rgba(251,191,36,0.15); color: var(--amber); border: 1px solid rgba(251,191,36,0.3); }
  .ctrl-btn--resume { background: rgba(52,211,153,0.15); color: var(--green); border: 1px solid rgba(52,211,153,0.3); }
  .ctrl-btn--primary { background: var(--ember); color: #000; }
  .ctrl-btn--ice    { background: rgba(134,231,255,0.12); color: var(--ice); border: 1px solid rgba(134,231,255,0.25); }
  .ctrl-btn--danger { background: rgba(248,113,113,0.12); color: var(--red); border: 1px solid rgba(248,113,113,0.25); }
  .ctrl-input {
    background: var(--surface2);
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 7px 12px;
    color: var(--text);
    font-size: 13px;
    outline: none;
    width: 110px;
  }
  .ctrl-input:focus { border-color: var(--ember); }
  .ctrl-feedback {
    font-size: 11px;
    color: var(--green);
    min-height: 16px;
    transition: opacity 0.3s;
  }
  .ctrl-feedback.fade { opacity: 0; }

  /* Log stream */
  .log-stream {
    font-family: monospace;
    font-size: 11px;
    color: var(--muted);
    max-height: 200px;
    overflow-y: auto;
    padding: 10px;
    background: rgba(0,0,0,0.20);
    border-radius: 8px;
    display: flex;
    flex-direction: column-reverse;
    gap: 2px;
  }
  .log-entry { padding: 1px 0; }
  .log-entry--found { color: var(--green); }
  .log-entry--stat  { color: var(--muted); }

  /* Tabs */
  .tabs { display: flex; gap: 4px; margin-bottom: 16px; flex-wrap: wrap; }
  .tab {
    padding: 6px 16px;
    border-radius: 8px;
    font-size: 12px;
    font-weight: 600;
    cursor: pointer;
    border: 1px solid var(--border);
    background: none;
    color: var(--muted);
    transition: all 0.12s;
  }
  .tab--active { background: var(--ember); color: #000; border-color: var(--ember); }
  .tab:hover:not(.tab--active) { background: var(--surface2); color: var(--text); }
  .tab-panel { display: none; }
  .tab-panel--active { display: block; }

  /* Servers */
  .server-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
    gap: 10px;
    margin-bottom: 20px;
  }
  .server-card {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 12px;
    padding: 14px 16px;
    cursor: pointer;
    transition: border-color 0.15s, background 0.15s;
  }
  .server-card:hover { border-color: var(--ember); background: var(--surface2); }
  .server-card--active { border-color: var(--ember); background: rgba(255,122,24,0.08); }
  .server-card__name { font-size: 18px; font-weight: 800; color: var(--ember); }
  .server-card__count { font-size: 12px; color: var(--muted); margin-top: 4px; }
  .server-card__bar { height: 3px; border-radius: 2px; background: var(--ember); margin-top: 10px; opacity: 0.5; }

  .srv-toolbar {
    display: flex;
    gap: 10px;
    align-items: center;
    flex-wrap: wrap;
    margin-bottom: 14px;
  }
  .srv-toolbar__title {
    font-size: 16px;
    font-weight: 700;
    color: var(--ice);
  }
  .sort-btn {
    padding: 4px 12px;
    border-radius: 6px;
    font-size: 11px;
    font-weight: 600;
    cursor: pointer;
    border: 1px solid var(--border);
    background: none;
    color: var(--muted);
    transition: all 0.12s;
  }
  .sort-btn--active { border-color: var(--ice); color: var(--ice); background: rgba(134,231,255,0.08); }
  .sort-btn:hover:not(.sort-btn--active) { background: var(--surface2); color: var(--text); }
  .srv-search {
    background: var(--surface2);
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 5px 12px;
    color: var(--text);
    font-size: 13px;
    outline: none;
    width: 180px;
    margin-left: auto;
  }
  .srv-search:focus { border-color: var(--ember); }
  .pagination { display: flex; gap: 8px; align-items: center; margin-top: 14px; justify-content: center; }
  .page-btn {
    padding: 5px 14px;
    border-radius: 7px;
    font-size: 12px;
    font-weight: 600;
    cursor: pointer;
    border: 1px solid var(--border);
    background: var(--surface);
    color: var(--muted);
  }
  .page-btn:hover:not(:disabled) { border-color: var(--ember); color: var(--ember); }
  .page-btn:disabled { opacity: 0.3; cursor: default; }
  .page-info { font-size: 12px; color: var(--muted); }
  th.sortable { cursor: pointer; user-select: none; }
  th.sortable:hover { color: var(--text); }
  th.sortable .sort-arrow { margin-left: 4px; opacity: 0.4; }
  th.sortable.asc .sort-arrow::after  { content: '↑'; opacity: 1; }
  th.sortable.desc .sort-arrow::after { content: '↓'; opacity: 1; }
  th.sortable:not(.asc):not(.desc) .sort-arrow::after { content: '↕'; }
</style>
</head>
<body>

<div class="header">
  <div>
    <div class="header__title">🔥 WPDS</div>
    <div class="header__sub">WOS Player Data Scraper</div>
  </div>
  <div style="margin-left:auto;display:flex;align-items:center;gap:12px">
    <span id="ws-status" style="font-size:12px;color:var(--muted)">Connecting…</span>
    <div id="status-dot" class="status-dot offline"></div>
  </div>
</div>

<div class="container">

  <!-- Control Panel -->
  <div class="card" style="margin-bottom:16px">
    <div class="card__title">Scraper Controls</div>
    <div class="ctrl-panel">

      <!-- Pause / Resume -->
      <div class="ctrl-group">
        <div class="ctrl-label">Run</div>
        <div class="ctrl-row">
          <button class="ctrl-btn ctrl-btn--pause" id="btn-pause" onclick="ctrlPause()">⏸ Pause</button>
          <button class="ctrl-btn ctrl-btn--resume" id="btn-resume" onclick="ctrlResume()" style="display:none">▶ Resume</button>
        </div>
      </div>

      <!-- Phase reset -->
      <div class="ctrl-group">
        <div class="ctrl-label">Phase</div>
        <div class="ctrl-row">
          <button class="ctrl-btn ctrl-btn--ice" onclick="ctrlResetPhase(1)">↩ Phase 1</button>
          <button class="ctrl-btn ctrl-btn--ice" onclick="ctrlResetPhase(2)">↩ Phase 2</button>
        </div>
      </div>

      <!-- Jump to ID -->
      <div class="ctrl-group">
        <div class="ctrl-label">Jump to ID</div>
        <div class="ctrl-row">
          <input type="number" class="ctrl-input" id="ctrl-jump-id" placeholder="Player ID" min="1" />
          <button class="ctrl-btn ctrl-btn--primary" onclick="ctrlJumpTo()">Jump</button>
        </div>
      </div>

      <!-- Probe ID -->
      <div class="ctrl-group">
        <div class="ctrl-label">Probe now</div>
        <div class="ctrl-row">
          <input type="number" class="ctrl-input" id="ctrl-probe-id" placeholder="Player ID" min="1" />
          <button class="ctrl-btn ctrl-btn--primary" onclick="ctrlProbeNow()">Probe</button>
        </div>
      </div>

    </div>
    <div class="ctrl-feedback" id="ctrl-feedback"></div>
  </div>

  <!-- KPIs -->
  <div class="grid grid--4" style="margin-bottom:16px">
    <div class="card kpi">
      <div class="kpi__val kpi__val--ember" id="kpi-total">—</div>
      <div class="kpi__label">Total Players</div>
    </div>
    <div class="card kpi">
      <div class="kpi__val kpi__val--green" id="kpi-found-session">—</div>
      <div class="kpi__label">Found (session)</div>
    </div>
    <div class="card kpi">
      <div class="kpi__val kpi__val--ice" id="kpi-rate">—</div>
      <div class="kpi__label">Calls/sec</div>
    </div>
    <div class="card kpi">
      <div class="kpi__val kpi__val--amber" id="kpi-changes">—</div>
      <div class="kpi__label">Nickname Changes</div>
    </div>
  </div>

  <!-- Scraper status -->
  <div class="card" style="margin-bottom:16px">
    <div class="card__title">Scraper Live Status</div>
    <div class="scraper-bar">
      <div class="scraper-stat">
        <div class="scraper-stat__val" id="s-scanned" style="color:var(--text)">—</div>
        <div class="scraper-stat__label">Scanned</div>
      </div>
      <div class="scraper-stat">
        <div class="scraper-stat__val" id="s-dead" style="color:var(--red)">—</div>
        <div class="scraper-stat__label">Dead IDs</div>
      </div>
      <div class="scraper-stat">
        <div class="scraper-stat__val" id="s-errors" style="color:var(--amber)">—</div>
        <div class="scraper-stat__label">Errors</div>
      </div>
      <div class="scraper-stat">
        <div class="scraper-stat__val" id="s-delay" style="color:var(--ice)">—</div>
        <div class="scraper-stat__label">Delay (ms)</div>
      </div>
      <div style="margin-left:auto">
        <span class="phase-badge" id="s-phase">Phase 1</span>
      </div>
    </div>

    <!-- Log stream -->
    <div style="margin-top:14px">
      <div style="font-size:11px;color:var(--faint);margin-bottom:6px">Live events</div>
      <div class="log-stream" id="log-stream"></div>
    </div>
  </div>

  <!-- Tabs -->
  <div class="tabs">
    <button class="tab tab--active" data-tab="recent">Recent Players</button>
    <button class="tab" data-tab="servers">Servers</button>
    <button class="tab" data-tab="changes">Nickname Changes</button>
    <button class="tab" data-tab="search">Search</button>
  </div>

  <div id="tab-recent" class="tab-panel tab-panel--active">
    <div class="card">
      <div class="card__title">Recently Discovered Players</div>
      <div class="table-wrap">
        <table>
          <thead><tr>
            <th>ID</th><th>Nickname</th><th>Kingdom</th><th>Furnace</th><th>First Seen</th>
          </tr></thead>
          <tbody id="table-recent"></tbody>
        </table>
      </div>
    </div>
  </div>

  <div id="tab-servers" class="tab-panel">
    <div class="card" style="margin-bottom:16px">
      <div class="card__title">Stats par Royaume</div>
      <div id="server-summary-grid" class="server-grid"></div>
    </div>

    <div class="card" id="server-detail-card" style="display:none">
      <div class="srv-toolbar">
        <div class="srv-toolbar__title" id="srv-detail-title">Kingdom —</div>
        <div style="display:flex;gap:6px;flex-wrap:wrap">
          <span style="font-size:11px;color:var(--faint);align-self:center">Trier :</span>
          <button class="sort-btn sort-btn--active" data-sort="id">ID</button>
          <button class="sort-btn" data-sort="nickname">A–Z</button>
          <button class="sort-btn" data-sort="state_level">Furnace</button>
          <button class="sort-btn" data-sort="first_seen">Premier vu</button>
          <button class="sort-btn" data-sort="last_seen">Dernier vu</button>
        </div>
        <input class="srv-search" id="srv-search" placeholder="Filtrer par pseudo…" />
      </div>

      <div class="table-wrap">
        <table>
          <thead><tr>
            <th class="sortable asc" data-col="id">ID<span class="sort-arrow"></span></th>
            <th class="sortable" data-col="nickname">Pseudo<span class="sort-arrow"></span></th>
            <th>Alliance</th>
            <th class="sortable" data-col="state_level">Furnace<span class="sort-arrow"></span></th>
            <th class="sortable" data-col="first_seen">Premier vu<span class="sort-arrow"></span></th>
            <th class="sortable" data-col="last_seen">Dernier vu<span class="sort-arrow"></span></th>
          </tr></thead>
          <tbody id="srv-player-tbody"></tbody>
        </table>
      </div>

      <div class="pagination">
        <button class="page-btn" id="srv-prev" onclick="srvChangePage(-1)">← Préc.</button>
        <span class="page-info" id="srv-page-info"></span>
        <button class="page-btn" id="srv-next" onclick="srvChangePage(1)">Suiv. →</button>
      </div>
    </div>
  </div>

  <div id="tab-changes" class="tab-panel">
    <div class="card">
      <div class="card__title">Nickname History</div>
      <div class="table-wrap">
        <table>
          <thead><tr>
            <th>ID</th><th>Current</th><th>Field</th><th>Old</th><th>New</th><th>When</th>
          </tr></thead>
          <tbody id="table-changes"></tbody>
        </table>
      </div>
    </div>
  </div>

  <div id="tab-search" class="tab-panel">
    <div class="card">
      <div class="card__title">Search Player</div>
      <div class="search-row">
        <input id="search-input" class="search-input" placeholder="Nickname or Player ID…" />
        <button class="search-btn" onclick="doSearch()">Search</button>
      </div>
      <div id="search-results"></div>
    </div>
  </div>

</div>

<script>
// ── Servers — déclarations anticipées (utilisées dans le gestionnaire de tabs) ──
let srvState = {
  kid: null, sort: 'id', dir: 'asc', page: 0, total: 0, filter: '', allPlayers: [],
};
let serversData = [];

// ── Tabs ──────────────────────────────────────────────────────────────────────
document.querySelectorAll('.tab').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach(b => b.classList.remove('tab--active'));
    document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('tab-panel--active'));
    btn.classList.add('tab--active');
    document.getElementById('tab-' + btn.dataset.tab).classList.add('tab-panel--active');
    // Charger les données au premier clic sur Servers
    if (btn.dataset.tab === 'servers' && !serversData.length) loadServers();
  });
});

// ── Base path (support reverse-proxy sous /WPDS/) ─────────────────────────────
// location.pathname vaut "/WPDS/" quand servi derrière nginx, "/" en direct
const BASE = (() => {
  const p = location.pathname; // ex: "/WPDS/" ou "/"
  // Garder tout jusqu'au dernier "/" inclus
  return p.endsWith('/') ? p : p.slice(0, p.lastIndexOf('/') + 1);
})();

function apiUrl(path) {
  // path commence par "/api/..." → on le rend relatif à BASE
  return BASE + path.replace(/^\\//, '');
}

// ── WebSocket ─────────────────────────────────────────────────────────────────
let ws;
const MAX_LOG = 50;
const logEntries = [];

function connectWS() {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  // Connexion WS sur le même chemin que la page (BASE)
  ws = new WebSocket(proto + '//' + location.host + BASE);

  ws.onopen = () => {
    document.getElementById('ws-status').textContent = 'Connected';
    document.getElementById('status-dot').classList.remove('offline');
  };

  ws.onclose = () => {
    document.getElementById('ws-status').textContent = 'Reconnecting…';
    document.getElementById('status-dot').classList.add('offline');
    setTimeout(connectWS, 3000);
  };

  ws.onmessage = (e) => {
    const msg = JSON.parse(e.data);
    handleMessage(msg);
  };
}

function handleMessage(msg) {
  if (msg.type === 'init') {
    fetchAndRender();
  } else if (msg.type === 'stats') {
    updateKPIs(msg);
    updateScraperBar(msg);
  } else if (msg.type === 'found') {
    addLogEntry({ type: 'found', text: '#' + msg.id + ' → ' + msg.nickname + ' (k' + msg.kid + ')' });
    prependRecentPlayer({ id: msg.id, nickname: msg.nickname, kid: msg.kid, state_level: msg.stateLevel, first_seen: Date.now() });
  }
}

// Buffer des joueurs récents (max 50) alimenté en temps réel
const recentPlayers = [];
const MAX_RECENT = 50;

function prependRecentPlayer(p) {
  // Éviter les doublons (rescan)
  if (recentPlayers.some(r => r.id === p.id)) return;
  recentPlayers.unshift(p);
  if (recentPlayers.length > MAX_RECENT) recentPlayers.pop();
  renderRecentTable();
}

function renderRecentTable() {
  const tbody = document.getElementById('table-recent');
  if (!tbody) return;
  tbody.innerHTML = recentPlayers.map(p => \`
    <tr>
      <td><a class="id-link" href="\${apiUrl('/api/player/'+p.id)}" target="_blank">\${p.id}</a></td>
      <td>\${escHtml(p.nickname)}</td>
      <td><span class="kid-badge">K\${p.kid}</span></td>
      <td>\${p.state_level ? '<span style="color:var(--amber);font-size:12px">🔥'+p.state_level+'</span>' : '<span style="color:var(--faint)">—</span>'}</td>
      <td style="color:var(--faint);font-size:12px">\${timeAgo(p.first_seen)}</td>
    </tr>
  \`).join('');
}

function addLogEntry(entry) {
  logEntries.unshift(entry);
  if (logEntries.length > MAX_LOG) logEntries.pop();
  renderLog();
}

function renderLog() {
  const container = document.getElementById('log-stream');
  container.innerHTML = logEntries.map(e =>
    '<div class="log-entry log-entry--' + e.type + '">' + escHtml(e.text) + '</div>'
  ).join('');
}

// ── REST polling ──────────────────────────────────────────────────────────────
async function fetchAndRender() {
  const data = await fetch(apiUrl('/api/stats')).then(r => r.json()).catch(() => null);
  if (!data) return;

  // KPIs
  setEl('kpi-total', fmt(data.stats.total_players));
  setEl('kpi-changes', fmt(data.stats.nickname_changes));
  setEl('s-delay', data.delay + 'ms');
  setEl('s-phase', 'Phase ' + data.phase);

  // Recent players — charger dans le buffer (garde les nouveaux WS en tête)
  for (const p of [...(data.recentPlayers || [])].reverse()) {
    if (!recentPlayers.some(r => r.id === p.id)) {
      recentPlayers.push(p);
    }
  }
  // Trier par first_seen DESC et limiter
  recentPlayers.sort((a, b) => b.first_seen - a.first_seen);
  if (recentPlayers.length > MAX_RECENT) recentPlayers.length = MAX_RECENT;
  renderRecentTable();

  // Changes
  const tbody2 = document.getElementById('table-changes');
  tbody2.innerHTML = (data.recentChanges || []).map(c => \`
    <tr>
      <td><a class="id-link" href="\${apiUrl('/api/player/'+c.player_id)}" target="_blank">\${c.player_id}</a></td>
      <td>\${escHtml(c.nickname)}</td>
      <td><span class="change-field">\${c.field}</span></td>
      <td><span class="change-old">\${escHtml(c.old_value || '')}</span></td>
      <td><span class="change-new">\${escHtml(c.new_value || '')}</span></td>
      <td style="color:var(--faint);font-size:12px">\${timeAgo(c.changed_at)}</td>
    </tr>
  \`).join('');
}

function updateKPIs(msg) {
  if (msg.global) {
    setEl('kpi-total', fmt(msg.global.total_players));
    setEl('kpi-changes', fmt(msg.global.nickname_changes));
  }
  if (msg.session) {
    setEl('kpi-found-session', fmt(msg.session.found));
  }
  if (msg.rate) {
    setEl('kpi-rate', msg.rate.callsPerSec);
  }
}

function updateScraperBar(msg) {
  if (msg.session) {
    setEl('s-scanned', fmt(msg.session.scanned));
    setEl('s-dead', fmt(msg.session.dead));
    setEl('s-errors', fmt(msg.session.errors));
  }
  if (msg.rate) {
    setEl('s-delay', msg.rate.delayMs + 'ms');
  }
  syncControlsFromStats(msg);
}

// ── Search ────────────────────────────────────────────────────────────────────
document.getElementById('search-input').addEventListener('keydown', e => {
  if (e.key === 'Enter') doSearch();
});

async function doSearch() {
  const q = document.getElementById('search-input').value.trim();
  if (!q) return;

  // Numeric → player lookup
  if (/^\\d+$/.test(q)) {
    const data = await fetch(apiUrl('/api/player/' + q)).then(r => r.json()).catch(() => null);
    if (!data || data.error) {
      document.getElementById('search-results').innerHTML = '<p style="color:var(--red);padding:12px">Player not found.</p>';
      return;
    }
    renderPlayerDetail(data);
    return;
  }

  const data = await fetch(apiUrl('/api/search?q=' + encodeURIComponent(q))).then(r => r.json()).catch(() => null);
  if (!data) return;

  const container = document.getElementById('search-results');
  if (!data.results.length) {
    container.innerHTML = '<p style="color:var(--muted);padding:12px">No results.</p>';
    return;
  }

  container.innerHTML = \`<div class="table-wrap"><table>
    <thead><tr><th>ID</th><th>Nickname</th><th>Kingdom</th><th>Alliance</th><th>Last Seen</th></tr></thead>
    <tbody>\${data.results.map(p => \`
      <tr style="cursor:pointer" onclick="loadPlayer(\${p.id})">
        <td><span class="id-link">\${p.id}</span></td>
        <td>\${escHtml(p.nickname)}</td>
        <td><span class="kid-badge">K\${p.kid}</span></td>
        <td>\${p.state_level ? '<span style="color:var(--amber);font-size:12px">🔥'+p.state_level+'</span>' : '<span style="color:var(--faint)">—</span>'}</td>
        <td style="color:var(--faint);font-size:12px">\${timeAgo(p.last_seen)}</td>
      </tr>
    \`).join('')}</tbody>
  </table></div>\`;
}

async function loadPlayer(id) {
  const data = await fetch(apiUrl('/api/player/' + id)).then(r => r.json()).catch(() => null);
  if (!data || data.error) return;
  renderPlayerDetail(data);
}

function renderPlayerDetail({ player, history }) {
  const historyHtml = history.length ? \`
    <div style="margin-top:16px">
      <div style="font-size:11px;color:var(--faint);margin-bottom:8px;text-transform:uppercase;letter-spacing:0.08em">History</div>
      <div class="table-wrap"><table>
        <thead><tr><th>Field</th><th>Old</th><th>New</th><th>When</th></tr></thead>
        <tbody>\${history.map(h => \`
          <tr>
            <td><span class="change-field">\${h.field}</span></td>
            <td><span class="change-old">\${escHtml(h.old_value || '')}</span></td>
            <td><span class="change-new">\${escHtml(h.new_value || '')}</span></td>
            <td style="color:var(--faint);font-size:12px">\${timeAgo(h.changed_at)}</td>
          </tr>
        \`).join('')}</tbody>
      </table></div>
    </div>
  \` : '<p style="color:var(--faint);font-size:12px;margin-top:8px">No history recorded yet.</p>';

  document.getElementById('search-results').innerHTML = \`
    <div class="card" style="margin-top:12px">
      <div style="display:flex;align-items:center;gap:16px;margin-bottom:12px">
        <div>
          <div style="font-size:20px;font-weight:700">\${escHtml(player.nickname)}</div>
          <div style="font-size:12px;color:var(--muted)">ID: \${player.id} · <span class="kid-badge">Kingdom \${player.kid}</span></div>
        </div>
        \${player.state_level ? \`<div style="font-size:14px;color:var(--amber)">🔥 Furnace \${player.state_level}</div>\` : ''}
      </div>
      <div style="display:grid;grid-template-columns:repeat(2,1fr);gap:8px;font-size:12px">
        <div><span style="color:var(--faint)">First seen:</span> \${timeAgo(player.first_seen)}</div>
        <div><span style="color:var(--faint)">Last seen:</span> \${timeAgo(player.last_seen)}</div>
      </div>
      \${historyHtml}
    </div>
  \`;
}

// ── Utils ─────────────────────────────────────────────────────────────────────
function setEl(id, val) {
  const el = document.getElementById(id);
  if (el) el.textContent = val;
}

function escHtml(str) {
  return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function fmt(n) {
  if (n == null) return '—';
  return Number(n).toLocaleString();
}

function timeAgo(ts) {
  if (!ts) return '—';
  const diff = Date.now() - ts;
  const s = Math.floor(diff / 1000);
  if (s < 60) return s + 's ago';
  const m = Math.floor(s / 60);
  if (m < 60) return m + 'm ago';
  const h = Math.floor(m / 60);
  if (h < 24) return h + 'h ago';
  return Math.floor(h / 24) + 'd ago';
}

// ── Controls ──────────────────────────────────────────────────────────────────
let isPaused = false;

function showFeedback(msg, isError = false) {
  const el = document.getElementById('ctrl-feedback');
  el.textContent = msg;
  el.style.color = isError ? 'var(--red)' : 'var(--green)';
  el.classList.remove('fade');
  clearTimeout(el._t);
  el._t = setTimeout(() => el.classList.add('fade'), 2500);
}

async function ctrlPost(action, value) {
  try {
    const res = await fetch(apiUrl('/api/control'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action, value }),
    });
    const data = await res.json();
    return data;
  } catch (e) {
    showFeedback('Error: ' + e.message, true);
    return null;
  }
}

async function ctrlPause() {
  const r = await ctrlPost('pause');
  if (r?.ok) {
    isPaused = true;
    document.getElementById('btn-pause').style.display = 'none';
    document.getElementById('btn-resume').style.display = '';
    showFeedback('⏸ Scraper mis en pause');
  }
}

async function ctrlResume() {
  const r = await ctrlPost('resume');
  if (r?.ok) {
    isPaused = false;
    document.getElementById('btn-pause').style.display = '';
    document.getElementById('btn-resume').style.display = 'none';
    showFeedback('▶ Scraper repris');
  }
}

async function ctrlJumpTo() {
  const id = document.getElementById('ctrl-jump-id').value.trim();
  if (!id) return;
  const r = await ctrlPost('jumpTo', Number(id));
  if (r?.ok) {
    showFeedback('⏭ Jump vers #' + id);
    document.getElementById('ctrl-jump-id').value = '';
  } else {
    showFeedback('ID invalide', true);
  }
}

async function ctrlResetPhase(p) {
  const r = await ctrlPost('resetPhase', p);
  if (r?.ok) showFeedback('🔄 Phase réinitialisée → ' + r.phase);
}

async function ctrlProbeNow() {
  const id = document.getElementById('ctrl-probe-id').value.trim();
  if (!id) return;
  showFeedback('🔍 Probe #' + id + ' en cours…');
  const r = await ctrlPost('probeNow', Number(id));
  if (!r) return;
  if (r.result?.found) {
    showFeedback('✅ #' + id + ' → ' + r.result.nickname + ' (K' + r.result.kid + ')');
  } else if (r.result?.error === 'invalid_id') {
    showFeedback('ID invalide', true);
  } else {
    showFeedback('❌ #' + id + ' — joueur introuvable');
  }
  document.getElementById('ctrl-probe-id').value = '';
}

// Sync état boutons pause/resume avec les stats WebSocket
function syncControlsFromStats(msg) {
  if (msg.paused !== undefined) {
    isPaused = msg.paused;
    document.getElementById('btn-pause').style.display  = isPaused ? 'none' : '';
    document.getElementById('btn-resume').style.display = isPaused ? '' : 'none';
  }
  if (msg.phase !== undefined) {
    document.getElementById('s-phase').textContent = 'Phase ' + msg.phase;
  }
  if (msg.currentId !== undefined && msg.currentId !== null) {
    document.getElementById('s-scanned').title = 'Current: #' + msg.currentId;
  }
}

// ── Servers ───────────────────────────────────────────────────────────────────

async function loadServers() {
  const data = await fetch(apiUrl('/api/servers')).then(r => r.json()).catch(() => null);
  if (!data) return;
  serversData = data.servers;
  renderServerGrid();
}

function renderServerGrid() {
  const grid = document.getElementById('server-summary-grid');
  if (!grid) return;
  const max = Math.max(...serversData.map(s => s.player_count), 1);
  grid.innerHTML = serversData.map(s => \`
    <div class="server-card\${srvState.kid === s.kingdom ? ' server-card--active' : ''}"
         onclick="selectServer(\${s.kingdom})">
      <div class="server-card__name">K\${s.kingdom}</div>
      <div class="server-card__count">
        <span style="color:var(--text);font-weight:700">\${fmt(s.player_count)}</span>
        <span style="color:var(--faint)"> joueurs</span>
      </div>
      <div class="server-card__count" style="margin-top:2px">
        🔥 Max \${s.max_furnace ?? '—'} · Moy \${s.avg_furnace != null ? Number(s.avg_furnace).toFixed(1) : '—'}
      </div>
      \${s.with_alliance ? \`<div class="server-card__count" style="margin-top:2px">🏰 \${fmt(s.with_alliance)} en alliance</div>\` : ''}
      <div class="server-card__bar" style="width:\${Math.round(s.player_count / max * 100)}%"></div>
    </div>
  \`).join('');
}

async function selectServer(kid) {
  srvState.kid    = kid;
  srvState.page   = 0;
  srvState.filter = '';
  document.getElementById('srv-search').value = '';
  renderServerGrid(); // met à jour la card active
  document.getElementById('server-detail-card').style.display = '';
  document.getElementById('srv-detail-title').textContent = 'Kingdom ' + kid;
  await loadServerPlayers();
}

async function loadServerPlayers() {
  if (srvState.kid == null) return;
  const params = new URLSearchParams({
    sort: srvState.sort,
    dir:  srvState.dir,
    page: srvState.page,
  });
  const data = await fetch(apiUrl('/api/servers/' + srvState.kid + '/players?' + params))
    .then(r => r.json()).catch(() => null);
  if (!data) return;

  srvState.total      = data.total;
  srvState.allPlayers = data.players;
  renderServerPlayers();
  renderPagination();
}

function renderServerPlayers() {
  const tbody  = document.getElementById('srv-player-tbody');
  const filter = srvState.filter.toLowerCase();
  const rows   = filter
    ? srvState.allPlayers.filter(p => p.nickname.toLowerCase().includes(filter))
    : srvState.allPlayers;

  tbody.innerHTML = rows.length ? rows.map(p => \`
    <tr style="cursor:pointer" onclick="loadPlayer(\${p.id})">
      <td><span class="id-link">\${p.id}</span></td>
      <td style="font-weight:600">\${escHtml(p.nickname)}</td>
      <td>\${p.alliance_tag ? \`<span style="font-size:11px;color:var(--amber);background:rgba(251,191,36,0.10);padding:2px 8px;border-radius:10px">\${escHtml(p.alliance_tag)}</span>\` : '<span style="color:var(--faint)">—</span>'}</td>
      <td>\${p.state_level ? \`<span style="color:var(--amber);font-size:12px">🔥 \${p.state_level}</span>\` : '<span style="color:var(--faint)">—</span>'}</td>
      <td style="color:var(--faint);font-size:12px">\${timeAgo(p.first_seen)}</td>
      <td style="color:var(--faint);font-size:12px">\${timeAgo(p.last_seen)}</td>
    </tr>
  \`).join('')
  : '<tr><td colspan="6" style="color:var(--faint);text-align:center;padding:20px">Aucun joueur</td></tr>';
}

function renderPagination() {
  const totalPages = Math.ceil(srvState.total / 100);
  const cur        = srvState.page + 1;
  document.getElementById('srv-page-info').textContent =
    'Page ' + cur + ' / ' + (totalPages || 1) + '  (' + fmt(srvState.total) + ' joueurs)';
  document.getElementById('srv-prev').disabled = srvState.page === 0;
  document.getElementById('srv-next').disabled = cur >= totalPages;
}

async function srvChangePage(delta) {
  srvState.page = Math.max(0, srvState.page + delta);
  await loadServerPlayers();
}

// Tri via boutons
document.querySelectorAll('.sort-btn').forEach(btn => {
  btn.addEventListener('click', async () => {
    const col = btn.dataset.sort;
    if (srvState.sort === col) {
      srvState.dir = srvState.dir === 'asc' ? 'desc' : 'asc';
    } else {
      srvState.sort = col;
      srvState.dir  = col === 'nickname' ? 'asc' : (col === 'id' ? 'asc' : 'desc');
    }
    srvState.page = 0;
    // Mettre à jour les boutons actifs
    document.querySelectorAll('.sort-btn').forEach(b => b.classList.remove('sort-btn--active'));
    btn.classList.add('sort-btn--active');
    // Mettre à jour les flèches dans les th
    document.querySelectorAll('th.sortable').forEach(th => {
      th.classList.remove('asc', 'desc');
      if (th.dataset.col === srvState.sort) th.classList.add(srvState.dir);
    });
    await loadServerPlayers();
  });
});

// Tri via en-têtes de colonne
document.querySelectorAll('th.sortable').forEach(th => {
  th.addEventListener('click', async () => {
    const col = th.dataset.col;
    if (srvState.sort === col) {
      srvState.dir = srvState.dir === 'asc' ? 'desc' : 'asc';
    } else {
      srvState.sort = col;
      srvState.dir  = col === 'nickname' ? 'asc' : (col === 'id' ? 'asc' : 'desc');
    }
    srvState.page = 0;
    document.querySelectorAll('th.sortable').forEach(t => t.classList.remove('asc', 'desc'));
    th.classList.add(srvState.dir);
    // Sync sort buttons
    document.querySelectorAll('.sort-btn').forEach(b => {
      b.classList.toggle('sort-btn--active', b.dataset.sort === srvState.sort);
    });
    await loadServerPlayers();
  });
});

// Filtre texte local (instantané, sans appel réseau)
document.getElementById('srv-search').addEventListener('input', e => {
  srvState.filter = e.target.value.trim();
  renderServerPlayers();
});

// ── Init ──────────────────────────────────────────────────────────────────────
connectWS();
fetchAndRender();
setInterval(fetchAndRender, 15_000);
</script>
</body>
</html>`;
