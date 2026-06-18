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

// 📊 Compteurs cumulés de succès (WOS 200) PAR SOURCE de transport.
// Lus par le scraper et écrits en DB → l'API dashboard calcule le débit/s TOR vs proxy.
export const sourceMetrics = { torSuccess: 0, proxySuccess: 0 };
// 📊 DIAGNOSTIC : répartition des issues des requêtes PROXY PUBLIC (pas TOR).
export const proxyFails = { ok: 0, s429: 0, s403: 0, s4xx: 0, s5xx: 0, parse: 0, timeout: 0, neterr: 0 };
let _pfTick = 0;
function pf(reason, latency) {
  proxyFails[reason]++;
  if (++_pfTick % 500 === 0) {
    const t = proxyFails, tot = Object.values(t).reduce((a, b) => a + b, 0);
    console.log(`📊 [proxyFails/${tot}] ok=${t.ok} timeout=${t.timeout} neterr=${t.neterr} 403=${t.s403} 4xx=${t.s4xx} 5xx=${t.s5xx} 429=${t.s429} parse=${t.parse}`);
  }
}

export async function fetchPlayerViaProxy(playerId, wid = 0) {
  const body = buildBody(playerId);

  // 1 SEULE tentative. Circuit/proxy lent ou mort → on logge l'ID pour retest (couverture).
  for (let i = 0; i < 1; i++) {
    const slot = getProxy(wid);   // wid → circuit TOR isolé (stream-isolation SOCKS auth)
    if (!slot) return { error: "no_proxy" };
    const isTor = !!slot.proxy?.isTor;

    try {
      const startTime = Date.now();
      const result = await postViaProxy(
        slot.proxy,
        WOS_HOST, 443, WOS_PATH,
        body,
        buildHeaders(),   // User-Agent varié à chaque requête
        6_000   // 54% des proxies timeoutaient à 10s → on coupe à 6s (médiane des bons) : moins de temps gaspillé
      );
      const latency = Date.now() - startTime;

      if (result.status === 429) {
        if (!isTor) pf('s429'); reportRateLimit(slot); continue; // WOS rate-limit
      }
      if (result.status >= 500) {
        if (!isTor) pf('s5xx'); reportRateLimit(slot); continue; // erreur serveur WOS
      }
      if (result.status !== 200) {
        if (!isTor) pf(result.status === 403 ? 's403' : 's4xx'); reportFailure(slot); continue;
      }

      let data;
      try { data = JSON.parse(result.body); } catch { if (!isTor) pf('parse'); reportFailure(slot); continue; }

      // ✅ WOS 200 via cette source → compteur débit par source
      if (isTor) sourceMetrics.torSuccess++; else { sourceMetrics.proxySuccess++; pf('ok'); }
      reportSuccess(slot, latency);
      return parseResponse(data);

    } catch (e) {
      if (!isTor) pf(/timeout/i.test(String(e?.message)) ? 'timeout' : 'neterr');
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
