/**
 * proxy.mjs — Pool de proxies publics gratuits, optimisé débit maximal
 *
 * 30+ sources publiques → ~50 000 proxies bruts → ~2000-4000 vivants
 * Batch 500 tests parallèles → test complet en ~3 minutes
 * Cooldown 10s (vs 30s avant) → proxies recyclés plus vite
 * MAX_FAILURES = 5 → moins de retraits prématurés
 * Refresh toutes les 20min
 */

import http  from "node:http";
import https from "node:https";
import crypto from "node:crypto";
import { SocksClient } from "socks";
import { SocksProxyAgent } from "socks-proxy-agent";   // robuste : gère socks4/5 + auth (TOR isolation)
import { HttpsProxyAgent } from "https-proxy-agent";   // robuste : tunnel HTTP CONNECT vers cible HTTPS
import { readFileSync, readdirSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";

// 💾 Persistance/accumulation du pool : le pool vivant survit aux redémarrages et GROSSIT
// au fil des refresh (au lieu de repartir de 0 → plafond ~35). Fichier par instance.
const POOL_FILE = `/app/data/proxy-pool-${process.env.INSTANCE_ID || '0'}.json`;

// ─── Mode de transport : 'tor' | 'proxy' | 'hybrid' ───────────────────────────
// hybrid = proxies publics PRIORITAIRES + TOR en fallback (recommandé).
// Défaut hybrid : déployer ce fichier bascule l'instance en mode proxy hybride.
const PROXY_MODE       = process.env.PROXY_MODE || 'tor';   // défaut SÛR : prod reste TOR ; wpds1 a PROXY_MODE=hybrid en env
const TOR_ENABLED      = PROXY_MODE !== 'proxy';    // TOR dispo (pur ou fallback)
const TOR_HYBRID       = PROXY_MODE === 'hybrid';   // pool public actif + TOR en secours
const TOR_PORT_START   = parseInt(process.env.TOR_PORT_START || '9050');
const TOR_PORT_END     = parseInt(process.env.TOR_PORT_END || '9149');
const TOR_PORTS        = Array.from({length: TOR_PORT_END - TOR_PORT_START + 1}, (_, i) => TOR_PORT_START + i);
let torRoundRobin      = 0;
let torProxiesInjected = false;
const torPortCnt       = {};   // compteur d'usages par port (pour rotation désynchronisée des circuits)

const REFRESH_INTERVAL = 5 * 60 * 1000;   // 5min (×4 refresh pour pool toujours frais)
const TEST_TIMEOUT     = 8_000;           // 8s : marge pour valider les rapides même sous charge (anti-faux-négatif)
const TEST_HOST        = "wos-giftcode-api.centurygame.com";   // Option B: Test contre WOS réel
const TEST_PATH        = "/api/player?fid=701&_uid=1";
const MAX_TEST_BATCH   = 800;             // 800 tests parallèles (évite la saturation TLS → moins de faux négatifs)
const MIN_POOL_SIZE    = 20;
const MAX_FAILURES     = 12;              // tolérant : proxies publics instables → on les garde dans le pool
const COOLDOWN_MS      = 5_000;           // 5s de cooldown (recyclage rapide vers alive)
// ⏱️ CADENCE PAR PROXY : chaque IP n'est ré-utilisée qu'après PROXY_CADENCE_MS → évite le 429
// WOS (sur-sollicitation). Conséquence : débit ≈ (nb proxies vivants) / (cadence en s).
// Ex : 3000 proxies / 1.5s = 2000/s. C'est ce qui scale avec la taille du pool.
const PROXY_CADENCE_MS = 1_500;

// ─── Source statistics tracking ───────────────────────────────────────────────
const sourceStats = {
  attempted:   0,
  succeeded:   0,
  failed:      0,
  failedUrls:  [],  // Store failed URLs with reasons
  lastRefresh: 0,
};

// ─── 30+ sources publiques ────────────────────────────────────────────────────

const SOURCES = [
  // ⭐ ProxyScrape FILTRÉ <2s — RÉACTIVÉ avec le BON filtre (timeout=2000) : proxies RAPIDES
  // (médiane 1.6-2s, 38-45% vivants) — mesuré 18/06 comme la MEILLEURE source gratuite, ~niveau TOR.
  { url: "https://api.proxyscrape.com/v4/free-proxy-list/get?request=display_proxies&protocol=http&timeout=2000&proxy_format=ipport&format=text",   proto: "http"   },
  { url: "https://api.proxyscrape.com/v4/free-proxy-list/get?request=display_proxies&protocol=socks5&timeout=2000&proxy_format=ipport&format=text", proto: "socks5" },
  { url: "https://api.proxyscrape.com/v4/free-proxy-list/get?request=display_proxies&protocol=socks4&timeout=2000&proxy_format=ipport&format=text", proto: "socks4" },

  // ⭐ Listes VÉRIFIÉES (proxies pré-validés → plus rapides/vivants) — découvertes nuit 19/06
  { url: "https://raw.githubusercontent.com/databay-labs/free-proxy-list/master/http.txt",            proto: "http"   },
  { url: "https://raw.githubusercontent.com/databay-labs/free-proxy-list/master/socks5.txt",          proto: "socks5" },
  { url: "https://raw.githubusercontent.com/ClearProxy/checked-proxy-list/main/socks5/raw/all.txt",   proto: "socks5" },
  { url: "https://raw.githubusercontent.com/ClearProxy/checked-proxy-list/main/http/raw/all.txt",     proto: "http"   },
  { url: "https://raw.githubusercontent.com/ClearProxy/checked-proxy-list/main/socks4/raw/all.txt",   proto: "socks4" },
  { url: "https://raw.githubusercontent.com/proxygenerator1/ProxyGenerator/main/MostStable/socks5.txt", proto: "socks5" },
  { url: "https://raw.githubusercontent.com/proxygenerator1/ProxyGenerator/main/MostStable/http.txt",   proto: "http"   },
  { url: "https://raw.githubusercontent.com/proxifly/free-proxy-list/main/proxies/protocols/socks5/data.txt", proto: "socks5" },
  { url: "https://raw.githubusercontent.com/proxifly/free-proxy-list/main/proxies/protocols/http/data.txt",   proto: "http"   },

  // GitHub TheSpeedX — ~10 000 proxies
  { url: "https://raw.githubusercontent.com/TheSpeedX/PROXY-List/master/http.txt",   proto: "http"   },
  { url: "https://raw.githubusercontent.com/TheSpeedX/PROXY-List/master/socks5.txt", proto: "socks5" },
  { url: "https://raw.githubusercontent.com/TheSpeedX/PROXY-List/master/socks4.txt", proto: "socks4" },

  // GitHub monosans — mis à jour toutes les heures
  { url: "https://raw.githubusercontent.com/monosans/proxy-list/main/proxies/http.txt",   proto: "http"   },
  { url: "https://raw.githubusercontent.com/monosans/proxy-list/main/proxies/socks5.txt", proto: "socks5" },
  { url: "https://raw.githubusercontent.com/monosans/proxy-list/main/proxies/socks4.txt", proto: "socks4" },
  // monosans non-anonymes aussi
  { url: "https://raw.githubusercontent.com/monosans/proxy-list/main/proxies_anonymous/http.txt",   proto: "http"   },
  { url: "https://raw.githubusercontent.com/monosans/proxy-list/main/proxies_anonymous/socks5.txt", proto: "socks5" },

  // GitHub hookzof
  { url: "https://raw.githubusercontent.com/hookzof/socks5_list/master/proxy.txt", proto: "socks5" },

  // GitHub clarketm
  { url: "https://raw.githubusercontent.com/clarketm/proxy-list/master/proxy-list-raw.txt", proto: "http" },

  // GitHub ShiftyTR
  { url: "https://raw.githubusercontent.com/ShiftyTR/Proxy-List/master/http.txt",   proto: "http"   },
  { url: "https://raw.githubusercontent.com/ShiftyTR/Proxy-List/master/https.txt",  proto: "http"   },
  { url: "https://raw.githubusercontent.com/ShiftyTR/Proxy-List/master/socks4.txt", proto: "socks4" },
  { url: "https://raw.githubusercontent.com/ShiftyTR/Proxy-List/master/socks5.txt", proto: "socks5" },

  // GitHub mmpx12
  { url: "https://raw.githubusercontent.com/mmpx12/proxy-list/master/http.txt",   proto: "http"   },
  { url: "https://raw.githubusercontent.com/mmpx12/proxy-list/master/https.txt",  proto: "http"   },
  { url: "https://raw.githubusercontent.com/mmpx12/proxy-list/master/socks4.txt", proto: "socks4" },
  { url: "https://raw.githubusercontent.com/mmpx12/proxy-list/master/socks5.txt", proto: "socks5" },

  // GitHub jetkai — mise à jour auto
  { url: "https://raw.githubusercontent.com/jetkai/proxy-list/main/online-proxies/txt/proxies-http.txt",   proto: "http"   },
  { url: "https://raw.githubusercontent.com/jetkai/proxy-list/main/online-proxies/txt/proxies-socks5.txt", proto: "socks5" },
  { url: "https://raw.githubusercontent.com/jetkai/proxy-list/main/online-proxies/txt/proxies-socks4.txt", proto: "socks4" },

  // GitHub roosterkid
  { url: "https://raw.githubusercontent.com/roosterkid/openproxylist/main/HTTPS_RAW.txt", proto: "http"   },
  { url: "https://raw.githubusercontent.com/roosterkid/openproxylist/main/SOCKS5_RAW.txt", proto: "socks5" },
  { url: "https://raw.githubusercontent.com/roosterkid/openproxylist/main/SOCKS4_RAW.txt", proto: "socks4" },

  // GitHub almroot
  { url: "https://raw.githubusercontent.com/almroot/proxylist/master/list.txt", proto: "http" },

  // GitHub hendrikbgr
  { url: "https://raw.githubusercontent.com/hendrikbgr/Free-Proxy-Repo/master/proxy_list.txt", proto: "http" },

  // GitHub B4RC0D3
  { url: "https://raw.githubusercontent.com/B4RC0D3/TorProxyList/main/HTTP.txt",   proto: "http"   },
  { url: "https://raw.githubusercontent.com/B4RC0D3/TorProxyList/main/SOCKS5.txt", proto: "socks5" },

  // GitHub Anonym0usWork1221
  { url: "https://raw.githubusercontent.com/Anonym0usWork1221/Free-Proxies/main/proxy_files/http_proxies.txt",   proto: "http"   },
  { url: "https://raw.githubusercontent.com/Anonym0usWork1221/Free-Proxies/main/proxy_files/socks5_proxies.txt", proto: "socks5" },
  { url: "https://raw.githubusercontent.com/Anonym0usWork1221/Free-Proxies/main/proxy_files/socks4_proxies.txt", proto: "socks4" },

  // GitHub proxy4parsing
  { url: "https://raw.githubusercontent.com/proxy4parsing/proxy-list/main/http.txt",   proto: "http"   },
  { url: "https://raw.githubusercontent.com/proxy4parsing/proxy-list/main/socks5.txt", proto: "socks5" },

  // zloi0d, openproxylist.xyz, proxy5.net, fineproxy, spys.me, proxydb.net — DÉSACTIVÉS (timeout)
  // { url: "https://raw.githubusercontent.com/zloi0d/hideip.me/main/http.txt",   proto: "http"   },
  // { url: "https://raw.githubusercontent.com/zloi0d/hideip.me/main/socks5.txt", proto: "socks5" },
  // { url: "https://raw.githubusercontent.com/zloi0d/hideip.me/main/socks4.txt", proto: "socks4" },
  // { url: "https://openproxylist.xyz/http.txt",   proto: "http"   },
  // { url: "https://openproxylist.xyz/socks5.txt", proto: "socks5" },
  // { url: "https://openproxylist.xyz/socks4.txt", proto: "socks4" },
  // { url: "https://proxy5.net/api/proxy/list?type=http&anon=2,3&country=all&limit=500",   proto: "http"   },
  // { url: "https://proxy5.net/api/proxy/list?type=socks5&anon=2,3&country=all&limit=500", proto: "socks5" },
  // { url: "https://fineproxy.org/wp-content/themes/fineproxy/free-proxy.txt", proto: "http" },
  // { url: "https://spys.me/proxy.txt",  proto: "http"   },
  // { url: "https://spys.me/socks.txt",  proto: "socks5" },
  // { url: "https://proxydb.net/list?protocol=http&anonimity%5B%5D=anonymous&anonimity%5B%5D=elite&limit=500&offset=0", proto: "http" },

  // GitHub vakhov — fresh lists
  { url: "https://raw.githubusercontent.com/vakhov/fresh-proxy-list/master/http.txt",   proto: "http"   },
  { url: "https://raw.githubusercontent.com/vakhov/fresh-proxy-list/master/https.txt",  proto: "http"   },
  { url: "https://raw.githubusercontent.com/vakhov/fresh-proxy-list/master/socks4.txt", proto: "socks4" },
  { url: "https://raw.githubusercontent.com/vakhov/fresh-proxy-list/master/socks5.txt", proto: "socks5" },

  // GitHub sunny9577
  { url: "https://raw.githubusercontent.com/sunny9577/proxy-scraper/master/generated/http_proxies.txt",   proto: "http"   },
  { url: "https://raw.githubusercontent.com/sunny9577/proxy-scraper/master/generated/socks5_proxies.txt", proto: "socks5" },

  // GitHub MuRongPIG
  { url: "https://raw.githubusercontent.com/MuRongPIG/Proxy-Master/main/http.txt",   proto: "http"   },
  { url: "https://raw.githubusercontent.com/MuRongPIG/Proxy-Master/main/socks5.txt", proto: "socks5" },

  // GitHub prxchk
  { url: "https://raw.githubusercontent.com/prxchk/proxy-list/main/http.txt",   proto: "http"   },
  { url: "https://raw.githubusercontent.com/prxchk/proxy-list/main/socks5.txt", proto: "socks5" },
  { url: "https://raw.githubusercontent.com/prxchk/proxy-list/main/socks4.txt", proto: "socks4" },

  // GitHub ALIILAPRO
  { url: "https://raw.githubusercontent.com/ALIILAPRO/Proxy/main/http.txt",   proto: "http"   },
  { url: "https://raw.githubusercontent.com/ALIILAPRO/Proxy/main/socks5.txt", proto: "socks5" },

  // GitHub officialputUID
  { url: "https://raw.githubusercontent.com/officialputUID/public-proxy-list/main/http.txt",   proto: "http"   },
  { url: "https://raw.githubusercontent.com/officialputUID/public-proxy-list/main/socks5.txt", proto: "socks5" },

  // GitHub proxifly
  { url: "https://raw.githubusercontent.com/proxifly/free-proxy-list/main/proxies/protocols/http/data.txt",   proto: "http"   },
  { url: "https://raw.githubusercontent.com/proxifly/free-proxy-list/main/proxies/protocols/socks5/data.txt", proto: "socks5" },
  { url: "https://raw.githubusercontent.com/proxifly/free-proxy-list/main/proxies/protocols/socks4/data.txt", proto: "socks4" },

  // GitHub ErcinDedeoglu
  { url: "https://raw.githubusercontent.com/ErcinDedeoglu/proxies/main/proxies/http.txt",   proto: "http"   },
  { url: "https://raw.githubusercontent.com/ErcinDedeoglu/proxies/main/proxies/socks5.txt", proto: "socks5" },

  // GitHub casals
  { url: "https://raw.githubusercontent.com/casals-ar/proxy-list/main/http",   proto: "http"   },
  { url: "https://raw.githubusercontent.com/casals-ar/proxy-list/main/socks5", proto: "socks5" },
  { url: "https://raw.githubusercontent.com/casals-ar/proxy-list/main/socks4", proto: "socks4" },

  // geonode API — large list
  { url: "https://proxylist.geonode.com/api/proxy-list?limit=500&page=1&sort_by=lastChecked&sort_type=desc&protocols=http", proto: "http"   },
  { url: "https://proxylist.geonode.com/api/proxy-list?limit=500&page=1&sort_by=lastChecked&sort_type=desc&protocols=socks5", proto: "socks5" },
];

// ─── Parser ───────────────────────────────────────────────────────────────────

function parseIpPort(text, proto) {
  const out = [];
  for (const line of text.split(/\r?\n/)) {
    const m = line.trim().match(/^(?:\w+:\/\/)?(\d{1,3}(?:\.\d{1,3}){3}):(\d{2,5})$/);
    if (m) out.push({ host: m[1], port: parseInt(m[2]), proto, failures: 0, cooldownUntil: 0, score: 0 });
  }
  return out;
}

// Load proxies from local files (Solution 1: avoid network timeouts)
function loadProxiesFromLocalFiles() {
  const LOCAL_LISTS_DIR = '/app/data/proxy-lists';
  try {
    const files = readdirSync(LOCAL_LISTS_DIR);
    const proxies = [];

    for (const file of files) {
      if (!file.endsWith('.txt')) continue;

      try {
        const content = readFileSync(join(LOCAL_LISTS_DIR, file), 'utf8');
        const proto = file.includes('socks5') ? 'socks5' :
                     file.includes('socks4') ? 'socks4' : 'http';

        const fileProxies = parseIpPort(content, proto);
        proxies.push(...fileProxies);
        console.log(`  ✅ ${file} → ${fileProxies.length} proxies`);
        sourceStats.succeeded++;
      } catch (err) {
        console.warn(`  ⚠️  ${file} failed: ${err.message}`);
        sourceStats.failed++;
      }
    }

    console.log(`📦 Local files: ${proxies.length} proxies from ${files.length} files`);
    return proxies;
  } catch (err) {
    console.error(`❌ Failed to load local proxy files: ${err.message}`);
    return [];
  }
}

async function fetchText(url) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });  // 15s timeout (balance speed/reliability)
    if (!res.ok) {
      const error = `HTTP ${res.status} ${res.statusText}`;
      sourceStats.failed++;
      sourceStats.failedUrls.push({ url, error, ts: Date.now() });
      console.warn(`⚠️  Proxy source failed: ${url} - ${error}`);
      return { success: false, text: "", error };
    }
    const text = await res.text();
    sourceStats.succeeded++;
    return { success: true, text, error: null };
  } catch (err) {
    const error = err.message || String(err);
    sourceStats.failed++;
    sourceStats.failedUrls.push({ url, error, ts: Date.now() });
    console.warn(`⚠️  Proxy source failed: ${url} - ${error}`);
    return { success: false, text: "", error };
  }
}

// ─── Tunnel HTTP CONNECT ──────────────────────────────────────────────────────

function httpGetViaHttpProxy(proxy, targetHost, targetPort, path, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timeout")), timeoutMs);
    const req = http.request({
      host: proxy.host, port: proxy.port, method: "CONNECT",
      path: `${targetHost}:${targetPort}`,
      headers: { Host: `${targetHost}:${targetPort}` },
    });
    req.on("error", (e) => { clearTimeout(timer); reject(e); });
    req.on("connect", (res, socket) => {
      if (res.statusCode !== 200) { socket.destroy(); clearTimeout(timer); return reject(new Error(`CONNECT ${res.statusCode}`)); }
      const tlsReq = https.request({
        host: targetHost, port: targetPort, path, method: "GET",
        headers: { Host: targetHost, "User-Agent": "curl/7.88" },
        socket, agent: false, rejectUnauthorized: false,
      });
      tlsReq.on("error", (e) => { clearTimeout(timer); socket.destroy(); reject(e); });
      tlsReq.on("response", (r) => { clearTimeout(timer); socket.destroy(); resolve(r.statusCode === 200); });
      tlsReq.end();
    });
    req.end();
  });
}

function httpGetViaSocks(proxy, targetHost, targetPort, path, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timeout")), timeoutMs);
    const type  = proxy.proto === "socks4" ? 4 : 5;
    SocksClient.createConnection({
      proxy: { host: proxy.host, port: proxy.port, type },
      command: "connect",
      destination: { host: targetHost, port: targetPort },
      timeout: timeoutMs,
    }, (err, info) => {
      if (err) { clearTimeout(timer); return reject(err); }
      const socket = info.socket;
      const tlsReq = https.request({
        host: targetHost, port: targetPort, path, method: "GET",
        headers: { Host: targetHost, "User-Agent": "curl/7.88" },
        socket, agent: false, rejectUnauthorized: false,
      });
      tlsReq.on("error", (e) => { clearTimeout(timer); socket.destroy(); reject(e); });
      tlsReq.on("response", (r) => { clearTimeout(timer); socket.destroy(); resolve(r.statusCode === 200); });
      tlsReq.end();
    });
  });
}

// ─── POST via proxy (appel WOS) ───────────────────────────────────────────────

// 🚀 Cache d'agents avec KEEP-ALIVE : réutilise la connexion (tunnel proxy + TLS WOS) au lieu
// d'un nouveau handshake TLS à CHAQUE requête → CPU divisé (le scraper était CPU-bound sur le TLS).
// Clé par proxy (incl. userId pour l'isolation TOR). Borné en mémoire.
const _agentCache = new Map();
function getAgent(proxy) {
  const key = `${proxy.proto}|${proxy.host}|${proxy.port}|${proxy.userId || ""}`;
  let a = _agentCache.get(key);
  if (a) return a;
  const opts = { keepAlive: true, keepAliveMsecs: 10_000, maxSockets: 3, maxFreeSockets: 2, scheduling: "lifo" };
  if (proxy.proto === "socks5" || proxy.proto === "socks4") {
    const auth = proxy.userId ? `${encodeURIComponent(proxy.userId)}:${encodeURIComponent(proxy.password || "x")}@` : "";
    a = new SocksProxyAgent(`${proxy.proto}://${auth}${proxy.host}:${proxy.port}`, opts);
  } else {
    a = new HttpsProxyAgent(`http://${proxy.host}:${proxy.port}`, opts);
  }
  _agentCache.set(key, a);
  if (_agentCache.size > 8000) {  // borne : purger le plus ancien
    const k = _agentCache.keys().next().value;
    try { _agentCache.get(k)?.destroy?.(); } catch {}
    _agentCache.delete(k);
  }
  return a;
}

// POST via proxy avec agent KEEP-ALIVE caché. Gère aussi l'auth SOCKS (isolation circuits TOR).
export function postViaProxy(proxy, targetHost, targetPort, path, body, headers, timeoutMs) {
  return new Promise((resolve, reject) => {
    let done = false, req;
    const timer = setTimeout(() => { if (done) return; done = true; try { req?.destroy(); } catch {} reject(new Error("timeout")); }, timeoutMs);
    const finish = (fn, arg) => { if (done) return; done = true; clearTimeout(timer); fn(arg); };

    let agent;
    try { agent = getAgent(proxy); } catch (e) { return finish(reject, e); }

    req = https.request({
      host: targetHost, port: targetPort, path, method: "POST",
      headers: { ...headers, "Content-Length": Buffer.byteLength(body) },
      agent, rejectUnauthorized: false,
    }, (res) => {
      let data = "";
      res.on("data", (c) => { data += c; });
      res.on("end", () => finish(resolve, { status: res.statusCode, body: data }));
    });
    req.on("error", (e) => finish(reject, e));
    req.write(body);
    req.end();
  });
}

// ─── Test d'un proxy : POST RÉEL contre WOS (headers complets + signature) ────
// ⚠️ BUG HISTORIQUE CORRIGÉ : l'ancien testProxy faisait un GET avec le seul header
// "User-Agent: curl/7.88" → WOS répondait 403 → TOUS les bons proxies étaient rejetés
// (d'où le faux "2% vivants"). On valide désormais EXACTEMENT comme en prod (POST + headers
// WOS + signature MD5) → un proxy "vivant" l'est réellement pour le scraping.
const WOS_HASH      = "tB87#kPtkxqOS2";
const WOS_TEST_PATH = "/api/player";
const TEST_UA = [
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15",
];
function wosTestHeaders() {
  return {
    "User-Agent":   TEST_UA[Math.random() * TEST_UA.length | 0],
    "Accept":       "application/json, text/plain, */*",
    "Origin":       "https://wos-giftcode.centurygame.com",
    "Referer":      "https://wos-giftcode.centurygame.com/",
    "Content-Type": "application/x-www-form-urlencoded",
  };
}
function wosTestBody(fid) {
  const time = Date.now();
  const sign = crypto.createHash("md5").update(`fid=${fid}&time=${time}${WOS_HASH}`).digest("hex");
  return new URLSearchParams({ sign, fid: String(fid), time: String(time) }).toString();
}

async function testProxy(proxy) {
  try {
    const res = await postViaProxy(proxy, TEST_HOST, 443, WOS_TEST_PATH, wosTestBody(701), wosTestHeaders(), TEST_TIMEOUT);
    return res.status === 200;  // WOS répond OK via ce proxy → réellement utilisable
  } catch { return false; }
}

// ─── 3 pools séparées ─────────────────────────────────────────────────────────
//
//  alive    — proxies disponibles maintenant
//  cooldown — proxies en pause temporaire (rate-limit ou échec récent)
//  dead     — proxies ayant échoué MAX_FAILURES fois → retestés après DEAD_RETRY_MS
//
const DEAD_RETRY_MS = 10 * 60 * 1000; // retester les morts après 10min

const alive    = [];  // { host, port, proto, failures, score, cooldownUntil }
const cooldown = [];  // { proxy, until }  — proxy = ref dans alive ou objet
const dead     = [];  // { proxy, retryAt }

// 🚀 Index Map pour O(1) lookup au lieu de O(n) indexOf()
const aliveIndex = new Map();  // proxy → index dans alive[]

let lastFetch = 0;
let fetching  = false;

// 💾 Charger le pool persisté (accumulation entre redémarrages). Les proxies sauvés étaient
// vivants récemment → on les remet dans alive directement (cadence/échecs les régulent ensuite).
function loadPool() {
  try {
    if (!existsSync(POOL_FILE)) return;
    const saved = JSON.parse(readFileSync(POOL_FILE, "utf8"));
    const seen = new Set();
    for (const p of saved) {
      const key = `${p.host}:${p.port}`;
      if (seen.has(key)) continue; seen.add(key);
      alive.push({ host: p.host, port: p.port, proto: p.proto, failures: 0, nextFreeAt: 0,
        successes: p.successes || 0, totalRequests: p.totalRequests || 0,
        avgLatency: p.avgLatency || 0, qualityScore: p.qualityScore || 0 });
    }
    console.log(`💾 Pool rechargé depuis ${POOL_FILE} : ${alive.length} proxies (accumulation)`);
  } catch (e) { console.warn(`⚠️ loadPool: ${e.message}`); }
}

// Sauver le pool vivant (union accumulée). On garde les proxies prouvés (successes>0) + récents.
function savePool() {
  try {
    const keep = alive
      .filter(p => !p.isTor && (p.successes > 0 || (p.failures || 0) < 3))
      .map(p => ({ host: p.host, port: p.port, proto: p.proto, successes: p.successes || 0,
        totalRequests: p.totalRequests || 0, avgLatency: p.avgLatency || 0, qualityScore: p.qualityScore || 0 }))
      .slice(0, 20000);  // borne de sécurité
    writeFileSync(POOL_FILE, JSON.stringify(keep));
  } catch (e) { console.warn(`⚠️ savePool: ${e.message}`); }
}

// Déplacer les cooldowns expirés vers alive, les morts prêts à retester vers alive
function promoteCooldowns() {
  const now = Date.now();
  // cooldown → alive
  for (let i = cooldown.length - 1; i >= 0; i--) {
    if (cooldown[i].until <= now) {
      alive.push(cooldown[i].proxy);
      cooldown.splice(i, 1);
    }
  }
  // dead → alive si retryAt atteint
  for (let i = dead.length - 1; i >= 0; i--) {
    if (dead[i].retryAt <= now) {
      dead[i].proxy.failures = 0; // reset pour lui donner une chance
      alive.push(dead[i].proxy);
      dead.splice(i, 1);
    }
  }
}

// Process continu de gestion des proxies — tourne en arrière-plan
async function proxyManager() {
  // TOR pur : aucun pool public à gérer (pas de cooldown, pas de refresh)
  if (TOR_ENABLED && !TOR_HYBRID) return;
  while (true) {
    promoteCooldowns();

    // Si trop peu de proxies vivants, relancer un fetch
    if (alive.length < MIN_POOL_SIZE && !fetching) {
      refreshPool();
    }

    await new Promise(r => setTimeout(r, 1_000));
  }
}

export async function refreshPool() {
  // Solution 3: Pure Tor mode - no refresh needed
  if (TOR_ENABLED && !TOR_HYBRID) {
    console.log(`🔄 Tor pool : ${TOR_PORTS.length} ports SOCKS5 disponibles (127.0.0.01:${TOR_PORTS[0]}-${TOR_PORTS[TOR_PORTS.length-1]})`);
    return;
  }

  if (fetching) return;  // Silent return si déjà en cours
  fetching = true;
  console.log(`🔄 Proxy pool : refresh démarré...`);

  const mode = TOR_HYBRID ? "HYBRID (public + Tor fallback)" : "public proxies";
  console.log(`🔄 Proxy pool : chargement ${mode} depuis fichiers locaux...`);

  // HYBRID: Preserve existing Tor proxies during refresh
  const savedTorProxies = TOR_HYBRID ? alive.filter(p => p.isTor) : [];
  if (savedTorProxies.length > 0) {
    console.log(`🔒 HYBRID: Preserving ${savedTorProxies.length} Tor proxies during refresh`);
  }

  // Reset source stats for this refresh
  sourceStats.attempted = SOURCES.length;
  sourceStats.succeeded = 0;
  sourceStats.failed = 0;
  sourceStats.failedUrls = [];
  sourceStats.lastRefresh = Date.now();

  // Charger depuis les SOURCES réseau (listes publiques) — fetch PARALLÈLE.
  // (Les fichiers locaux /app/data/proxy-lists sont vides en prod → on scrape le réseau.)
  try {
    // Race timeout DUR par source : l'AbortSignal de fetch ne coupe pas toujours un
    // connect TCP qui hang → sans ce race, Promise.all reste bloqué indéfiniment.
    const withTimeout = (p, ms) => Promise.race([p, new Promise(r => setTimeout(() => r([]), ms))]);
    // On ne fetch QUE les meilleures sources (ProxyScrape filtré <2s + listes VÉRIFIÉES + TheSpeedX) :
    // proxies RAPIDES uniquement → pool dominé par les bons, pas noyé dans 55 sources lentes.
    const fetched = await Promise.all(SOURCES.slice(0, 15).map(src =>
      withTimeout(
        fetchText(src.url).then(({ success, text }) => success ? parseIpPort(text, src.proto) : []),
        18_000
      )
    ));
    let all = fetched.flat();
    all.push(...loadProxiesFromLocalFiles());  // + fichiers locaux éventuels (souvent vide)
    console.log(`📊 Sources: ${sourceStats.succeeded}/${SOURCES.length} OK → ${all.length} proxies bruts`);

    // Dédupliquer (ne pas re-tester ce qui est déjà connu vivant/cooldown/mort)
    const seen = new Set([...alive, ...cooldown.map(c=>c.proxy), ...dead.map(d=>d.proxy)].map(p => `${p.host}:${p.port}`));
    const fresh = [];
    for (const p of all) {
      const key = `${p.host}:${p.port}`;
      if (!seen.has(key)) { seen.add(key); fresh.push(p); }
    }
    console.log(`🔄 ${fresh.length} nouveaux proxies à tester (batch ${MAX_TEST_BATCH}, timeout ${TEST_TIMEOUT}ms)...`);

    // Tester par batch ; injecter dans alive au fur et à mesure. Log \n VISIBLE par batch.
    let added = 0, tested = 0;
    for (let i = 0; i < fresh.length; i += MAX_TEST_BATCH) {
      const batch   = fresh.slice(i, i + MAX_TEST_BATCH);
      const results = await Promise.all(batch.map(async p => ({ p, ok: await testProxy(p) })));
      let batchOk = 0;
      for (const { p, ok } of results) {
        if (ok) { p.failures = 0; p.score = 1; alive.push(p); added++; batchOk++; }
      }
      tested += batch.length;
      console.log(`  🧪 batch testé ${tested}/${fresh.length} — +${batchOk} vivants (cumul ${added}, pool alive=${alive.length})`);
      if (alive.length >= 4000) { console.log(`  ⏭️  pool large (${alive.length}) → test interrompu, le reste au prochain refresh`); break; }
    }

    lastFetch = Date.now();
    const byProto = alive.reduce((a, p) => { a[p.proto] = (a[p.proto] || 0) + 1; return a; }, {});
    console.log(`✅ Proxy pool : ${alive.length} vivants | ${cooldown.length} cooldown | ${dead.length} morts — ${JSON.stringify(byProto)}`);
    savePool();  // 💾 persister l'union accumulée
  } catch (err) {
    console.error(`❌ refreshPool erreur: ${err.message}`);
  } finally {
    fetching = false;   // 🔒 GARDE-FOU : ne JAMAIS rester bloqué en fetching=true
  }
}

// HYBRID: Injecter Tor AVANT de démarrer proxyManager pour éviter la boucle refresh
if (TOR_HYBRID && !TOR_ENABLED) {
  injectTorProxies();
}

// Démarrer le manager en arrière-plan
proxyManager();

// ─── API publique ─────────────────────────────────────────────────────────────

// TOR pur : round-robin sur les ports + ISOLATION par worker via SOCKS auth.
// userId unique (par worker) → TOR construit un circuit distinct par userId
// (stream-isolation IsolateSOCKSAuth), donc des IP de sortie indépendantes.
function getTorProxy(wid = 0) {
  const port = TOR_PORTS[torRoundRobin % TOR_PORTS.length];
  torRoundRobin++;
  const TOR_HOST = process.env.TOR_HOST || '172.18.0.1';  // Docker gateway IP
  return {
    idx: torRoundRobin,
    proxy: {
      host: TOR_HOST,
      port: port,
      proto: 'socks5',
      isTor: true,
      // Isolation par PORT, circuit STABLE (userId fixe). Config retenue après mesures :
      // meilleur débit/stabilité. Rotation (synchro ou désync) testée = pire (creux/0).
      userId: `p${port}`,
      password: 'wpds'
    }
  };
}

// HYBRID: Inject Tor proxies into alive pool when public pool is low
function injectTorProxies() {
  if (torProxiesInjected) return;

  console.log(`🔄 HYBRID: Injecting ${TOR_PORTS.length} Tor proxies into pool...`);

  const TOR_HOST = process.env.TOR_HOST || '172.18.0.1';  // Docker gateway IP
  for (const port of TOR_PORTS) {
    alive.push({
      host: TOR_HOST,
      port: port,
      proto: 'socks5',
      isTor: true,
      failures: 0,
      score: 100,  // TRÈS haute priorité pour ne JAMAIS être éliminé du pool
      qualityScore: 100  // Toujours dans le top 200
    });
  }

  torProxiesInjected = true;
  console.log(`✅ HYBRID: Pool now has ${alive.length} proxies (${TOR_PORTS.length} Tor + ${alive.length - TOR_PORTS.length} public)`);
}

// Tirer un proxy public au hasard dans tout le pool vivant.
// Random pur (pas de top-N) = diversité d'IP MAXIMALE → minimise le rate-limit WOS
// par IP. Les morts/lents sont retirés par reportFailure (timeout 10s) → auto-régulation.
function pickPublic() {
  if (alive.length === 0) return null;
  const now = Date.now();
  // Cherche un proxy FRAIS (cadence respectée) parmi quelques tirages, en gardant le meilleur
  // qualityScore (tournoi). Si aucun frais trouvé → null (le worker bascule sur TOR fallback).
  let best = null, bestIdx = -1;
  const tries = Math.min(8, alive.length);
  for (let k = 0; k < tries; k++) {
    const i = Math.floor(Math.random() * alive.length);
    const p = alive[i];
    if (!p || (p.nextFreeAt || 0) > now) continue;          // pas encore "frais" → on saute
    if (!best || (p.qualityScore || 0) > (best.qualityScore || 0)) { best = p; bestIdx = i; }
  }
  if (!best) return null;
  best.nextFreeAt = now + PROXY_CADENCE_MS;                  // réserve l'IP pour PROXY_CADENCE_MS
  return { proxy: best, idx: bestIdx };
}

export function getProxy(wid = 0) {
  // ─── HYBRIDE : proxy public PRIORITAIRE, TOR en fallback ───
  if (TOR_HYBRID) {
    promoteCooldowns();
    const slot = pickPublic();
    if (slot) return slot;          // proxy public dispo → on l'utilise
    return getTorProxy(wid);        // pool public vide → fallback TOR (toujours dispo, circuit isolé)
  }

  // ─── TOR pur ───
  if (TOR_ENABLED) return getTorProxy(wid);

  // ─── Proxy pur ───
  promoteCooldowns();
  return pickPublic();              // null si pool vide → probeId loggera l'ID (couverture garantie)
}

// Helper : un slot TOR (fallback) ne se track pas ; en TOR pur non plus.
function skipTracking(slot) {
  if (slot?.proxy?.isTor) return true;        // circuit TOR jetable
  if (TOR_ENABLED && !TOR_HYBRID) return true; // TOR pur
  return false;
}

export function reportFailure(slot) {
  if (skipTracking(slot)) return;
  const idx = slot?.idx ?? slot;
  if (idx == null || idx < 0 || idx >= alive.length) return;
  const p = alive[idx];
  if (!p) return;  // 🛡️ race condition (splice concurrent)
  p.failures = (p.failures || 0) + 1;
  // 🆕 MISE AU COIN PROGRESSIVE : les 2 premiers échecs → courte pause (3s, reste en rotation,
  // un proxy lent ponctuel n'est pas écarté) ; récidiviste (3+ échecs) → 60s (vraie pénalité).
  // → garde le pool fourni tout en concentrant les picks sur les proxies fiables.
  p.nextFreeAt = Date.now() + (p.failures >= 3 ? 60_000 : PROXY_CADENCE_MS * 2);
  // RÉTENTION : on garde le proxy dans le pool (reportSuccess remet failures=0). Sorti seulement
  // après MAX_FAILURES échecs cumulés sans succès → vraiment mort.
  if (p.failures >= MAX_FAILURES) {
    alive.splice(idx, 1);
    dead.push({ proxy: p, retryAt: Date.now() + DEAD_RETRY_MS });
  }
}

export function reportRateLimit(slot) {
  if (skipTracking(slot)) return;
  const idx = slot?.idx ?? slot;
  if (idx == null || idx < 0 || idx >= alive.length) return;
  const p = alive[idx];
  if (!p) return;
  alive.splice(idx, 1);
  // Cooldown 60s sans incrémenter failures — WOS rate-limit l'IP, pas un proxy mort
  cooldown.push({ proxy: p, until: Date.now() + 60_000, reason: "rate_limit" });
}

export function reportSuccess(slot, latency = 0) {
  if (skipTracking(slot)) return;
  const idx = slot?.idx ?? slot;
  if (idx == null || idx < 0 || idx >= alive.length) return;
  const p = alive[idx];
  if (!p) return;
  p.failures      = 0;
  p.totalRequests = (p.totalRequests || 0) + 1;
  p.successes     = (p.successes || 0) + 1;
  p.totalLatency  = (p.totalLatency || 0) + latency;
  p.avgLatency    = p.totalLatency / p.totalRequests;
  p.successRate   = p.successes / p.totalRequests;
  p.qualityScore  = (p.successRate * 1000) / (p.avgLatency + 100);
}

export function removeProxy(slot) { reportFailure(slot); }

export function poolStats() {
  // Solution 3: Pure Tor pool stats
  if (TOR_ENABLED && !TOR_HYBRID) {
    return {
      total: TOR_PORTS.length,
      alive: TOR_PORTS.length,
      cooldown: 0,
      dead: 0,
      byProto: { socks5: TOR_PORTS.length },
      lastFetch: Date.now(),
      sourceStats: {
        attempted: 1,
        succeeded: 1,
        failed: 0,
        successRate: "100.0",
        lastRefresh: Date.now(),
        recentFailures: [],
      },
      proxyHealth: {
        cooldownReasons: {},
        avgFailures: 0,
        qualityDistribution: { excellent: TOR_PORTS.length, good: 0, fair: 0, poor: 0 },
      }
    };
  }

  const total   = alive.length + cooldown.length + dead.length;
  const byProto = alive.reduce((a, p) => { a[p.proto] = (a[p.proto] || 0) + 1; return a; }, {});

  // HYBRID: Count Tor vs public proxies
  let torCount = 0;
  let publicCount = 0;
  if (TOR_HYBRID) {
    torCount = alive.filter(p => p.isTor).length;
    publicCount = alive.length - torCount;
  }

  // Calculate cooldown reasons breakdown
  const cooldownReasons = cooldown.reduce((acc, c) => {
    const reason = c.reason || "unknown";
    acc[reason] = (acc[reason] || 0) + 1;
    return acc;
  }, {});

  // Calculate average failures across all proxies
  const allProxies = [...alive, ...cooldown.map(c => c.proxy), ...dead.map(d => d.proxy)];
  const totalFailures = allProxies.reduce((sum, p) => sum + (p.failures || 0), 0);
  const avgFailures = allProxies.length > 0 ? (totalFailures / allProxies.length).toFixed(2) : 0;

  // Calculate quality score distribution for alive proxies
  const scoreRanges = { excellent: 0, good: 0, fair: 0, poor: 0 };
  alive.forEach(p => {
    const score = p.score || 0;
    if (score > 5) scoreRanges.excellent++;
    else if (score > 2) scoreRanges.good++;
    else if (score > 1) scoreRanges.fair++;
    else scoreRanges.poor++;
  });

  const torFallback = TOR_HYBRID ? TOR_PORTS.length : 0;
  return {
    // En hybride, total inclut le fallback TOR → poolStats().total n'est JAMAIS 0,
    // donc les workers n'attendent pas pendant que le pool public se remplit.
    total: alive.length + torFallback,
    alive: alive.length + torFallback,
    alivePublic: alive.length,
    torFallback,
    cooldown: cooldown.length,
    dead: dead.length,
    byProto,
    lastFetch,
    // Option A: Source statistics
    sourceStats: {
      attempted: sourceStats.attempted,
      succeeded: sourceStats.succeeded,
      failed: sourceStats.failed,
      successRate: sourceStats.attempted > 0 ? ((sourceStats.succeeded / sourceStats.attempted) * 100).toFixed(1) : 0,
      lastRefresh: sourceStats.lastRefresh,
      recentFailures: sourceStats.failedUrls.slice(-10), // Last 10 failed sources
    },
    // Option A: Proxy health metrics
    proxyHealth: {
      cooldownReasons,           // Breakdown: rate_limit vs failure
      avgFailures,               // Average failures per proxy
      qualityDistribution: scoreRanges, // Score ranges for alive proxies
    }
  };
}

export function needsRefresh() {
  if (TOR_ENABLED && !TOR_HYBRID) return false;  // TOR pur : jamais de refresh
  return alive.length < MIN_POOL_SIZE || Date.now() - lastFetch > REFRESH_INTERVAL;
}

// ─── Démarrage ────────────────────────────────────────────────────────────────

if (!(TOR_ENABLED && !TOR_HYBRID)) loadPool();  // 💾 recharger le pool accumulé (hybride/proxy)
refreshPool();
// Refresh périodique du pool public, SAUF en TOR pur (pool public désactivé).
// En hybride/proxy : re-scrape les sources toutes les REFRESH_INTERVAL pour garder le pool frais.
if (!(TOR_ENABLED && !TOR_HYBRID)) {
  setInterval(refreshPool, REFRESH_INTERVAL);
  setInterval(savePool, 60_000);  // 💾 sauvegarde périodique du pool (accumulation continue)
}
