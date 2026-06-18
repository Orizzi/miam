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
import { SocksClient } from "socks";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

// ─── Solution 3: HYBRID mode - Tor + Public proxies together ─────────────────
const TOR_ENABLED      = true;            // ✅ TOR PUR : getProxy → getTorProxy (round-robin O(1)), pas de pool public
const TOR_HYBRID       = false;           // Plus de proxies publics (hunter/refresh/test désactivés)
const TOR_PORT_START   = parseInt(process.env.TOR_PORT_START || '9050');
const TOR_PORT_END     = parseInt(process.env.TOR_PORT_END || '9149');
const TOR_PORTS        = Array.from({length: TOR_PORT_END - TOR_PORT_START + 1}, (_, i) => TOR_PORT_START + i);
let torRoundRobin      = 0;
let torProxiesInjected = false;
const torPortCnt       = {};   // compteur d'usages par port (pour rotation désynchronisée des circuits)

const REFRESH_INTERVAL = 5 * 60 * 1000;   // 5min (×4 refresh pour pool toujours frais)
const TEST_TIMEOUT     = 10_000;          // 10s (accepter proxies lents mais fonctionnels WOS)
const TEST_HOST        = "wos-giftcode-api.centurygame.com";   // Option B: Test contre WOS réel
const TEST_PATH        = "/api/player?fid=701&_uid=1";
const MAX_TEST_BATCH   = 1500;            // 1500 tests en parallèle (~1.5Kpps < 16Kpps limite OVH)
const MIN_POOL_SIZE    = 20;
const MAX_FAILURES     = 6;               // 6 échecs avant retrait (plus tolérant)
const COOLDOWN_MS      = 10_000;          // 10s de cooldown

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
  // ProxyScrape — DÉSACTIVÉ temporairement (cause timeouts)
  // { url: "https://api.proxyscrape.com/v4/free-proxy-list/get?request=display_proxies&protocol=http&timeout=5000&country=all&ssl=all&anonymity=all&simplified=true", proto: "http" },
  // { url: "https://api.proxyscrape.com/v4/free-proxy-list/get?request=display_proxies&protocol=socks5&timeout=5000&country=all&simplified=true", proto: "socks5" },
  // { url: "https://api.proxyscrape.com/v4/free-proxy-list/get?request=display_proxies&protocol=socks4&timeout=5000&country=all&simplified=true", proto: "socks4" },

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

export function postViaProxy(proxy, targetHost, targetPort, path, body, headers, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timeout")), timeoutMs);

    const doRequest = (socket) => {
      const req = https.request({
        host: targetHost, port: targetPort, path, method: "POST",
        headers: { ...headers, "Content-Length": Buffer.byteLength(body) },
        socket, agent: false, rejectUnauthorized: false,
      });
      req.on("error", (e) => { clearTimeout(timer); if (socket) socket.destroy(); reject(e); });
      req.on("response", (res) => {
        let data = "";
        res.on("data", (c) => { data += c; });
        res.on("end", () => { clearTimeout(timer); if (socket) socket.destroy(); resolve({ status: res.statusCode, body: data }); });
      });
      req.write(body);
      req.end();
    };

    if (proxy.proto === "socks5" || proxy.proto === "socks4") {
      const type = proxy.proto === "socks4" ? 4 : 5;
      const socksProxy = { host: proxy.host, port: proxy.port, type };
      // Stream-isolation TOR : userId/password → circuit dédié
      if (proxy.userId) { socksProxy.userId = proxy.userId; socksProxy.password = proxy.password || "x"; }
      SocksClient.createConnection({
        proxy: socksProxy,
        command: "connect",
        destination: { host: targetHost, port: targetPort },
        timeout: timeoutMs,
      }, (err, info) => {
        if (err) { clearTimeout(timer); return reject(err); }
        doRequest(info.socket);
      });
    } else {
      const tunnel = http.request({
        host: proxy.host, port: proxy.port, method: "CONNECT",
        path: `${targetHost}:${targetPort}`,
        headers: { Host: `${targetHost}:${targetPort}` },
      });
      tunnel.on("error", (e) => { clearTimeout(timer); reject(e); });
      tunnel.on("connect", (res, socket) => {
        if (res.statusCode !== 200) { socket.destroy(); clearTimeout(timer); return reject(new Error(`CONNECT ${res.statusCode}`)); }
        doRequest(socket);
      });
      tunnel.end();
    }
  });
}

// ─── Test d'un proxy ─────────────────────────────────────────────────────────

async function testProxy(proxy) {
  try {
    const ok = (proxy.proto === "socks5" || proxy.proto === "socks4")
      ? await httpGetViaSocks(proxy, TEST_HOST, 443, TEST_PATH, TEST_TIMEOUT)
      : await httpGetViaHttpProxy(proxy, TEST_HOST, 443, TEST_PATH, TEST_TIMEOUT);
    return ok;
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
  sourceStats.attempted = 10; // 10 fichiers locaux
  sourceStats.succeeded = 0;
  sourceStats.failed = 0;
  sourceStats.failedUrls = [];
  sourceStats.lastRefresh = Date.now();

  // SOLUTION 1: Load from local files (no network timeouts!)
  let all = loadProxiesFromLocalFiles();

  console.log(`📊 Source stats: ${sourceStats.succeeded}/${sourceStats.attempted} fichiers OK (${((sourceStats.succeeded/sourceStats.attempted)*100).toFixed(1)}%)`);

  // 🚀 BOOST MAXIMUM: Proxy Hunter RÉACTIVÉ (toutes sources)
  try {
    const { huntAll } = await import('./proxy-hunter.mjs');
    const hunted = await huntAll();
    all.push(...hunted);
    console.log(`🔎 Proxy Hunter ajouté ${hunted.length} proxies additionnels`);
  } catch (err) {
    console.error('⚠️  Proxy Hunter error:', err.message);
  }
  console.log(`🚀 BOOST: Proxy Hunter activé - recherche maximale de proxies`);

  // Dédupliquer — réutiliser les proxies déjà connus
  const existing = new Map([...alive, ...cooldown.map(c=>c.proxy), ...dead.map(d=>d.proxy)].map(p => [`${p.host}:${p.port}`, p]));
  const seen  = new Set([...alive, ...cooldown.map(c=>c.proxy), ...dead.map(d=>d.proxy)].map(p => `${p.host}:${p.port}`));
  const fresh = [];
  for (const p of all) {
    const key = `${p.host}:${p.port}`;
    if (!seen.has(key)) { seen.add(key); fresh.push(p); }
  }

  console.log(`🔄 ${fresh.length} nouveaux proxies à tester (batch ${MAX_TEST_BATCH}, timeout ${TEST_TIMEOUT}ms)...`);

  // Tester les nouveaux proxies et les injecter dans alive au fur et à mesure
  let added = 0;
  for (let i = 0; i < fresh.length; i += MAX_TEST_BATCH) {
    const batch   = fresh.slice(i, i + MAX_TEST_BATCH);
    const results = await Promise.all(batch.map(async p => ({ p, ok: await testProxy(p) })));
    for (const { p, ok } of results) {
      if (ok) { p.failures = 0; p.score = 1; alive.push(p); added++; }
    }
    const done = Math.min(i + MAX_TEST_BATCH, fresh.length);
    process.stdout.write(`\r  testé ${done}/${fresh.length} — nouveaux vivants: ${added}   `);
  }
  process.stdout.write("\n");

  // HYBRID: Restore Tor proxies after refresh
  if (savedTorProxies.length > 0) {
    alive.push(...savedTorProxies);
    console.log(`✅ HYBRID: Restored ${savedTorProxies.length} Tor proxies to pool`);
  }

  lastFetch = Date.now();
  fetching  = false;

  const byProto = alive.reduce((a, p) => { a[p.proto] = (a[p.proto] || 0) + 1; return a; }, {});
  console.log(`✅ Proxy pool : ${alive.length} vivants | ${cooldown.length} en cooldown | ${dead.length} morts — ${JSON.stringify(byProto)}`);
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

export function getProxy(wid = 0) {
  // TOR pur : circuit isolé par worker (wid)
  if (TOR_ENABLED) {
    return getTorProxy(wid);
  }

  promoteCooldowns();

  // HYBRID: ALWAYS ensure Tor proxies are in pool (inject once at startup)
  if (TOR_HYBRID && !torProxiesInjected) {
    injectTorProxies();
  }

  if (alive.length === 0) return null;

  // 🎯 Ranking par qualité : trier et garder top 200 (revenir à TEST #2)
  // HYBRID: NEVER remove Tor proxies from pool
  if (alive.length > 200) {
    alive.sort((a, b) => (b.qualityScore || 0) - (a.qualityScore || 0));

    // In HYBRID mode, preserve all Tor proxies + top public proxies
    if (TOR_HYBRID) {
      const torProxies = alive.filter(p => p.isTor);
      const publicProxies = alive.filter(p => !p.isTor);
      const keepPublic = Math.max(0, 200 - torProxies.length);
      const pruned = publicProxies.length - keepPublic;
      // 🔧 FIX: alive est const (pool global) → mutation in-place, PAS de réassignation
      alive.length = 0;
      alive.push(...torProxies, ...publicProxies.slice(0, keepPublic));
      if (pruned > 0) {
        console.log(`🧹 [proxy] Éliminé ${pruned} proxies publics lents (gardé ${torProxies.length} Tor + ${keepPublic} publics)`);
      }
    } else {
      const toRemove = alive.splice(200);
      console.log(`🧹 [proxy] Éliminé ${toRemove.length} proxies lents (gardé top 200 par qualité)`);
    }
  }

  // Prendre un proxy random dans le top 80% (favorise les meilleurs)
  const topN  = Math.max(1, Math.ceil(alive.length * 0.8));
  const idx   = Math.floor(Math.random() * topN);
  const proxy = alive[idx];
  return { proxy, idx };
}

export function reportFailure(slot) {
  // Solution 3: Tor proxies don't fail (infinite pool)
  if (TOR_ENABLED) return;

  const idx = slot?.idx ?? slot;  // Support both old (idx) and new (slot) API
  if (idx < 0 || idx >= alive.length) return;
  const p = alive[idx];
  if (!p) return;  // 🛡️ Protection contre race condition

  // HYBRID: Don't remove Tor proxies from pool (they're infinite)
  if (TOR_HYBRID && p.isTor) {
    // Just reset to end of queue, don't remove
    alive.splice(idx, 1);
    alive.push(p);
    return;
  }

  p.failures = (p.failures || 0) + 1;
  alive.splice(idx, 1);
  if (p.failures >= MAX_FAILURES) {
    // → pool morte : retest après 10min
    dead.push({ proxy: p, retryAt: Date.now() + DEAD_RETRY_MS });
  } else {
    // → cooldown temporaire
    cooldown.push({ proxy: p, until: Date.now() + COOLDOWN_MS * p.failures, reason: "failure" });
  }
}

export function reportRateLimit(slot) {
  // Solution 3: Tor proxies don't need cooldown (just rotate to next port)
  if (TOR_ENABLED) return;

  const idx = slot?.idx ?? slot;  // Support both old (idx) and new (slot) API
  if (idx < 0 || idx >= alive.length) return;
  const p = alive[idx];
  if (!p) return;  // 🛡️ Protection contre race condition

  // HYBRID: Tor proxies rotate automatically, don't cooldown
  if (TOR_HYBRID && p.isTor) {
    alive.splice(idx, 1);
    alive.push(p);  // Move to end of queue
    return;
  }

  alive.splice(idx, 1);
  // Cooldown 60s sans incrémenter failures — WOS rate-limit, laisser plus de temps
  cooldown.push({ proxy: p, until: Date.now() + 60_000, reason: "rate_limit" });
}

export function reportSuccess(idx, latency = 0) {
  // Solution 3: Tor proxies don't need tracking (always available)
  if (TOR_ENABLED) return;

  if (idx < 0 || idx >= alive.length) return;
  const p = alive[idx];
  if (!p) return;  // 🛡️ Protection contre race condition
  p.failures = 0;

  // 🎯 Tracking qualité proxy
  p.totalRequests = (p.totalRequests || 0) + 1;
  p.successes     = (p.successes || 0) + 1;
  p.totalLatency  = (p.totalLatency || 0) + latency;
  p.avgLatency    = p.totalLatency / p.totalRequests;
  p.successRate   = p.successes / p.totalRequests;
  // Score = taux succès / latence (plus haut = meilleur)
  p.qualityScore  = (p.successRate * 1000) / (p.avgLatency + 100);
}

export function removeProxy(idx) { reportFailure(idx); }

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

  return {
    total: alive.length,
    alive: alive.length,
    cooldown: cooldown.length,
    dead: dead.length,
    byProto,
    lastFetch,
    // HYBRID: Tor vs public proxy breakdown
    ...(TOR_HYBRID && { torCount, publicCount }),
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
  // Solution 3: Tor never needs refresh
  if (TOR_ENABLED) return false;
  return alive.length < MIN_POOL_SIZE || Date.now() - lastFetch > REFRESH_INTERVAL;
}

// ─── Démarrage ────────────────────────────────────────────────────────────────

refreshPool();
// TOR pur : pas de refresh périodique (le pool public est désactivé)
if (!TOR_ENABLED) setInterval(refreshPool, REFRESH_INTERVAL);
