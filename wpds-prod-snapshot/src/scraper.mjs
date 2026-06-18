/**
 * scraper.mjs — Moteur principal de scan des IDs joueurs WOS
 * Processus autonome — tourne en fond indépendamment du dashboard.
 *
 * Communication avec le dashboard : via la table scan_state (SQLite).
 *   Commandes lues à chaque itération : cmd_pause, cmd_delay, cmd_jump, cmd_reset_phase
 *
 * Phase 1 — Exploration bidirectionnelle depuis START_ID
 *            S'arrête après MAX_DEAD_STREAK IDs morts consécutifs dans une direction
 * Phase 2 — Rescan complet min_id → max_id en boucle
 *            Saute les IDs morts (retry_after pas atteint)
 *            Saute les joueurs déjà vus il y a moins de RESCAN_INTERVAL ms
 *
 * Concurrence : CONCURRENCY workers tournent en parallèle sur un pool d'IDs commun.
 * Rate limit  : adaptatif PAR WORKER — chaque worker gère son propre backoff.
 *               Un 429 sur un worker ne pénalise pas les autres.
 */

import pkg from "bloom-filters";
const { BloomFilter } = pkg;
import { fetchPlayer, fetchPlayerViaCF, fetchPlayerViaProxy, cfAvailable, poolStats } from "./api.mjs";
import { savePlayer, markDead, isDead, getState, setState, logScan, getStats, pushEvent, logError, resolveError, getErrorsToRetry, countPendingErrors, db } from "./db.mjs";

// ─── CircularQueue O(1) — Quick-Win #4 (+15-25% throughput) ──────────────────
class CircularQueue {
  constructor(capacity = 100000) {
    this.buffer = new Array(capacity);
    this.capacity = capacity;
    this.head = 0;
    this.tail = 0;
    this.count = 0;
  }
  enqueue(item) {
    if (this.count >= this.capacity) this._resize(this.capacity * 2);
    this.buffer[this.tail] = item;
    this.tail = (this.tail + 1) % this.capacity;
    this.count++;
  }
  enqueueFront(item) {
    if (this.count >= this.capacity) this._resize(this.capacity * 2);
    this.head = (this.head - 1 + this.capacity) % this.capacity;
    this.buffer[this.head] = item;
    this.count++;
  }
  dequeue() {
    if (this.count === 0) return null;
    const item = this.buffer[this.head];
    this.buffer[this.head] = undefined;
    this.head = (this.head + 1) % this.capacity;
    this.count--;
    return item;
  }
  size() { return this.count; }
  isEmpty() { return this.count === 0; }
  _resize(newCapacity) {
    const newBuffer = new Array(newCapacity);
    for (let i = 0; i < this.count; i++) {
      newBuffer[i] = this.buffer[(this.head + i) % this.capacity];
    }
    this.buffer = newBuffer;
    this.head = 0;
    this.tail = this.count;
    this.capacity = newCapacity;
  }
}

// ─── Async Logging — Quick-Win #7 (+5-10% throughput) ────────────────────────
// Buffer les logs et flush async toutes les 100ms pour éliminer blocage I/O
const logBuffer = [];
const LOGGER_FLUSH_INTERVAL = 100;

function asyncLog(...args) {
  logBuffer.push(args.map(a => typeof a === "object" ? JSON.stringify(a) : String(a)).join(" "));
  if (logBuffer.length > 1000) flushLogs(); // Flush immédiat si buffer plein
}

function flushLogs() {
  if (logBuffer.length === 0) return;
  const batch = logBuffer.splice(0);
  setImmediate(() => {
    for (const msg of batch) {
      process.stdout.write(msg + "\n");
    }
  });
}

setInterval(flushLogs, LOGGER_FLUSH_INTERVAL);
process.on("exit", flushLogs);

// Remplacer console.log par asyncLog pour les logs fréquents
const origConsoleLog = console.log;
console.log = asyncLog;
console.warn = asyncLog;  // Warnings aussi bufferisés
// console.error reste synchrone pour les erreurs critiques

import { watchdog } from "./watchdog.mjs";

// ─── Bloom Filter pour dead_ids & players (Quick-Win #2: +150-200% vitesse) ───
let deadIdsBloom = null;
let playersBloom = null;

function initBloomFilters() {
  console.log("🔄 Initialisation Bloom Filters...");
  const start = Date.now();

  // Charger tous les dead_ids
  const deadIds = db.prepare("SELECT id FROM dead_ids").pluck().all();
  // k = -ln(0.01) / ln(2) ≈ 7 hash functions pour 1% false positive
  deadIdsBloom = new BloomFilter(200_000_000, 7);
  deadIds.forEach(id => deadIdsBloom.add(id));

  // Charger tous les players
  const playerIds = db.prepare("SELECT id FROM players").pluck().all();
  playersBloom = new BloomFilter(200_000_000, 7);
  playerIds.forEach(id => playersBloom.add(id));

  console.log(`✅ Bloom Filters chargés en ${Date.now() - start}ms : ${deadIds.length} dead, ${playerIds.length} players`);
}

// ─── Memory monitoring (anti-OOM) ─────────────────────────────────────────────
setInterval(() => {
  const used = process.memoryUsage();
  const heapUsedMB = Math.round(used.heapUsed / 1024 / 1024);
  const heapTotalMB = Math.round(used.heapTotal / 1024 / 1024);
  const rss = Math.round(used.rss / 1024 / 1024);
  console.log(`💾 Memory: heap ${heapUsedMB}/${heapTotalMB} MB, RSS ${rss} MB`);

  // Alerte si proche de la limite
  if (heapUsedMB > 3500) {
    console.warn(`⚠️  Memory HIGH: ${heapUsedMB} MB / 4096 MB heap limit`);
  }
}, 60000);

// ─── Config ────────────────────────────────────────────────────────────────────

const START_ID        = parseInt(process.env.START_ID || '60000000');  // Config via env var pour multi-instances

// ─── Mode couverture exhaustive distribuée (4 instances, DB partagée) ──────────
// Chaque instance scanne SA plage [SCAN_START, SCAN_END] avec un curseur PROPRE
// (cursor_inst_<INSTANCE_ID>) pour éviter que les instances se marchent dessus.
// L'instance RETRY_ONLY=true ne scanne pas : elle retest les error_ids en boucle
// (fallback sur le scan de sa plage si la liste d'erreurs est vide).
const INSTANCE_ID     = process.env.INSTANCE_ID || '1';
const RETRY_ONLY      = process.env.RETRY_ONLY === 'true';
const SCAN_START      = parseInt(process.env.SCAN_START || process.env.START_ID || '1');
const SCAN_END        = parseInt(process.env.SCAN_END || '500000000');

const MIN_DELAY       = 0;       // AUCUN délai — saturation maximale
const MAX_DELAY       = 500;     // ✅ CONFIG OPTIMALE: 500ms pour backoff efficace
const DELAY_STEP      = 20;      // ✅ CONFIG OPTIMALE: 20ms récupération
const MAX_DEAD_STREAK = 10_000;  // arrêt exploration phase 1
const RESCAN_INTERVAL = 24 * 60 * 60 * 1000; // 24h
const CONCURRENCY_CF    = 0;  // CF quota épuisé (reset minuit UTC)

// TOR : 1 circuit par port (≈TOR_PORTS_COUNT circuits/instance). Il faut ALIGNER le
// nombre de workers sur le nombre de circuits, sinon TOR sature (timeouts en cascade).
// 2 workers/circuit = bon compromis (pipeline léger sans saturer).
const TOR_PORTS_COUNT = parseInt(process.env.TOR_PORTS_COUNT || '25');  // 25 ports par instance
const WORKERS_PER_PROXY = parseInt(process.env.WORKERS_PER_PROXY || '1');  // 1 worker par circuit TOR (test)
const MIN_PROXY_WORKERS = TOR_PORTS_COUNT * WORKERS_PER_PROXY;
const MAX_PROXY_WORKERS = TOR_PORTS_COUNT * WORKERS_PER_PROXY;

let CONCURRENCY_PROXY = MIN_PROXY_WORKERS;
let CONCURRENCY       = CONCURRENCY_CF + CONCURRENCY_PROXY;

// Ajuster dynamiquement le nombre de workers proxy
function updateProxyWorkers() {
  const stats = poolStats();
  const proxyCount = stats.alive || 0;  // FIX: stats.alive, pas stats.available
  const optimal = Math.max(MIN_PROXY_WORKERS, Math.min(MAX_PROXY_WORKERS, proxyCount * WORKERS_PER_PROXY));

  if (optimal !== CONCURRENCY_PROXY) {
    const old = CONCURRENCY_PROXY;
    CONCURRENCY_PROXY = optimal;
    CONCURRENCY = CONCURRENCY_CF + CONCURRENCY_PROXY;
    console.log(`⚙️  Workers proxy ajustés: ${old} → ${CONCURRENCY_PROXY} (${proxyCount} proxies × ${WORKERS_PER_PROXY} workers/proxy)`);
  }

  return CONCURRENCY_PROXY;
}

// ─── État partagé ──────────────────────────────────────────────────────────────

const state = {
  running:   true,
  paused:    getState("cmd_pause",  false),
  phase:     getState("phase",      1),
  scanned:   0,   // vraies requêtes API envoyées
  skipped:   0,   // IDs sautés sans appel (déjà connus)
  found:     0,
  dead:      0,
  errors:    0,
  // Option A: Observability - Error breakdown counters
  rateLimited:   0,   // 429 responses (true WOS rate-limit)
  errorTimeout:  0,   // timeout/network errors
  error5xx:      0,   // http_500..599 server errors
  errorProxy:    0,   // proxy_failed/no_proxy
  errorCfQuota:  0,   // cf_quota_exhausted
  startTs:   Date.now(),
  currentId: null,
  avgDelay:  MIN_DELAY,
};

// Délai par worker — chaque worker adapte son propre rythme
// IDs 0..CONCURRENCY_CF-1 = workers CF, CONCURRENCY_CF..CONCURRENCY-1 = workers proxy
const workerDelays = new Array(CONCURRENCY).fill(MIN_DELAY);

// Appelé par le watchdog quand le quota CF est resetté à minuit UTC
export function resetCfWorkerDelays() {
  for (let i = 0; i < CONCURRENCY_CF; i++) workerDelays[i] = MIN_DELAY;
  state.avgDelay = getAvgDelay();
  console.log(`✅ [scraper] CF worker delays reset to 0 — ${CONCURRENCY_CF} CF workers reactivated`);
}

function getAvgDelay() {
  return Math.round(workerDelays.reduce((a, b) => a + b, 0) / workerDelays.length);
}

// ✅ Mutex supprimé — Phase 2 utilise maintenant des queues distribuées sans lock

// Prepared statement pour savoir quand un joueur a été vu pour la dernière fois
const stmtLastSeen = db.prepare(`SELECT last_seen FROM players WHERE id = ?`);
// Prepared statement pour vérifier si un ID est dans dead_ids (peu importe retry_after)
const stmtIsDead = db.prepare(`SELECT id FROM dead_ids WHERE id = ?`);

// ─── Helpers ───────────────────────────────────────────────────────────────────

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitIfPaused() {
  while (state.paused) {
    await sleep(200);
    state.paused = getState("cmd_pause", false);
  }
}

function readCommands() {
  state.paused = getState("cmd_pause", false);

  const jumpId = getState("cmd_jump", null);
  if (jumpId !== null) {
    setState("explore_up",    jumpId);
    setState("explore_down",  jumpId - 1);
    setState("rescan_cursor", jumpId);
    setState("cmd_jump",      null);
    console.log(`⏭  Jump vers ID ${jumpId}`);
  }

  const resetPhase = getState("cmd_reset_phase", null);
  if (resetPhase !== null) {
    // 🔒 Mode unique : toujours phase 1 (scan complet). Phase 2 supprimée.
    state.phase = 1;
    setState("phase", 1);
    setState("cmd_reset_phase", null);
    console.log(`🔄 Phase réinitialisée → 1 (scan complet)`);
  }
}

// Rate limit adaptatif PAR WORKER
function adaptDelay(wid, result) {
  if (result.error === "rate_limited") {
    // ✅ Quick-Win #3 : Fix backoff (+50ms au lieu de +1000ms, récupération 20× plus rapide)
    // AVANT : +1000ms penalty, 50 iterations pour revenir (ratio 50:1)
    // APRÈS : +50ms penalty, récupération en 3 iterations (ratio 2.5:1)
    workerDelays[wid] = Math.min(workerDelays[wid] + 50, MAX_DELAY);
  } else {
    workerDelays[wid] = Math.max(workerDelays[wid] - DELAY_STEP, MIN_DELAY);
  }
  state.avgDelay = getAvgDelay();
  setState("last_delay", state.avgDelay);
}

// ─── Probe d'un ID (avec worker ID pour le délai) ──────────────────────────────
// transport : "cf" | "proxy"

async function probeId(id, wid, transport = "cf") {
  await waitIfPaused();
  state.currentId = id;

  // Mode TOR : force utilisation proxy (Tor injecté dans pool)
  const result = transport === "proxy"
    ? await fetchPlayerViaProxy(id, wid)   // wid → circuit TOR isolé
    : await fetchPlayerViaCF(id);
  state.scanned++;

  // DEBUG: Log TOUS les résultats (1 sur 500) pour diagnostic
  if (Math.random() < 0.002) {
    console.log(`[DEBUG] ID ${id} transport=${transport} result:`, JSON.stringify(result));
  }

  if (result.found) {
    savePlayer({
      id,
      nickname:    result.nickname,
      kid:         result.kid,
      avatarFrame: result.avatarFrame,
      stateLevel:  result.stateLevel,
      allianceTag: result.allianceTag,
    });
    state.found++;
    adaptDelay(wid, result);
    resolveError(id);
    if (result.nickname.toLowerCase() !== `lord${id}`) {
      pushEvent("found", id, { id, nickname: result.nickname, kid: result.kid, stateLevel: result.stateLevel });
    }
    setState("last_scanned_id", id);
    return "found";

  } else if (result.error === "rate_limited") {
    state.rateLimited++;  // Option A: Track rate-limit separately
    // Phase C: backoff plus efficace contre rate limits
    workerDelays[wid] = Math.min(workerDelays[wid] + 50, MAX_DELAY);
    state.avgDelay = getAvgDelay();
    setState("last_delay", state.avgDelay);
    await sleep(500);  // Phase C: 500ms au lieu de 100ms
    return await probeId(id, wid, transport);

  } else if (!result.found && !result.error) {
    markDead(id);
    state.dead++;
    adaptDelay(wid, { found: true });
    resolveError(id);
    setState("last_scanned_id", id);
    return "dead";

  } else if (result.error === "no_proxy" || result.error === "proxy_failed") {
    state.errorProxy++;  // Option A: Track proxy failures separately
    // Pool de proxies vide ou tous échoués — attente courte
    // 🔒 GARANTIE COUVERTURE : logger pour retest (l'ID n'a PAS eu de réponse définitive)
    // retry court (2 min) car c'est le proxy le problème, pas l'ID WOS
    logError(id, result.error, 2 * 60 * 1000);
    watchdog.reportProxyFailure();
    await sleep(250);  // Phase D: 250ms au lieu de 500ms
    return "error";

  } else if (result.error === "cf_quota_exhausted") {
    state.errorCfQuota++;  // Option A: Track CF quota exhaustion separately
    // Quota CF épuisé — ce worker CF ne sert plus à rien
    watchdog.reportCfQuota();
    await sleep(500);  // Phase D: 500ms au lieu de 1s
    return "error";

  } else if (transport === "proxy" && (result.error === "timeout" || result.error === "network_error")) {
    state.errorTimeout++;  // Option A: Track timeout/network errors separately
    // Timeout / erreur réseau via proxy — c'est le proxy qui est mort, pas l'ID WOS
    // 🔒 GARANTIE COUVERTURE : logger pour retest (sinon cet ID est perdu à jamais)
    // retry court (2 min) car le proxy est en cause, pas l'ID WOS
    logError(id, result.error, 2 * 60 * 1000);
    watchdog.reportProxyFailure();
    return "error";

  } else if (result.error && /^http_5\d\d$/.test(result.error)) {
    state.error5xx++;  // Option A: Track 5xx errors separately
    state.errors++;  // Keep total counter
    watchdog.reportApiError(result.error);
    await sleep(25);  // Phase D: 25ms au lieu de 50ms
    return "error";

  } else {
    // Erreur réelle WOS API (via CF ou direct) → on la log pour retry
    state.errors++;
    // Option A: Track timeout errors via CF/direct separately
    if (result.error === "timeout" || result.error === "network_error") {
      state.errorTimeout++;
    }
    adaptDelay(wid, result);
    const retryDelay = (result.error === "timeout" || result.error === "network_error")
      ? 60 * 60 * 1000
      : 30 * 60 * 1000;
    logError(id, result.error ?? "unknown", retryDelay);
    watchdog.reportApiError(result.error);
    return "error";
  }
}

// ─── Log périodique ────────────────────────────────────────────────────────────

async function periodicLog() {
  while (state.running) {
    await sleep(10_000);

    // 🔥 Ajuster dynamiquement le nombre de workers proxy
    updateProxyWorkers();

    const elapsed   = (Date.now() - state.startTs) / 1000;
    const rateMs    = elapsed > 0 ? (elapsed * 1000) / Math.max(state.scanned, 1) : 0;
    const apiRate   = state.scanned / elapsed;   // vraies requêtes API/s
    const skipRate  = state.skipped / elapsed;   // IDs sautés/s (sans appel)

    logScan({ scanned: state.scanned, found: state.found, notFound: state.dead, errors: state.errors, rateMs });

    const stats         = getStats();
    const pendingErrors = countPendingErrors();
    const delayMin      = Math.min(...workerDelays);
    const delayMax      = Math.max(...workerDelays);
    console.log(
      `[${new Date().toISOString()}] ` +
      `api=${state.scanned}(${apiRate.toFixed(1)}/s) skipped=${state.skipped}(${skipRate.toFixed(0)}/s) ` +
      `found=${state.found} dead=${state.dead} err=${state.errors} pending=${pendingErrors} | ` +
      `delay=${delayMin}-${delayMax}ms${state.paused ? " [PAUSED]" : ""} | ` +
      `phase=${state.phase} id=${state.currentId} | ` +
      `total_players=${stats.total_players} | max_id=${stats.max_id ?? "—"}`
    );

    const proxy        = poolStats();
    const cfActive     = cfAvailable();
    const cfWorkerDelays   = workerDelays.slice(0, CONCURRENCY_CF);
    const proxyWorkerDelays = workerDelays.slice(CONCURRENCY_CF);
    const cfDelayAvg   = Math.round(cfWorkerDelays.reduce((a, b) => a + b, 0) / cfWorkerDelays.length);
    const proxyDelayAvg = Math.round(proxyWorkerDelays.reduce((a, b) => a + b, 0) / proxyWorkerDelays.length);

    setState("scraper_status", JSON.stringify({
      running:         state.running,
      paused:          state.paused,
      delay:           state.avgDelay,
      delayMin,
      delayMax,
      phase:           state.phase,
      scanned:         state.scanned,
      skipped:         state.skipped,
      found:           state.found,
      dead:            state.dead,
      errors:          state.errors,
      // Option A: Error breakdown
      rateLimited:     state.rateLimited,
      errorTimeout:    state.errorTimeout,
      error5xx:        state.error5xx,
      errorProxy:      state.errorProxy,
      errorCfQuota:    state.errorCfQuota,
      pendingErrors:   pendingErrors,
      currentId:       state.currentId,
      ratePerSec:      +apiRate.toFixed(2),      // Requêtes API/s
      skipRate:        +skipRate.toFixed(2),     // IDs skippés/s
      processingRate:  +(apiRate + skipRate).toFixed(2), // Total IDs traités/s
      concurrency:     CONCURRENCY,
      concurrencyCF:   CONCURRENCY_CF,
      concurrencyProxy: CONCURRENCY_PROXY,
      cfActive,
      cfDelayAvg,
      proxyDelayAvg,
      proxyTotal:      proxy.total,
      proxyByType:     proxy,
      startTs:         state.startTs,         // Timestamp début de session
      sessionDuration: Math.floor(elapsed),   // Durée en secondes
      updatedAt:       Date.now(),
    }));
  }
}

// ─── Phase 1 : exploration bidirectionnelle (pool de workers) ──────────────────

async function phase1() {
  let upId   = getState("explore_up",   START_ID);
  let downId = getState("explore_down", START_ID - 1);

  const UP_LIMIT   = parseInt(process.env.UP_LIMIT || getState("explore_up_limit", START_ID + 15_000_000));
  const DOWN_LIMIT = getState("explore_down_limit",  Math.max(1, START_ID - 5_000_000));

  console.log(`\n=== PHASE 1 : Exploration bidirectionnelle (${CONCURRENCY} workers) ===`);
  console.log(`  up: ${upId} → ${UP_LIMIT} | down: ${downId} → ${DOWN_LIMIT}`);

  // ✅ Quick-Win #2 : Initialiser Bloom Filters au démarrage
  initBloomFilters();

  let deadUp = 0, deadDown = 0;
  let done = false;

  // ── Calcul des plages non-scannées ────────────────────────────────────────────
  // Au lieu de vérifier chaque ID un par un, on charge les intervalles contigus
  // de dead_ids + players et on saute directement aux "trous"
  // ── LOAD BALANCER : Multiple queues pour distribuer la charge ──────────────────
  const NUM_QUEUES = 100;                    // 100 queues pour distribuer ~200 workers/queue
  const QUEUE_SIZE = 100_000 / NUM_QUEUES;  // 1000 IDs par queue
  const idQueues   = Array.from({ length: NUM_QUEUES }, () => new CircularQueue(10000));
  let queueIndex   = 0;                      // Round-robin pour distribution
  let fillerDone   = false;
  let gapDone      = true;

  // Curseur principal : couvre upId → UP_LIMIT en sautant UNIQUEMENT les IDs connus individuellement
  function fillMain(n) {
    let added = 0;
    const BLOCK = 50_000;  // Phase D: 50k au lieu de 10k pour réduire queries SQL
    while (added < n && upId <= UP_LIMIT) {
      const blockEnd = Math.min(upId + BLOCK - 1, UP_LIMIT);
      // ✅ Quick-Win #2 : Suppression queries inutiles (knownSet jamais utilisé dans fillMain)
      // AVANT : 2× queries SQL bloquantes (20-40ms) par bloc → GASPILLAGE
      // APRÈS : aucune query, gain +120-160ms par cycle

      let lastProcessedId = upId - 1;
      for (let id = upId; id <= blockEnd && added < n; id++) {
        lastProcessedId = id;
        // 🔥 SCAN TOUS LES IDs SANS SKIP (même ceux déjà connus en DB)
        // 🔄 Load Balancer : distribution round-robin entre les queues
        idQueues[queueIndex].enqueue({ id, dir: "up" });
        queueIndex = (queueIndex + 1) % NUM_QUEUES;
        added++;
      }

      // ✅ CRITIQUE : ne mettre à jour upId que jusqu'à lastProcessedId, pas blockEnd !
      upId = lastProcessedId + 1;
      setState("explore_up", upId);
    }
    if (upId > UP_LIMIT) fillerDone = true;
  }

  // Curseur de gap — inutilisé (fusionné dans fillMain)
  const GAP_START = upId;
  const GAP_END   = upId;
  let   gapCursor = upId;

  // ✅ Quick-Win #2 : Statements SQL supprimés (remplacés par Bloom Filter)
  // const stmtDeadInRange    = db.prepare(`SELECT id FROM dead_ids WHERE id BETWEEN ? AND ?`);
  // const stmtPlayersInRange = db.prepare(`SELECT id FROM players   WHERE id BETWEEN ? AND ?`);

  function fillGap(n) {
    if (gapDone || gapCursor >= GAP_END) { gapDone = true; return; }
    let added = 0;
    const BLOCK = 50_000;  // scan 50k IDs à la fois, filtrer en JS
    while (added < n && gapCursor <= GAP_END) {
      const blockEnd = Math.min(gapCursor + BLOCK - 1, GAP_END);
      // ✅ Quick-Win #2 : Bloom Filter au lieu de queries SQL (20-40ms → <1ms)
      // AVANT : 2× queries SQL bloquantes par bloc
      // APRÈS : 2× bloom.has() = O(1) lookup, <0.01ms par ID

      // Injecter les IDs inconnus
      for (let id = gapCursor; id <= blockEnd && added < n; id++) {
        const isKnown = deadIdsBloom.has(id) || playersBloom.has(id);
        if (!isKnown) { idQueue.enqueue({ id, dir: "up" }); added++; }
        else state.scanned++;
      }
      gapCursor = blockEnd + 1;
      setState("explore_gap_cursor", gapCursor);
    }
    if (gapCursor > GAP_END) gapDone = true;
  }

  let errorQueueTs = 0;

  function fillErrors() {
    if (Date.now() - errorQueueTs < 10_000) return;  // 🚀 Injection toutes les 10s au lieu de 30s
    errorQueueTs = Date.now();
    const errors = getErrorsToRetry(500);
    if (errors.length === 0) return;
    // Injecter en tête de chaque queue (priorité haute, round-robin)
    for (let i = 0; i < errors.length; i++) {
      const qIdx = i % NUM_QUEUES;
      idQueues[qIdx].enqueueFront({ id: errors[i].id, dir: "up" });
    }
    console.log(`🔁 [filler] ${errors.length} erreurs injectées en priorité (distribué sur ${NUM_QUEUES} queues)`);
  }

  async function runFiller() {
    fillMain(QUEUE_SIZE * NUM_QUEUES);
    fillErrors();

    while (!fillerDone && state.running && state.phase === 1) {
      // Vérifier le total d'IDs dans toutes les queues
      const totalIds = idQueues.reduce((sum, q) => sum + q.size(), 0);
      if (totalIds < (QUEUE_SIZE * NUM_QUEUES) / 2) {
        fillErrors(); // priorité erreurs
        fillMain((QUEUE_SIZE * NUM_QUEUES) / 2);
      }
      await sleep(50);
    }
  }

  // 🔄 Load Balancer : chaque worker pioche dans sa queue assignée
  async function nextId(wid) {
    const queueIdx = wid % NUM_QUEUES;  // Assign worker à une queue
    while (true) {
      if (idQueues[queueIdx].size() > 0) return idQueues[queueIdx].dequeue();
      // Si queue vide, essayer d'autres queues (load balancing)
      for (let i = 0; i < NUM_QUEUES; i++) {
        if (idQueues[i].size() > 0) return idQueues[i].dequeue();
      }
      if (fillerDone) return null;
      await sleep(5);
    }
  }

  async function p1Worker(wid, transport) {
    while (state.running) {
      if (transport === "proxy" && poolStats().total === 0) {
        await sleep(3_000); continue;
      }
      const next = await nextId(wid);
      if (!next) return;
      const res = await probeId(next.id, wid, transport);

      if (next.dir === "up") {
        if (res === "dead") deadUp++; else deadUp = 0;
        if (deadUp >= MAX_DEAD_STREAK) { setState("explore_up_limit", upId); done = true; fillerDone = true; }
      } else {
        if (res === "dead") deadDown++; else deadDown = 0;
        if (deadDown >= MAX_DEAD_STREAK) { setState("explore_down_limit", downId); done = true; fillerDone = true; }
      }

      await sleep(workerDelays[wid]);
    }
  }

  // Remplir la queue initiale puis lancer filler + workers en parallèle
  fillMain(QUEUE_SIZE);

  // 🔥 Ajuster le nombre de workers au démarrage
  updateProxyWorkers();
  console.log(`🔥 MODE ULTRA-AGRESSIF : ${CONCURRENCY_CF} CF + ${CONCURRENCY_PROXY} proxy workers (${WORKERS_PER_PROXY} workers/proxy)`);

  const cfWorkers    = Array.from({ length: CONCURRENCY_CF },    (_, i) => p1Worker(i, "cf"));
  const proxyWorkers = Array.from({ length: CONCURRENCY_PROXY }, (_, i) => p1Worker(CONCURRENCY_CF + i, "proxy"));
  await Promise.all([runFiller(), ...cfWorkers, ...proxyWorkers]);

  console.log("✅ Phase 1 terminée");
  setState("phase", 2);
  state.phase = 2;
}

// ─── Phase 2 : scan continu (pool de workers) ─────────────────────────────────
//
// Chaque worker tire le prochain ID disponible depuis 3 sources prioritaires :
//   C) error_ids en retry (priorité haute)
//   B) rescan_cursor (range connu, skip récents)
//   A) explore_up (nouveaux IDs, jamais arrêté)

async function scanComplet() {
  // ── Modèle PULL : chaque worker tire directement le prochain ID. ──
  // Le curseur = position RÉELLE de traitement (1 ID pris = 1 probe).
  // Plus de queue découplée → pas d'explosion mémoire, curseur honnête.
  const CURSOR_KEY = `cursor_inst_${INSTANCE_ID}`;
  let scanId = getState(CURSOR_KEY, SCAN_START);
  if (scanId < SCAN_START || scanId > SCAN_END) scanId = SCAN_START;

  console.log(`\n=== PHASE 1 — SCAN COMPLET [inst ${INSTANCE_ID}] ${RETRY_ONLY
    ? `RETRY-ONLY (retest erreurs, fallback scan ${SCAN_START}→${SCAN_END})`
    : `SCAN ${scanId} → ${SCAN_END}`} ===`);

  // Skip des IDs déjà connus, par blocs de 50k (requête SQL indexée, léger)
  const SCAN_BLOCK = 50_000;
  const stmtKnownInRange = db.prepare(
    `SELECT id FROM players  WHERE id BETWEEN ? AND ?
     UNION
     SELECT id FROM dead_ids WHERE id BETWEEN ? AND ?`
  );
  let scanBlockEnd = scanId - 1;
  let knownSet = new Set();
  function refreshKnownSet() {
    const a = scanId;
    const b = Math.min(scanId + SCAN_BLOCK - 1, SCAN_END);
    knownSet = new Set(stmtKnownInRange.all(a, b, a, b).map(r => r.id));
    scanBlockEnd = b;
  }

  // File des erreurs à retester (rechargée toutes les 5s, bornée)
  let retryQueue = [];
  let lastRetryFetch = 0;
  function refillRetry() {
    if (Date.now() - lastRetryFetch < 5000) return;
    lastRetryFetch = Date.now();
    if (retryQueue.length < 1000) {
      const errs = getErrorsToRetry(5000);
      if (errs.length) retryQueue = errs.map(e => e.id);
    }
  }

  let lastPersist = scanId;
  function persistCursor() {
    if (scanId - lastPersist >= 500) { setState(CURSOR_KEY, scanId); lastPersist = scanId; }
  }

  // Prochain ID de SCAN (saute les connus). Retourne null si plage finie.
  function nextScanId() {
    while (scanId <= SCAN_END) {
      if (scanId > scanBlockEnd) refreshKnownSet();
      const id = scanId++;
      persistCursor();
      if (knownSet.has(id)) { state.skipped++; continue; }
      return id;
    }
    return null;
  }

  // Source d'un ID pour un worker :
  //  - RETRY_ONLY : erreurs prioritaires, sinon scan (fallback si liste vide)
  //  - SCAN       : scan prioritaire, sinon (plage finie) aide au retest
  function nextWork() {
    if (RETRY_ONLY) {
      refillRetry();
      if (retryQueue.length) return retryQueue.shift();
      return nextScanId();
    } else {
      const id = nextScanId();
      if (id != null) return id;
      refillRetry();
      if (retryQueue.length) return retryQueue.shift();
      return null;
    }
  }

  let aliveWorkers = 0;
  let workerExceptions = 0;
  async function worker(wid) {
    aliveWorkers++;
    try {
      while (state.running) {
        // 🔒 ROBUSTE : un worker ne doit JAMAIS mourir sur une exception ponctuelle
        // (erreur DB SQLITE_BUSY, parse, réseau…). On attrape tout et on continue.
        try {
          if (poolStats().total === 0) { await sleep(2_000); continue; }
          const id = nextWork();
          if (id == null) { await sleep(500); continue; }
          await probeId(id, wid, "proxy");
          await sleep(workerDelays[wid]);
        } catch (err) {
          workerExceptions++;
          if (workerExceptions % 50 === 1) console.error(`⚠️ worker exception #${workerExceptions} (wid ${wid}, continue):`, err.message);
          await sleep(100);
        }
      }
    } finally {
      aliveWorkers--;
      // 💀 Ne devrait arriver QUE si state.running=false (arrêt voulu). Sinon = bug.
      console.error(`💀 WORKER ${wid} TERMINÉ — running=${state.running}, vivants=${aliveWorkers}/${CONCURRENCY_PROXY}`);
    }
  }

  // Heartbeat : log du nombre de workers vivants toutes les 30s (détecte une hémorragie)
  const hb = setInterval(() => {
    console.log(`💓 [heartbeat] workers vivants: ${aliveWorkers}/${CONCURRENCY_PROXY} | exceptions cumulées: ${workerExceptions}`);
    if (!state.running) clearInterval(hb);
  }, 30_000);

  updateProxyWorkers();
  console.log(`🔥 PHASE 1 — SCAN COMPLET [inst ${INSTANCE_ID}] : ${CONCURRENCY_PROXY} proxy workers ${RETRY_ONLY ? '(RETEST)' : '(SCAN)'}`);

  const workers = Array.from({ length: CONCURRENCY_PROXY }, (_, i) => worker(i));
  await Promise.all(workers);
}

// ─── Point d'entrée ────────────────────────────────────────────────────────────

process.on("SIGINT",  () => { state.running = false; console.log("\nScraper arrêté (SIGINT).");  });
process.on("SIGTERM", () => { state.running = false; console.log("\nScraper arrêté (SIGTERM)."); });

// 🔒 PROTECTION ULTIME : ne JAMAIS laisser une exception non gérée tuer le process.
// (une unhandledRejection/uncaughtException ferait mourir TOUS les workers d'un coup)
process.on("uncaughtException", (err) => {
  console.error("🔴 uncaughtException (process maintenu vivant):", err?.message, err?.stack?.split("\n")[1]);
});
process.on("unhandledRejection", (reason) => {
  console.error("🔴 unhandledRejection (process maintenu vivant):", reason?.message || reason);
});

export async function startScraper() {
  // 🔒 MODE UNIQUE : scan complet (phase 1). Pas de phase 2, pas de transition.
  state.phase = 1;
  setState("phase", 1);

  console.log(`🚀 WOS Player Scraper démarré — ${CONCURRENCY_CF} workers CF + ${CONCURRENCY_PROXY} workers proxy`);
  console.log(`   Délai initial: ${MIN_DELAY}ms/worker | Mode: PHASE 1 — SCAN COMPLET`);
  periodicLog();
  watchdog.start(resetCfWorkerDelays);

  while (state.running) {
    try {
      await scanComplet();   // scan exhaustif distribué (le seul mode)
    } catch (err) {
      console.error("Erreur scraper:", err);
      await sleep(5000);
    }
  }

  setState("last_delay", state.avgDelay);
  console.log("Scraper arrêté.");
}

// Lancement direct (node src/scraper.mjs)
const isMain = process.argv[1]?.endsWith("scraper.mjs");
if (isMain) {
  startScraper().catch(console.error);
}
