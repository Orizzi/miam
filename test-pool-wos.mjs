// Test de reconnaissance : pool proxies GRATUIT testé CONTRE WOS avec les vrais headers.
// But : mesurer le taux réel de 200 (l'ancien verdict ~2% était biaisé par les headers/httpbin).
import https from 'https';
import crypto from 'crypto';
import { SocksProxyAgent } from 'socks-proxy-agent';
import { HttpsProxyAgent } from 'https-proxy-agent';

const WOS_URL  = "https://wos-giftcode-api.centurygame.com/api/player";
const WOS_HASH = "tB87#kPtkxqOS2";
const TEST_FID = 33750731;      // ID quelconque — on veut juste le statut HTTP de WOS
const TIMEOUT  = 8000;          // identique au scraper en prod
const PER_PROTO = 300;          // échantillon par protocole
const CONCURRENCY = 120;

const UA = [
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15",
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36",
];
const md5 = s => crypto.createHash('md5').update(s).digest('hex');
function buildBody(fid){ const time=Date.now(); const sign=md5(`fid=${fid}&time=${time}${WOS_HASH}`); return new URLSearchParams({sign,fid:String(fid),time:String(time)}).toString(); }
function headers(){ return {
  'User-Agent': UA[Math.random()*UA.length|0],
  'Accept': 'application/json, text/plain, */*',
  'Origin': 'https://wos-giftcode.centurygame.com',
  'Referer': 'https://wos-giftcode.centurygame.com/',
  'Content-Type': 'application/x-www-form-urlencoded',
}; }

const SOURCES = {
  http: [
    'https://raw.githubusercontent.com/TheSpeedX/PROXY-List/master/http.txt',
    'https://raw.githubusercontent.com/monosans/proxy-list/main/proxies/http.txt',
    'https://raw.githubusercontent.com/prxchk/proxy-list/main/http.txt',
    'https://raw.githubusercontent.com/vakhov/fresh-proxy-list/master/http.txt',
    'https://raw.githubusercontent.com/proxifly/free-proxy-list/main/proxies/protocols/http/data.txt',
  ],
  socks5: [
    'https://raw.githubusercontent.com/TheSpeedX/PROXY-List/master/socks5.txt',
    'https://raw.githubusercontent.com/monosans/proxy-list/main/proxies/socks5.txt',
    'https://raw.githubusercontent.com/hookzof/socks5_list/master/proxy.txt',
    'https://raw.githubusercontent.com/prxchk/proxy-list/main/socks5.txt',
    'https://raw.githubusercontent.com/vakhov/fresh-proxy-list/master/socks5.txt',
  ],
  socks4: [
    'https://raw.githubusercontent.com/TheSpeedX/PROXY-List/master/socks4.txt',
    'https://raw.githubusercontent.com/monosans/proxy-list/main/proxies/socks4.txt',
    'https://raw.githubusercontent.com/prxchk/proxy-list/main/socks4.txt',
    'https://raw.githubusercontent.com/vakhov/fresh-proxy-list/master/socks4.txt',
  ],
};

async function fetchText(url){ try{ const r=await fetch(url,{signal:AbortSignal.timeout(15000)}); if(!r.ok) return ''; return await r.text(); }catch{ return ''; } }
function parse(text){ const out=[]; for(const line of text.split(/\r?\n/)){ const m=line.trim().match(/(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}):(\d{2,5})/); if(m) out.push(`${m[1]}:${m[2]}`); } return out; }
function sample(arr,n){ const a=[...new Set(arr)]; for(let i=a.length-1;i>0;i--){const j=Math.random()*(i+1)|0;[a[i],a[j]]=[a[j],a[i]];} return a.slice(0,n); }

function testProxy(hostport, proto){
  return new Promise(resolve=>{
    let agent;
    try{ agent = proto==='http' ? new HttpsProxyAgent(`http://${hostport}`) : new SocksProxyAgent(`${proto}://${hostport}`); }
    catch{ return resolve({r:'err'}); }
    const body=buildBody(TEST_FID); const t0=Date.now();
    const req=https.request(WOS_URL,{method:'POST',headers:{...headers(),'Content-Length':Buffer.byteLength(body)},agent,timeout:TIMEOUT},res=>{
      res.on('data',()=>{}); res.on('end',()=>resolve({r:res.statusCode,ms:Date.now()-t0}));
    });
    req.on('error',()=>resolve({r:'err',ms:Date.now()-t0}));
    req.on('timeout',()=>{req.destroy();resolve({r:'timeout',ms:Date.now()-t0});});
    req.write(body); req.end();
  });
}

async function runPool(items, fn, conc){
  const results=[]; let i=0;
  const worker=async()=>{ while(i<items.length){ const idx=i++; results[idx]=await fn(items[idx]); } };
  await Promise.all(Array.from({length:conc},worker));
  return results;
}

(async()=>{
  let grandOk=0, grandLat=[];
  for(const proto of ['http','socks5','socks4']){
    let all=[];
    for(const url of SOURCES[proto]) all.push(...parse(await fetchText(url)));
    const uniq=new Set(all).size;
    const list=sample(all,PER_PROTO);
    console.log(`\n=== ${proto.toUpperCase()} : ${list.length} testés (sur ${uniq} uniques scrapés) ===`);
    const res=await runPool(list, p=>testProxy(p,proto), CONCURRENCY);
    const ok=res.filter(x=>x.r===200);
    const c403=res.filter(x=>x.r===403).length;
    const cTO=res.filter(x=>x.r==='timeout').length;
    const cErr=res.filter(x=>x.r==='err').length;
    const others=res.filter(x=>![200,403].includes(x.r)&&x.r!=='timeout'&&x.r!=='err').map(x=>x.r);
    const lat=ok.map(x=>x.ms).sort((a,b)=>a-b);
    const med=lat.length?lat[lat.length>>1]:0;
    grandOk+=ok.length; grandLat.push(...lat);
    console.log(`  ✅ 200 (WOS OK) : ${ok.length} (${(ok.length/list.length*100).toFixed(1)}%)`);
    console.log(`  🚫 403          : ${c403}`);
    console.log(`  ⏱  timeout (8s) : ${cTO}`);
    console.log(`  ❌ err réseau   : ${cErr}`);
    if(others.length) console.log(`  ❓ autres codes : ${[...new Set(others)].join(',')}`);
    console.log(`  ⚡ latence médiane(200): ${med}ms → ~${med?(1000/med).toFixed(1):0} req/s/proxy (1 worker)`);
    console.log(`  📈 débit potentiel : ${ok.length} proxies × ~${med?(1000/med).toFixed(1):0}/s = ~${med?(ok.length*1000/med).toFixed(0):0} req/s`);
  }
  const gl=grandLat.sort((a,b)=>a-b); const gmed=gl.length?gl[gl.length>>1]:0;
  console.log(`\n=== BILAN : ${grandOk} proxies vivants pour WOS, latence médiane ${gmed}ms ===`);
  console.log(`>>> FIN`);
})();
