/**
 * proxy-hunter.mjs — Scraper automatique de proxies depuis GitHub, Pastebin, Gists, etc.
 */

import https from 'https';
import http from 'http';

const GITHUB_TOKEN = process.env.GITHUB_TOKEN || null; // Optionnel, augmente rate limit

/**
 * Fetch simple via https/http
 */
async function fetchUrl(url, timeout = 5000) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https') ? https : http;
    const req = lib.get(url, { timeout, headers: { 'User-Agent': 'Mozilla/5.0' } }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve({ status: res.statusCode, data }));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
  });
}

/**
 * GitHub API search
 */
async function searchGitHub(query, type = 'repositories') {
  const headers = { 'User-Agent': 'ProxyHunter/1.0' };
  if (GITHUB_TOKEN) headers['Authorization'] = `token ${GITHUB_TOKEN}`;

  const url = `https://api.github.com/search/${type}?q=${encodeURIComponent(query)}&sort=updated&order=desc&per_page=30`;

  return new Promise((resolve, reject) => {
    https.get(url, { headers }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch {
          reject(new Error('Invalid JSON'));
        }
      });
    }).on('error', reject);
  });
}

/**
 * Extraire les proxies d'un texte brut (max 5000 pour éviter overflow)
 * Formats supportés: IP:PORT, IP:PORT:USER:PASS, socks5://IP:PORT
 */
function extractProxies(text, maxProxies = 5000) {
  const proxies = [];

  // socks5://IP:PORT ou http://IP:PORT
  const protocolRegex = /(socks[45]|https?):\/\/([0-9.]+):(\d+)/gi;
  let match;
  while ((match = protocolRegex.exec(text)) !== null && proxies.length < maxProxies) {
    proxies.push({ proto: match[1].toLowerCase(), host: match[2], port: parseInt(match[3]) });
  }

  // IP:PORT basique
  const basicRegex = /(?:^|\s)([0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}):(\d{2,5})(?:\s|$|,)/gm;
  while ((match = basicRegex.exec(text)) !== null && proxies.length < maxProxies) {
    const ip = match[1];
    const port = parseInt(match[2]);
    // Ignorer IPs privées et ports < 1024 (sauf quelques communs)
    if (ip.startsWith('192.168.') || ip.startsWith('10.') || ip.startsWith('172.')) continue;
    if (port < 1024 && ![80, 443, 1080].includes(port)) continue;

    proxies.push({ proto: 'http', host: ip, port });
  }

  return proxies;
}

/**
 * Scraper GitHub : repos récents avec "proxy list" en TOUTES langues
 */
export async function huntGitHubRepos() {
  const queries = [
    'proxy list updated',
    'free proxies socks5',
    'http proxy list',
    'socks proxy daily',
    // Chinois
    '代理列表',
    '免费代理',
    'socks5代理',
    // Russe
    'список прокси',
    'бесплатные прокси',
    'socks5 прокси',
    // Arabe
    'قائمة البروكسي',
    'بروكسي مجاني',
    // Hébreu
    'רשימת פרוקסי',
    'פרוקסי חינם',
    // Japonais
    'プロキシリスト',
    '無料プロキシ',
    // Coréen
    '프록시 목록',
    '무료 프록시'
  ];

  const found = [];

  for (const query of queries) {
    try {
      const result = await searchGitHub(query, 'repositories');
      if (!result.items) continue;

      // Prendre les 5 repos les plus récents
      for (const repo of result.items.slice(0, 5)) {
        try {
          // Télécharger README ou fichiers proxy communs
          const files = ['README.md', 'proxies.txt', 'proxy.txt', 'http.txt', 'socks5.txt'];

          for (const file of files) {
            const rawUrl = `https://raw.githubusercontent.com/${repo.full_name}/${repo.default_branch}/${file}`;
            try {
              const { status, data } = await fetchUrl(rawUrl, 3000);
              if (status === 200) {
                const proxies = extractProxies(data);
                found.push(...proxies);
                if (proxies.length > 0) {
                  console.log(`  ✅ GitHub: ${repo.full_name}/${file} → ${proxies.length} proxies`);
                }
              }
            } catch {}
          }
        } catch (err) {
          console.error(`  ⚠️  GitHub repo ${repo.full_name}:`, err.message);
        }
      }
    } catch (err) {
      console.error(`  ⚠️  GitHub search "${query}":`, err.message);
    }
  }

  return found;
}

/**
 * Scraper Gists publics
 */
export async function huntGitHubGists() {
  const queries = ['proxy list', 'socks5 proxy', 'http proxy'];
  const found = [];

  for (const query of queries) {
    try {
      const result = await searchGitHub(query, 'code');
      if (!result.items) continue;

      for (const item of result.items.slice(0, 10)) {
        if (!item.html_url.includes('gist.github.com')) continue;

        try {
          const { status, data } = await fetchUrl(item.html_url.replace('/gist.github.com/', '/gist.githubusercontent.com/') + '/raw', 3000);
          if (status === 200) {
            const proxies = extractProxies(data);
            found.push(...proxies);
            if (proxies.length > 0) {
              console.log(`  ✅ Gist: ${item.html_url.split('/').pop()} → ${proxies.length} proxies`);
            }
          }
        } catch {}
      }
    } catch (err) {
      console.error(`  ⚠️  Gist search "${query}":`, err.message);
    }
  }

  return found;
}

/**
 * Scraper sites connus avec listes de proxies
 */
export async function huntKnownSites() {
  const sites = [
    'https://raw.githubusercontent.com/TheSpeedX/PROXY-List/master/http.txt',
    'https://raw.githubusercontent.com/TheSpeedX/PROXY-List/master/socks5.txt',
    'https://raw.githubusercontent.com/ShiftyTR/Proxy-List/master/http.txt',
    'https://raw.githubusercontent.com/ShiftyTR/Proxy-List/master/socks5.txt',
    'https://raw.githubusercontent.com/monosans/proxy-list/main/proxies/http.txt',
    'https://raw.githubusercontent.com/monosans/proxy-list/main/proxies/socks5.txt',
    'https://raw.githubusercontent.com/clarketm/proxy-list/master/proxy-list-raw.txt',
    'https://raw.githubusercontent.com/sunny9577/proxy-scraper/master/proxies.txt',
  ];

  const found = [];

  for (const url of sites) {
    try {
      const { status, data } = await fetchUrl(url, 5000);
      if (status === 200) {
        const proxies = extractProxies(data);
        found.push(...proxies);
        console.log(`  ✅ Known site: ${url.split('/').slice(-2).join('/')} → ${proxies.length} proxies`);
      }
    } catch (err) {
      console.error(`  ⚠️  ${url}:`, err.message);
    }
  }

  return found;
}

/**
 * Hunt ALL sources
 */
export async function huntAll() {
  console.log('🔎 Proxy Hunter: Scraping internet for proxies...');

  const results = await Promise.allSettled([
    huntKnownSites(),
    huntGitHubRepos(),
    huntGitHubGists(),
  ]);

  const all = [];
  for (const result of results) {
    if (result.status === 'fulfilled') {
      all.push(...result.value);
    }
  }

  // Déduplication
  const unique = [];
  const seen = new Set();
  for (const p of all) {
    const key = `${p.proto}://${p.host}:${p.port}`;
    if (!seen.has(key)) {
      seen.add(key);
      unique.push(p);
    }
  }

  console.log(`🔎 Proxy Hunter: ${unique.length} proxies uniques trouvés sur ${all.length} total`);
  return unique;
}
