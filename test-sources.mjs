// Cherche des sources de proxies GRATUITS plus RAPIDES (pas juste vivants).
// Teste par source contre WOS et mesure : %200, latence médiane, %rapides (<3s), débit estimé.
import https from 'https';
import crypto from 'crypto';
import { SocksProxyAgent } from 'socks-proxy-agent';
import { HttpsProxyAgent } from 'https-proxy-agent';

const WOS_URL = "https://wos-giftcode-api.centurygame.com/api/player";
const WOS_HASH = "tB87#kPtkxqOS2";
const TEST_FID = 33750731;
const TIMEOUT = 8000;
const SAMPLE = 200;     // proxies testés par source
const CONC = 120;

const UA = ["Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"];
const md5 = s => crypto.createHash('md5').update(s).digest('hex');
function body(fid){ const t=Date.now(); return new URLSearchParams({ sign: md5(`fid=${fid}&time=${t}${WOS_HASH}`), fid:String(fid), time:String(t) }).toString(); }
function headers(){ return { "User-Agent": UA[0], "Accept":"application/json, text/plain, */*", "Origin":"https://wos-giftcode.centurygame.com", "Referer":"https://wos-giftcode.centurygame.com/", "Content-Type":"application/x-www-form-urlencoded" }; }

// Sources candidates : APIs avec FILTRES de qualité (latence/timeout) + comparaison sources actuelles
const SOURCES = [
  { name: 'proxyscrape-http-filtré<2s',   proto:'http',   url:'https://api.proxyscrape.com/v4/free-proxy-list/get?request=display_proxies&protocol=http&timeout=2000&proxy_format=ipport&format=text' },
  { name: 'proxyscrape-socks5-filtré<2s', proto:'socks5', url:'https://api.proxyscrape.com/v4/free-proxy-list/get?request=display_proxies&protocol=socks5&timeout=2000&proxy_format=ipport&format=text' },
  { name: 'geonode-socks5-triéLatence',   proto:'socks5', url:'https://proxylist.geonode.com/api/proxy-list?limit=500&page=1&sort_by=latency&sort_type=asc&protocols=socks5' },
  { name: 'geonode-http-triéLatence',     proto:'http',   url:'https://proxylist.geonode.com/api/proxy-list?limit=500&page=1&sort_by=latency&sort_type=asc&protocols=http' },
  { name: 'proxy-list.download-socks5',   proto:'socks5', url:'https://www.proxy-list.download/api/v1/get?type=socks5' },
  { name: 'proxyscan.io-socks5',          proto:'socks5', url:'https://www.proxyscan.io/api/proxy?limit=100&type=socks5&format=txt' },
  { name: 'speedx-socks4(ref)',           proto:'socks4', url:'https://raw.githubusercontent.com/TheSpeedX/PROXY-List/master/socks4.txt' },
  { name: 'monosans-socks5(ref-vérifié)', proto:'socks5', url:'https://raw.githubusercontent.com/monosans/proxy-list/main/proxies/socks5.txt' },
];

async function fetchText(url){ try{ const r=await Promise.race([fetch(url,{signal:AbortSignal.timeout(15000)}).then(r=>r.ok?r.text():''), new Promise(res=>setTimeout(()=>res(''),16000))]); return r||''; }catch{ return ''; } }
function parse(text, name){
  if (name.startsWith('geonode')) { try { const j=JSON.parse(text); return (j.data||[]).map(p=>`${p.ip}:${p.port}`); } catch { return []; } }
  const out=[]; for(const l of text.split(/\r?\n/)){ const m=l.trim().match(/(\d{1,3}(?:\.\d{1,3}){3}):(\d{2,5})/); if(m) out.push(`${m[1]}:${m[2]}`); } return out;
}
function sample(a,n){ a=[...new Set(a)]; for(let i=a.length-1;i>0;i--){const j=Math.random()*(i+1)|0;[a[i],a[j]]=[a[j],a[i]];} return a.slice(0,n); }

function test(hostport, proto){
  return new Promise(resolve=>{
    let done=false, req;
    const fin=r=>{ if(done)return; done=true; clearTimeout(timer); try{req?.destroy();}catch{} resolve(r); };
    const timer=setTimeout(()=>fin({r:'to'}), TIMEOUT+1000);  // 🔒 timeout DUR (connect qui hang)
    let agent; try{ agent = proto==='http' ? new HttpsProxyAgent(`http://${hostport}`) : new SocksProxyAgent(`${proto}://${hostport}`); }catch{ return fin({r:'err'}); }
    const b=body(TEST_FID), t0=Date.now();
    req=https.request(WOS_URL,{method:'POST',headers:{...headers(),'Content-Length':Buffer.byteLength(b)},agent},res=>{ res.on('data',()=>{}); res.on('end',()=>fin({r:res.statusCode,ms:Date.now()-t0})); });
    req.on('error',()=>fin({r:'err'}));
    req.write(b); req.end();
  });
}
async function pool(items,fn,c){ const out=[]; let i=0; const w=async()=>{ while(i<items.length){const k=i++; out[k]=await fn(items[k]);} }; await Promise.all(Array.from({length:c},w)); return out; }

(async()=>{
  for(const s of SOURCES){
    const raw = parse(await fetchText(s.url), s.name);
    if(!raw.length){ console.log(`\n${s.name}: ❌ source vide/inaccessible`); continue; }
    const list = sample(raw, SAMPLE);
    const res = await pool(list, p=>test(p, s.proto), CONC);
    const ok = res.filter(x=>x.r===200);
    const lat = ok.map(x=>x.ms).sort((a,b)=>a-b);
    const med = lat.length?lat[lat.length>>1]:0;
    const fast = lat.filter(x=>x<3000).length;        // proxies rapides (<3s)
    const dbt = lat.length? (fast*1000/(med||1)).toFixed(0):0;
    console.error(`${s.name} (${raw.length} dispo, ${list.length} testés)`);
    console.error(`  ✅ vivants: ${ok.length} (${(ok.length/list.length*100).toFixed(1)}%) | médiane ${med}ms | ⚡ rapides<3s: ${fast} (${ok.length?(fast/ok.length*100).toFixed(0):0}% des vivants)`);
  }
  console.error('>>> FIN');
})();
