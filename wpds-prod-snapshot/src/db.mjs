/**
 * db.mjs — Couche SQLite pour le scraper WOS
 *
 * Tables :
 *   players        — données actuelles (une ligne par ID connu)
 *   player_history — historique de chaque changement (nickname, kid, etc.)
 *   scan_state     — position courante du scanner + stats
 *   dead_ids       — IDs confirmés "player_not_found" (éviter de re-scanner)
 */

import Database from "better-sqlite3";
import { existsSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dir = dirname(fileURLToPath(import.meta.url));
const DB_PATH = join(__dir, "..", "data", "players.db");

// Créer le répertoire data si besoin
if (!existsSync(join(__dir, "..", "data"))) {
  mkdirSync(join(__dir, "..", "data"), { recursive: true });
}

const db = new Database(DB_PATH);

// 🚀 OPTIMISATIONS SQLITE MAXIMALES pour 1000 req/s
db.pragma("journal_mode = WAL");
db.pragma("synchronous = OFF");         // ULTRA: désactiver fsync (risque minimal)
db.pragma("cache_size = -131072");      // ULTRA: 128 MB cache (×2)
db.pragma("mmap_size = 536870912");     // ULTRA: 512 MB memory-mapped I/O (×2)
db.pragma("temp_store = MEMORY");
// locking_mode = EXCLUSIVE retiré (bloquait le dashboard)

// ─── Création des tables ──────────────────────────────────────────────────────

db.exec(`
  CREATE TABLE IF NOT EXISTS players (
    id            INTEGER PRIMARY KEY,
    nickname      TEXT    NOT NULL,
    kid           INTEGER NOT NULL DEFAULT 0,
    avatar_frame  TEXT    NOT NULL DEFAULT '',
    state_level   INTEGER NOT NULL DEFAULT 0,
    alliance_tag  TEXT    NOT NULL DEFAULT '',
    inactive      INTEGER NOT NULL DEFAULT 0,  -- 1 = lord ou furnace <= 29
    first_seen    INTEGER NOT NULL,  -- Unix timestamp ms
    last_seen     INTEGER NOT NULL,  -- Unix timestamp ms
    last_updated  INTEGER NOT NULL   -- Unix timestamp ms (quand nickname/kid ont changé)
  );

  CREATE TABLE IF NOT EXISTS player_history (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    player_id     INTEGER NOT NULL REFERENCES players(id),
    field         TEXT    NOT NULL,   -- 'nickname' | 'kid' | 'alliance_tag' | ...
    old_value     TEXT,
    new_value     TEXT,
    changed_at    INTEGER NOT NULL    -- Unix timestamp ms
  );

  CREATE INDEX IF NOT EXISTS idx_history_player ON player_history(player_id);
  CREATE INDEX IF NOT EXISTS idx_history_field  ON player_history(field, changed_at DESC);

  CREATE TABLE IF NOT EXISTS dead_ids (
    id          INTEGER PRIMARY KEY,
    confirmed_at INTEGER NOT NULL,   -- première fois confirmé absent
    retry_after  INTEGER             -- timestamp ms à partir duquel re-tenter
  );

  CREATE TABLE IF NOT EXISTS scan_state (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS scan_log (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    ts         INTEGER NOT NULL,
    scanned    INTEGER NOT NULL DEFAULT 0,
    found      INTEGER NOT NULL DEFAULT 0,
    not_found  INTEGER NOT NULL DEFAULT 0,
    errors     INTEGER NOT NULL DEFAULT 0,
    rate_ms    REAL
  );

  CREATE TABLE IF NOT EXISTS live_events (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    ts         INTEGER NOT NULL,
    type       TEXT    NOT NULL,   -- 'found' | 'dead' | 'changed'
    player_id  INTEGER,
    payload    TEXT               -- JSON
  );
  CREATE INDEX IF NOT EXISTS idx_live_events_ts ON live_events(ts DESC);

  CREATE TABLE IF NOT EXISTS error_ids (
    id           INTEGER PRIMARY KEY,
    error_type   TEXT    NOT NULL,          -- 'timeout' | 'network_error' | 'http_NNN' | ...
    first_error  INTEGER NOT NULL,          -- timestamp ms première erreur
    last_error   INTEGER NOT NULL,          -- timestamp ms dernière erreur
    error_count  INTEGER NOT NULL DEFAULT 1,
    retry_after  INTEGER NOT NULL,          -- timestamp ms à partir duquel retenter
    resolved     INTEGER NOT NULL DEFAULT 0 -- 1 = résolu (trouvé ou confirmé dead)
  );
  CREATE INDEX IF NOT EXISTS idx_error_ids_retry  ON error_ids(retry_after) WHERE resolved = 0;
  CREATE INDEX IF NOT EXISTS idx_error_ids_resolved ON error_ids(resolved);
`);

// ─── Prepared statements ──────────────────────────────────────────────────────

const stmts = {
  upsertPlayer: db.prepare(`
    INSERT INTO players (id, nickname, kid, avatar_frame, state_level, alliance_tag, inactive, first_seen, last_seen, last_updated)
    VALUES (@id, @nickname, @kid, @avatarFrame, @stateLevel, @allianceTag, @inactive, @now, @now, @now)
    ON CONFLICT(id) DO UPDATE SET
      last_seen = @now,
      nickname      = CASE WHEN nickname      != @nickname     THEN @nickname     ELSE nickname      END,
      kid           = CASE WHEN kid           != @kid          THEN @kid          ELSE kid           END,
      avatar_frame  = CASE WHEN avatar_frame  != @avatarFrame  THEN @avatarFrame  ELSE avatar_frame  END,
      state_level   = CASE WHEN state_level   != @stateLevel   THEN @stateLevel   ELSE state_level   END,
      alliance_tag  = CASE WHEN alliance_tag  != @allianceTag  THEN @allianceTag  ELSE alliance_tag  END,
      inactive      = @inactive,
      last_updated  = CASE WHEN (nickname != @nickname OR kid != @kid OR alliance_tag != @allianceTag)
                           THEN @now ELSE last_updated END
  `),

  getPlayer: db.prepare(`SELECT * FROM players WHERE id = ?`),

  insertHistory: db.prepare(`
    INSERT INTO player_history (player_id, field, old_value, new_value, changed_at)
    VALUES (@playerId, @field, @oldValue, @newValue, @changedAt)
  `),

  markDead: db.prepare(`
    INSERT INTO dead_ids (id, confirmed_at, retry_after)
    VALUES (?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET confirmed_at = excluded.confirmed_at, retry_after = excluded.retry_after
  `),

  isDead: db.prepare(`SELECT id FROM dead_ids WHERE id = ? AND (retry_after IS NULL OR retry_after > ?)`),

  removeDead: db.prepare(`DELETE FROM dead_ids WHERE id = ?`),

  getState: db.prepare(`SELECT value FROM scan_state WHERE key = ?`),
  setState: db.prepare(`INSERT OR REPLACE INTO scan_state (key, value) VALUES (?, ?)`),

  insertLog: db.prepare(`
    INSERT INTO scan_log (ts, scanned, found, not_found, errors, rate_ms)
    VALUES (@ts, @scanned, @found, @notFound, @errors, @rateMs)
  `),

  getStats: db.prepare(`
    SELECT
      (SELECT COUNT(*) FROM players WHERE inactive = 0)             AS total_players,
      (SELECT COUNT(*) FROM players WHERE inactive = 1)             AS total_inactive,
      (SELECT COUNT(*) FROM players)                                AS total_all,
      (SELECT COUNT(*) FROM dead_ids)                               AS total_dead,
      (SELECT MIN(id) FROM players)                                 AS min_id,
      (SELECT MAX(id) FROM players)                                 AS max_id,
      (SELECT COUNT(*) FROM player_history WHERE field = 'nickname') AS nickname_changes
  `),

  getRecentChanges: db.prepare(`
    SELECT h.player_id, h.field, h.old_value, h.new_value, h.changed_at, p.nickname
    FROM player_history h
    JOIN players p ON p.id = h.player_id
    ORDER BY h.changed_at DESC
    LIMIT ?
  `),

  getRecentPlayers: db.prepare(`
    SELECT * FROM players
    WHERE LOWER(nickname) != 'lord' || CAST(id AS TEXT)
    ORDER BY first_seen DESC LIMIT ?
  `),

  getRecentLog: db.prepare(`
    SELECT * FROM scan_log ORDER BY ts DESC LIMIT ?
  `),

  // ── error_ids ──────────────────────────────────────────────────────────────
  logError: db.prepare(`
    INSERT INTO error_ids (id, error_type, first_error, last_error, error_count, retry_after, resolved)
    VALUES (@id, @errorType, @now, @now, 1, @retryAfter, 0)
    ON CONFLICT(id) DO UPDATE SET
      last_error  = @now,
      error_count = error_count + 1,
      error_type  = @errorType,
      retry_after = @retryAfter,
      resolved    = 0
  `),

  resolveError: db.prepare(`
    UPDATE error_ids SET resolved = 1, last_error = ? WHERE id = ?
  `),

  getErrorsToRetry: db.prepare(`
    SELECT id, error_type, error_count FROM error_ids
    WHERE resolved = 0 AND retry_after <= ? AND error_count < 100
    ORDER BY retry_after ASC
    LIMIT ?
  `),

  countPendingErrors: db.prepare(`
    SELECT COUNT(*) AS cnt FROM error_ids WHERE resolved = 0
  `),

  searchNickname: db.prepare(`
    SELECT * FROM players
    WHERE nickname LIKE ?
    LIMIT 50
  `),
};

// ─── API publique ─────────────────────────────────────────────────────────────

/**
 * Enregistre un joueur trouvé.
 * 🚀 OPTIMISATION : Skip change detection (getPlayer read) pour vitesse maximale
 * La détection de changements se fera via un job périodique séparé
 */
export function savePlayer({ id, nickname, kid, avatarFrame = "", stateLevel = 0, allianceTag = "" }) {
  const now = Date.now();

  // 🚀 SKIP change detection pour éviter le getPlayer() read coûteux
  // On fera un job batch séparé pour détecter les changements périodiquement

  const isLord     = nickname.toLowerCase() === `lord${id}`;
  const inactive   = (isLord || stateLevel <= 29) ? 1 : 0;
  stmts.upsertPlayer.run({ id, nickname, kid, avatarFrame, stateLevel, allianceTag, inactive, now });

  // Si l'ID était dans dead_ids (compte recréé), on le retire
  stmts.removeDead.run(id);
}

// ─── BATCH INSERTS : Buffers pour optimiser les writes ───────────────────────
const batchBuffers = {
  deadIds: [],
  maxSize: 5000,       // 🚀 ULTRA: ×5 batch size (5000 entrées)
  flushInterval: 100,  // 🚀 ULTRA: flush toutes les 100ms (équilibre)
};

function flushDeadIds() {
  if (batchBuffers.deadIds.length === 0) return;

  const batch = batchBuffers.deadIds.splice(0);
  db.prepare('BEGIN').run();
  try {
    for (const id of batch) {
      const now = Date.now();
      const retryAfter = now + 7 * 24 * 60 * 60 * 1000;
      stmts.markDead.run(id, now, retryAfter);
    }
    db.prepare('COMMIT').run();
  } catch (err) {
    db.prepare('ROLLBACK').run();
    throw err;
  }
}

// Auto-flush toutes les 100ms
setInterval(() => {
  flushDeadIds();
}, batchBuffers.flushInterval);

/**
 * Marque un ID comme "player not found" (bufferisé)
 * retry_after : dans 7 jours (comptes supprimés peuvent être recréés)
 */
export function markDead(id) {
  batchBuffers.deadIds.push(id);
  if (batchBuffers.deadIds.length >= batchBuffers.maxSize) {
    flushDeadIds();
  }
}

export function isDead(id) {
  return !!stmts.isDead.get(id, Date.now());
}

export function getState(key, defaultVal = null) {
  const row = stmts.getState.get(key);
  return row ? JSON.parse(row.value) : defaultVal;
}

export function setState(key, value) {
  stmts.setState.run(key, JSON.stringify(value));
}

export function logScan({ scanned, found, notFound, errors, rateMs }) {
  stmts.insertLog.run({ ts: Date.now(), scanned, found, notFound, errors, rateMs });
}

export function getStats() {
  return stmts.getStats.get();
}

export function getRecentChanges(limit = 20) {
  return stmts.getRecentChanges.all(limit);
}

export function getRecentPlayers(limit = 20) {
  return stmts.getRecentPlayers.all(limit);
}

export function getRecentLog(limit = 100) {
  return stmts.getRecentLog.all(limit);
}

export function searchNickname(q) {
  return stmts.searchNickname.all(`%${q}%`);
}

export function getPlayer(id) {
  return stmts.getPlayer.get(id);
}

/**
 * Enregistre un ID en erreur pour re-scan ultérieur.
 * Phase D: retry après 15min au lieu de 1h (erreurs réseau/timeout passagères)
 */
export function logError(id, errorType, retryDelayMs = 15 * 60 * 1000) {
  const now = Date.now();
  stmts.logError.run({ id, errorType, now, retryAfter: now + retryDelayMs });
}

/**
 * Marque une erreur comme résolue (ID trouvé ou confirmé dead lors du rescan).
 */
export function resolveError(id) {
  // last_error = now → la ligne resolved=1 survit la fenêtre de purge (30min) à partir de la
  // RÉSOLUTION → le dashboard peut marquer le joueur « retesté » (sinon purgé instantanément).
  stmts.resolveError.run(Date.now(), id);
}

/**
 * Retourne les IDs en erreur dont le retry_after est dépassé.
 * limit : max 500 IDs à la fois pour ne pas saturer la boucle principale
 */
export function getErrorsToRetry(limit = 500) {
  return stmts.getErrorsToRetry.all(Date.now(), limit);
}

export function countPendingErrors() {
  return stmts.countPendingErrors.get().cnt;
}

// ─── Live events (communication scraper → dashboard cross-process) ────────────

const stmtPushEvent  = db.prepare(`INSERT INTO live_events (ts, type, player_id, payload) VALUES (?, ?, ?, ?)`);
const stmtPopEvents  = db.prepare(`SELECT * FROM live_events WHERE id > ? ORDER BY id ASC LIMIT 100`);
const stmtPruneEvents = db.prepare(`DELETE FROM live_events WHERE ts < ?`);

export function pushEvent(type, playerId, payload) {
  stmtPushEvent.run(Date.now(), type, playerId ?? null, JSON.stringify(payload));
}

/**
 * Retourne les events après lastId, et purge ceux de plus de 5 minutes.
 */
export function popEvents(lastId = 0) {
  const rows = stmtPopEvents.all(lastId);
  stmtPruneEvents.run(Date.now() - 5 * 60 * 1000);
  return rows.map(r => ({ ...r, payload: JSON.parse(r.payload) }));
}

export function getPlayerHistory(id) {
  return db.prepare(`
    SELECT * FROM player_history WHERE player_id = ? ORDER BY changed_at DESC
  `).all(id);
}

export { db };
