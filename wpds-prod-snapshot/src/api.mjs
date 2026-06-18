/**
 * api.mjs — Wrapper pour l'API CenturyGame (WOS)
 *
 * Deux fonctions indépendantes utilisées en parallèle par le scraper :
 *   fetchPlayerViaCF(id)    → via 50 Cloudflare Workers en round-robin
 *   fetchPlayerViaProxy(id) → via pool de proxies publics (HTTP/SOCKS5)
 *
 * Le scraper lance N workers CF + M workers proxy simultanément.
 */

import crypto from "node:crypto";
import { getProxy, reportFailure, reportRateLimit, reportSuccess, poolStats, postViaProxy, needsRefresh, refreshPool } from "./proxy.mjs";

const WOS_HASH   = "tB87#kPtkxqOS2";
const WOS_HOST   = "wos-giftcode-api.centurygame.com";
const WOS_PATH   = "/api/player";
const WOS_DIRECT = `https://${WOS_HOST}${WOS_PATH}`;

// ─── Config Workers CF ────────────────────────────────────────────────────────

const CF_WORKER_SECRET = process.env.CF_WORKER_SECRET || null;
const CF_WORKER_URLS   = (process.env.CF_WORKER_URL || "")
  .split(",").map(u => u.trim()).filter(Boolean);

let _rrIndex = 0;
function nextWorkerUrl() {
  if (CF_WORKER_URLS.length === 0) return null;
  const url = CF_WORKER_URLS[_rrIndex % CF_WORKER_URLS.length];
  _rrIndex++;
  return url;
}

let cfQuotaExhausted = false;
let cfQuotaResetAt   = null;

function nextMidnightUTC() {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1)).getTime();
}

export function cfAvailable() {
  if (CF_WORKER_URLS.length === 0) return false;
  if (!cfQuotaExhausted) return true;
  if (Date.now() >= cfQuotaResetAt) {
    cfQuotaExhausted = false;
    cfQuotaResetAt   = null;
    console.log("🌐 Quota CF resetté — workers CF de nouveau actifs");
    return true;
  }
  return false;
}

// ─── Headers ──────────────────────────────────────────────────────────────────
// Origin/Referer/Accept/Content-Type sont REQUIS par WOS (sinon 403). Seul le
// User-Agent est varié à chaque requête pour éviter qu'un filtre anti-bot repère
// un pattern fixe.
const USER_AGENTS = [
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/114.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:125.0) Gecko/20100101 Firefox/125.0",
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1",
  "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Mobile Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; WOW64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36",
];

// Construit les headers avec un User-Agent aléatoire (le reste est fixe/requis).
function buildHeaders() {
  return {
    "User-Agent":   USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)],
    "Accept":       "application/json, text/plain, */*",
    "Origin":       "https://wos-giftcode.centurygame.com",
    "Referer":      "https://wos-giftcode.centurygame.com/",
    "Content-Type": "application/x-www-form-urlencoded",
  };
}

// ─── Logs démarrage ───────────────────────────────────────────────────────────

if (CF_WORKER_URLS.length > 0) {
  console.log(`🌐 CF Workers : ${CF_WORKER_URLS.length} workers en round-robin`);
} else {
  console.log(`🔗 Pas de CF Workers configurés`);
}
console.log(`🔀 Proxies publics : pool actif (rafraîchissement toutes les 60min)`);

// ─── Helper ───────────────────────────────────────────────────────────────────

function md5(str) {
  return crypto.createHash("md5").update(str).digest("hex");
}

function buildBody(playerId) {
  const time = Date.now();
  const sign = md5(`fid=${playerId}&time=${time}${WOS_HASH}`);
  return new URLSearchParams({ sign, fid: String(playerId), time: String(time) }).toString();
}

function parseResponse(data) {
  if (!data || !data.data || !data.data.nickname) return { found: false };
  const d = data.data;
  return {
    found:       true,
    nickname:    d.nickname,
    kid:         d.kid                                    ?? 0,
    avatarFrame: d.avatarFrame ?? d.avatar_frame          ?? "",
    stateLevel:  d.stove_lv   ?? d.stateLevel ?? d.state_level ?? 0,
    headFrame:   d.headFrame  ?? d.head_frame             ?? "",
    allianceTag: d.allianceTag ?? d.alliance_tag          ?? "",
  };
}

// ─── Mode CF Worker ───────────────────────────────────────────────────────────

export async function fetchPlayerViaCF(playerId) {
  const body = buildBody(playerId);
  const url  = nextWorkerUrl();
  if (!url) return { error: "no_cf_worker" };

  try {
    const res = await fetch(url, {
      method:  "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", "X-WPDS-Secret": CF_WORKER_SECRET },
      body,
      signal:  AbortSignal.timeout(10_000),
    });

    if (res.status === 429) {
      const text = await res.text().catch(() => "");
      if (text.includes("daily_limit_reached")) {
        cfQuotaExhausted = true;
        cfQuotaResetAt   = nextMidnightUTC();
        const resetIn = Math.round((cfQuotaResetAt - Date.now()) / 1000 / 60);
        console.warn(`⚠️  Quota CF épuisé — workers CF désactivés (~${resetIn}min avant reset)`);
        return { error: "cf_quota_exhausted" };
      }
      return { error: "rate_limited" };
    }

    if (!res.ok) return { error: `http_${res.status}` };
    return parseResponse(await res.json());

  } catch (err) {
    if (err.name === "TimeoutError" || err.name === "AbortError") return { error: "timeout" };
    return { error: "network_error" };
  }
}

// ─── Mode Proxy public ────────────────────────────────────────────────────────

export async function fetchPlayerViaProxy(playerId, wid = 0) {
  const body = buildBody(playerId);

  // TOR pur : 1 SEULE tentative. Un circuit lent/mort → on logge l'ID pour retest
  // (par l'instance 4) au lieu de bloquer le worker jusqu'à 3×timeout.
  for (let i = 0; i < 1; i++) {
    const slot = getProxy(wid);   // wid → circuit TOR isolé (stream-isolation SOCKS auth)
    if (!slot) return { error: "no_proxy" };

    try {
      const startTime = Date.now();
      const result = await postViaProxy(
        slot.proxy,
        WOS_HOST, 443, WOS_PATH,
        body,
        buildHeaders(),   // User-Agent varié à chaque requête
        8_000
      );
      const latency = Date.now() - startTime;

      if (result.status === 429) {
        reportRateLimit(slot); continue; // proxy vivant mais WOS rate-limit → cooldown 60s
      }
      if (result.status >= 500) {
        reportRateLimit(slot); continue; // erreur serveur WOS → proxy pas en cause
      }
      if (result.status !== 200) {
        reportFailure(slot); continue;   // vrai échec du proxy (4xx, etc.)
      }

      let data;
      try { data = JSON.parse(result.body); } catch { reportFailure(slot); continue; }

      reportSuccess(slot.idx, latency);  // 🎯 Passer latence pour ranking qualité
      return parseResponse(data);

    } catch {
      reportFailure(slot);
    }
  }

  return { error: "proxy_failed" };
}

// ─── fetchPlayer générique (fallback enchaîné) ────────────────────────────────
// Utilisé si on veut un seul point d'entrée (ex: dashboard /api/player/:id)

export async function fetchPlayer(playerId) {
  if (cfAvailable()) {
    const r = await fetchPlayerViaCF(playerId);
    if (r.error !== "cf_quota_exhausted") return r;
  }

  const stats = poolStats();
  if (stats.total > 0) {
    const r = await fetchPlayerViaProxy(playerId);
    if (r.error !== "no_proxy" && r.error !== "proxy_failed") return r;
  }

  // Fallback direct
  try {
    const body = buildBody(playerId);
    const res  = await fetch(WOS_DIRECT, {
      method: "POST", headers: buildHeaders(), body,
      signal: AbortSignal.timeout(10_000),
    });
    if (res.status === 429) return { error: "rate_limited" };
    if (!res.ok)            return { error: `http_${res.status}` };
    return parseResponse(await res.json());
  } catch (err) {
    if (err.name === "TimeoutError" || err.name === "AbortError") return { error: "timeout" };
    return { error: "network_error" };
  }
}

export { poolStats };
