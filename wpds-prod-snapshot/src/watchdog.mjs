/**
 * watchdog.mjs — Auto-healing system for WPDS
 *
 * Detects problems in real-time and applies corrective actions automatically:
 *   - Proxy pool empty / all failing → force immediate pool refresh
 *   - CF quota exhausted → waits for midnight UTC, then resets CF worker delays automatically
 *   - Too many API errors → counts but doesn't block (CF backoff auto-recovers)
 *   - Error table overflowing with stale entries → auto-resolves/purges old ones
 *   - http_5xx errors → never logged in error_ids (handled in scraper.mjs)
 */

import { refreshPool, poolStats, needsRefresh } from "./proxy.mjs";
import { setState, getState, countPendingErrors, db } from "./db.mjs";
import { cfAvailable } from "./api.mjs";

// ─── Config ────────────────────────────────────────────────────────────────────

const CHECK_INTERVAL       = 15_000;            // check every 15s
const PROXY_FAIL_THRESHOLD = 200;               // N failures in one window → force refresh
const PROXY_FAIL_WINDOW    = 30_000;            // window size (ms)
const STALE_ERROR_MAX_AGE  = 6 * 60 * 60 * 1000; // 6h → auto-resolve stale errors
const STALE_ERROR_MAX_ROWS = 10_000;            // purge resolved rows above this count

// ─── State ────────────────────────────────────────────────────────────────────

let proxyFailCount    = 0;
let proxyFailWindow   = Date.now();
let cfQuotaExhausted  = false;
let cfResetAt         = null;    // timestamp of next midnight UTC when quota resets
let apiErrorCount     = 0;
let lastRefreshForced = 0;

// resetCfWorkerDelays will be injected by start() to avoid circular import
let _resetCfDelays = null;

// ─── Signal receivers (called from scraper.mjs probeId) ───────────────────────

export const watchdog = {

  reportProxyFailure() {
    const now = Date.now();
    if (now - proxyFailWindow > PROXY_FAIL_WINDOW) {
      proxyFailCount  = 0;
      proxyFailWindow = now;
    }
    proxyFailCount++;
  },

  reportCfQuota() {
    if (!cfQuotaExhausted) {
      cfQuotaExhausted = true;
      // Compute next midnight UTC
      const now = new Date();
      cfResetAt = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1);
      const minsLeft = Math.round((cfResetAt - Date.now()) / 60_000);
      console.warn(`🔴 [watchdog] CF quota exhausted — will auto-reset in ~${minsLeft}min (0:00 UTC)`);
      setState("watchdog_cf_quota_reset_at", cfResetAt);
    }
  },

  reportApiError(errorType) {
    apiErrorCount++;
    if (apiErrorCount % 500 === 0) {
      console.warn(`⚠️  [watchdog] ${apiErrorCount} transient API errors since start (last: ${errorType})`);
    }
  },

  // ─── Main loop ───────────────────────────────────────────────────────────────

  start(resetCfFn) {
    _resetCfDelays = resetCfFn;
    console.log("🛡️  Watchdog started — auto-healing active");

    // Also pick up any persisted quota state from a previous run
    const saved = getState("watchdog_cf_quota_reset_at", null);
    if (saved && saved > Date.now()) {
      cfQuotaExhausted = true;
      cfResetAt = saved;
      const minsLeft = Math.round((cfResetAt - Date.now()) / 60_000);
      console.warn(`🔴 [watchdog] CF quota still exhausted from previous run — resets in ~${minsLeft}min`);
    }

    setInterval(() => this._check(), CHECK_INTERVAL);
  },

  _check() {
    this._checkCfQuotaReset();
    this._checkProxyPool();
    this._checkStaleErrors();
    this._updateStatus();
  },

  // ─── Check 1 : CF quota reset at midnight UTC ─────────────────────────────────

  _checkCfQuotaReset() {
    if (!cfQuotaExhausted) return;
    if (Date.now() < cfResetAt) return;

    // Midnight passed — CF quotas are reset
    cfQuotaExhausted = false;
    cfResetAt        = null;
    setState("watchdog_cf_quota_reset_at", null);

    // Reset the backoff delays on all CF workers so they wake up immediately
    if (_resetCfDelays) _resetCfDelays();

    console.log("✅ [watchdog] 0:00 UTC — CF quota reset. CF workers reactivated at full speed.");
  },

  // ─── Check 2 : proxy pool ─────────────────────────────────────────────────────

  _checkProxyPool() {
    const stats = poolStats();
    const now   = Date.now();
    const canForce = (now - lastRefreshForced) > 3 * 60 * 1000; // max 1 forced refresh/3min

    if (stats.total === 0) {
      if (canForce) {
        console.warn("🔴 [watchdog] Proxy pool empty — forcing refresh");
        refreshPool();
        lastRefreshForced = now;
        proxyFailCount    = 0;
        proxyFailWindow   = now;
      }
      return;
    }

    if (proxyFailCount >= PROXY_FAIL_THRESHOLD && canForce) {
      console.warn(
        `🟡 [watchdog] ${proxyFailCount} proxy failures/${PROXY_FAIL_WINDOW / 1000}s ` +
        `(pool: ${stats.total}) — forcing refresh`
      );
      refreshPool();
      lastRefreshForced = now;
      proxyFailCount    = 0;
      proxyFailWindow   = now;
      return;
    }

    if (stats.total < 20 && canForce) {
      console.warn(`🟡 [watchdog] Proxy pool low (${stats.total}) — triggering refresh`);
      refreshPool();
      lastRefreshForced = now;
    }
  },

  // ─── Check 3 : stale / overflowing error_ids ──────────────────────────────────

  _checkStaleErrors() {
    try {
      // 🔁 PLUS D'ABANDON : avant, on marquait resolved=1 les erreurs >6h (puis purgées)
      // → IDs PERDUS sans vraie réponse. Désormais on les GARDE en file (resolved=0) jusqu'à
      // une vraie réponse (found/dead) → garantie de couverture. On logge juste le backlog ancien.
      const old = db.prepare(`
        SELECT COUNT(*) AS c FROM error_ids WHERE resolved = 0 AND last_error < ?
      `).get(Date.now() - STALE_ERROR_MAX_AGE).c;
      if (old > 0) {
        console.log(`🔁 [watchdog] ${old} erreurs >6h CONSERVÉES en file (retest jusqu'à vraie réponse)`);
      }

      // Purge resolved rows if table is too large
      const total = db.prepare(`SELECT COUNT(*) AS c FROM error_ids`).get()?.c ?? 0;
      if (total > STALE_ERROR_MAX_ROWS) {
        const purged = db.prepare(`
          DELETE FROM error_ids WHERE resolved = 1 AND last_error < ?
        `).run(Date.now() - 30 * 60 * 1000).changes;
        if (purged > 0) console.log(`🧹 [watchdog] Purged ${purged} resolved error_ids rows`);
      }

      const pending = countPendingErrors();
      if (pending > 0 && pending % 1000 === 0) {
        console.warn(`⚠️  [watchdog] ${pending} errors pending retry`);
      }
    } catch (err) {
      console.error("[watchdog] stale error check failed:", err.message);
    }
  },

  // ─── Status ───────────────────────────────────────────────────────────────────

  _updateStatus() {
    const stats   = poolStats();
    const pending = countPendingErrors();
    const minsToReset = cfResetAt ? Math.round((cfResetAt - Date.now()) / 60_000) : null;
    setState("watchdog_status", JSON.stringify({
      proxyPool:         stats.total,
      cfQuotaExhausted,
      cfResetsInMins:    minsToReset,
      apiErrors:         apiErrorCount,
      pendingErrors:     pending,
      updatedAt:         Date.now(),
    }));
  },
};

