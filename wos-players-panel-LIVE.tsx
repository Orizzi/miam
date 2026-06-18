'use client';

import { useEffect, useState, useCallback, useRef } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuCheckboxItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
} from '@/components/ui/dropdown-menu';

const API    = 'https://wosforge.org/WPDS/api';
const WS_URL = 'wss://wosforge.org/WPDS/dashboard';

// ─── Métriques disponibles (sélectionnables via dropdown) ──────────────────────
// Chaque métrique sait extraire sa valeur depuis le contexte {stats, scraper, progress}
type MetricCtx = { stats: any; scraper: any; progress: any };
type MetricDef = {
  id: string; label: string; group: string; color: string; info: string;
  deltaKey?: string;        // clé dans scraper.deltas → avancement /h (calculé côté serveur)
  deltaInverted?: boolean;  // pour "restants" : le delta affiché est l'opposé (ce qui diminue)
  get: (c: MetricCtx) => { value: string; sub?: string };
};

const ALL_METRICS: MetricDef[] = [
  // ── Base de données (cumulé) ──
  { id: 'players', label: 'Joueurs actifs', group: 'Base de données', color: 'text-orange-400', deltaKey: 'players',
    info: "Nombre total de joueurs réels enregistrés dans la base (cumulé depuis le début). Le +X/h = nouveaux trouvés sur la dernière heure (calculé côté serveur).",
    get: c => ({ value: fmt(c.stats?.total_players ?? 0) }) },
  { id: 'dead', label: 'Dead IDs', group: 'Base de données', color: 'text-red-400', deltaKey: 'dead',
    info: "IDs confirmés sans joueur (comptes inexistants). Cumulé. +X/h = nouveaux confirmés morts sur la dernière heure.",
    get: c => ({ value: fmt(c.stats?.total_dead ?? 0) }) },
  { id: 'total_all', label: 'Total comptes', group: 'Base de données', color: 'text-blue-400',
    info: "Total des comptes connus (joueurs trouvés).",
    get: c => ({ value: fmt(c.stats?.total_all ?? 0) }) },
  { id: 'name_changes', label: 'Changements de nom', group: 'Base de données', color: 'text-yellow-400',
    info: "Nombre de joueurs ayant changé de pseudo (détecté lors des re-scans).",
    get: c => ({ value: fmt(c.stats?.nickname_changes ?? 0) }) },

  // ── Progression du scan ──
  { id: 'discovered', label: 'IDs avec réponse', group: 'Progression', color: 'text-blue-400', deltaKey: 'discovered',
    info: "Nombre d'IDs ayant reçu une réponse fiable (joueur trouvé OU confirmé mort), sur la cible de 800M. C'est la vraie couverture. +X/h = avancement sur la dernière heure.",
    get: c => ({ value: fmt(c.progress?.progress?.scanned_count ?? 0),
                 sub: c.progress ? `${c.progress.progress.coverage.toFixed(2)}% / 800M` : undefined }) },
  { id: 'remaining', label: 'IDs restants', group: 'Progression', color: 'text-cyan-400', deltaKey: 'discovered', deltaInverted: true,
    info: "IDs pas encore testés sur la cible 1 → 800M. Le -X/h = ce qui a été éliminé sur la dernière heure.",
    get: c => ({ value: fmt(c.progress?.progress?.remaining_ids ?? 0) }) },
  { id: 'days_left', label: 'Jours restants', group: 'Progression', color: 'text-yellow-400',
    info: "Estimation du temps pour finir, basée sur le vrai débit actuel (IDs résolus/s).",
    get: c => ({ value: c.progress?.estimatedDaysRemaining != null ? `~${Math.round(c.progress.estimatedDaysRemaining)}j` : '—' }) },

  // ── Position des scanners (curseurs par instance) ──
  { id: 'cursor1', label: 'Scanner 1', group: 'Position des scanners', color: 'text-cyan-300', deltaKey: 'c1',
    info: "Position actuelle du scanner 1 (plage 1 → 167M). +X/h = IDs avancés sur la dernière heure.",
    get: c => ({ value: `#${fmt(c.scraper?.cursors?.[1] ?? 0)}`, sub: '1 → 167M' }) },
  { id: 'cursor2', label: 'Scanner 2', group: 'Position des scanners', color: 'text-cyan-300', deltaKey: 'c2',
    info: "Position actuelle du scanner 2 (plage 167M → 334M). +X/h = IDs avancés sur la dernière heure.",
    get: c => ({ value: `#${fmt(c.scraper?.cursors?.[2] ?? 0)}`, sub: '167M → 334M' }) },
  { id: 'cursor3', label: 'Scanner 3', group: 'Position des scanners', color: 'text-cyan-300', deltaKey: 'c3',
    info: "Position actuelle du scanner 3 (plage 334M → 500M). +X/h = IDs avancés sur la dernière heure.",
    get: c => ({ value: `#${fmt(c.scraper?.cursors?.[3] ?? 0)}`, sub: '334M → 500M' }) },
  { id: 'cursor4', label: 'Retest (inst. 4)', group: 'Position des scanners', color: 'text-pink-300', deltaKey: 'c4',
    info: "Instance 4, dédiée au retest des erreurs. En fallback (si aucune erreur), elle scanne aussi 1 → 500M.",
    get: c => ({ value: `#${fmt(c.scraper?.cursors?.[4] ?? 0)}`, sub: 'retest erreurs' }) },
  { id: 'cursor5', label: 'Scanner 5', group: 'Position des scanners', color: 'text-emerald-300', deltaKey: 'c5',
    info: "Scanner 5 (plage 500M → 575M). +X/h = IDs avancés sur la dernière heure.",
    get: c => ({ value: `#${fmt(c.scraper?.cursors?.[5] ?? 0)}`, sub: '500M → 575M' }) },
  { id: 'cursor6', label: 'Scanner 6', group: 'Position des scanners', color: 'text-emerald-300', deltaKey: 'c6',
    info: "Scanner 6 (plage 575M → 650M). +X/h = IDs avancés sur la dernière heure.",
    get: c => ({ value: `#${fmt(c.scraper?.cursors?.[6] ?? 0)}`, sub: '575M → 650M' }) },
  { id: 'cursor7', label: 'Scanner 7', group: 'Position des scanners', color: 'text-emerald-300', deltaKey: 'c7',
    info: "Scanner 7 (plage 650M → 725M). +X/h = IDs avancés sur la dernière heure.",
    get: c => ({ value: `#${fmt(c.scraper?.cursors?.[7] ?? 0)}`, sub: '650M → 725M' }) },
  { id: 'cursor8', label: 'Scanner 8', group: 'Position des scanners', color: 'text-emerald-300', deltaKey: 'c8',
    info: "Scanner 8 (plage 725M → 800M). +X/h = IDs avancés sur la dernière heure.",
    get: c => ({ value: `#${fmt(c.scraper?.cursors?.[8] ?? 0)}`, sub: '725M → 800M' }) },

  // ── Performance (session) ──
  { id: 'rate', label: 'Débit réel', group: 'Performance', color: 'text-cyan-400',
    info: "Vrai débit = IDs réellement résolus par seconde (joueurs + dead ajoutés en base). N'inclut PAS les IDs sautés car déjà connus.",
    get: c => ({ value: `${fmt(c.scraper?.ratePerSec ?? 0)}/s` }) },
  { id: 'rate_proxy', label: 'Débit Proxy', group: 'Performance', color: 'text-cyan-300',
    info: "Débit (IDs/s) passant par les PROXIES PUBLICS gratuits. Mesuré côté serveur sur 30s, agrégé sur toutes les instances.",
    get: c => ({ value: `${fmt(Math.round(c.scraper?.srcRate?.proxy ?? 0))}/s`, sub: 'proxies publics' }) },
  { id: 'rate_tor', label: 'Débit TOR', group: 'Performance', color: 'text-orange-300',
    info: "Débit (IDs/s) passant par TOR (utilisé en fallback quand le pool proxy est vide). Mesuré côté serveur sur 30s.",
    get: c => ({ value: `${fmt(Math.round(c.scraper?.srcRate?.tor ?? 0))}/s`, sub: 'circuits TOR' }) },
  { id: 'uptime', label: 'Uptime session', group: 'Performance', color: 'text-purple-400',
    info: "Durée écoulée depuis le démarrage de la session de scan.",
    get: c => ({ value: formatUptime(c.scraper?.sessionDuration) }) },
  { id: 'phase', label: 'Phase de scan', group: 'Performance', color: 'text-green-400',
    info: "Phase 1 = couverture exhaustive distribuée (7 scanners + 1 retest), cible 1 → 800M.",
    get: c => ({ value: String(c.scraper?.phase ?? '—') }) },

  // ── Résultats (session) ──
  { id: 'pending', label: 'À retester', group: 'Résultats session', color: 'text-yellow-400', deltaKey: 'pending',
    info: "IDs en attente de retest (erreur réseau/proxy au 1er essai). L'instance 4 les retest jusqu'à réponse fiable. -X/h (vert) = la file diminue ; +X/h (rouge) = elle grossit.",
    get: c => ({ value: fmt(c.scraper?.pendingErrors ?? 0) }) },
  { id: 'found', label: 'Trouvés (session)', group: 'Résultats session', color: 'text-green-400',
    info: "Joueurs trouvés depuis le démarrage de la session en cours.",
    get: c => ({ value: fmt(c.scraper?.found ?? 0) }) },
  { id: 'session_dead', label: 'Dead (session)', group: 'Résultats session', color: 'text-red-400',
    info: "IDs morts confirmés depuis le démarrage de la session en cours.",
    get: c => ({ value: fmt(c.scraper?.dead ?? 0) }) },

  // ── Workers & Proxies ──
  { id: 'proxy_workers', label: 'Proxy Workers', group: 'Workers & Proxies', color: 'text-purple-400',
    info: "Nombre de workers proxy (TOR) actifs et nombre de proxies vivants dans le pool.",
    get: c => ({ value: fmt(c.scraper?.concurrencyProxy ?? 0), sub: `${fmt(c.scraper?.proxyByType?.alive ?? 0)} vivants` }) },
  { id: 'cf_workers', label: 'CF Workers', group: 'Workers & Proxies', color: 'text-indigo-400',
    info: "Workers Cloudflare. Souvent à 0 (quota journalier épuisé, reset à minuit UTC).",
    get: c => ({ value: fmt(c.scraper?.concurrencyCF ?? 0), sub: c.scraper?.cfActive ? '✓ actif' : '✗ quota' }) },
];

// Formate un delta /h pour affichage : { text, positive } ou null si nul/absent
function fmtDelta(m: MetricDef, scraper: any): { text: string; positive: boolean } | null {
  if (!m.deltaKey) return null;
  let d = scraper?.deltas?.[m.deltaKey];
  if (d == null || d === 0) return null;
  if (m.deltaInverted) d = -d;
  return { text: (d > 0 ? '↑ +' : '↓ ') + fmt(d) + ' /h', positive: d > 0 };
}

const DEFAULT_METRICS = [
  'players', 'dead', 'discovered', 'remaining', 'rate', 'rate_proxy', 'rate_tor', 'pending',
  'cursor1', 'cursor2', 'cursor3', 'cursor5', 'cursor6', 'cursor7', 'cursor8', 'cursor4',
];
const METRICS_LS_KEY = 'wpds_visible_metrics_v3';  // v3 : reset pour afficher les îlots débit TOR/proxy

function fmtFurnace(lvl: number): string {
  if (!lvl || lvl <= 0) return '—';
  if (lvl <= 30) return 'F' + lvl;
  if (lvl <= 34) return 'F30-' + (lvl - 30);
  // FC1=35, FC2=40, FC3=45 ... FC10=80
  // chaque FC = 5 niveaux : FCn, FCn-1, FCn-2, FCn-3, FCn-4
  const fc    = Math.floor((lvl - 35) / 5) + 1;
  const sub   = (lvl - 35) % 5;
  return sub === 0 ? 'FC' + fc : 'FC' + fc + '-' + sub;
}

function fmt(n: number | null | undefined) {
  if (n == null) return '—';
  return Number(n).toLocaleString();
}

function timeAgo(ts: number) {
  if (!ts) return '—';
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60) return s + 's ago';
  const m = Math.floor(s / 60);
  if (m < 60) return m + 'm ago';
  const h = Math.floor(m / 60);
  if (h < 24) return h + 'h ago';
  return Math.floor(h / 24) + 'd ago';
}

function formatUptime(seconds: number | undefined) {
  if (!seconds) return '—';
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);

  if (d > 0) return `${d}d ${h}h ${m}m`;
  if (h > 0) return `${h}h ${m}m ${s}s`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

// ─── Répartition (camembert) ────────────────────────────────────────────────────
interface Breakdown {
  f30: number; existing: number; lords: number; dead: number; pending: number; totalScanned: number;
}
const BREAKDOWN_SEGMENTS: { key: keyof Breakdown; label: string; color: string; desc: string }[] = [
  { key: 'f30',      label: 'Joueurs F30+',        color: '#fb923c', desc: 'Joueurs établis (fourneau ≥ 30).' },
  { key: 'existing', label: 'Joueurs existants',   color: '#22d3ee', desc: 'Vrais joueurs avec nom personnalisé, en-dessous de F30.' },
  { key: 'lords',    label: 'Comptes fantômes',    color: '#94a3b8', desc: 'Nom par défaut « lord<id> », compte créé mais jamais joué.' },
  { key: 'dead',     label: 'IDs inexistants',     color: '#f87171', desc: 'Confirmés sans aucun compte (réponse fiable).' },
  { key: 'pending',  label: 'En erreur (non déf.)', color: '#facc15', desc: "Réponse pas encore obtenue (erreur réseau/proxy). Doit rester très bas et diminuer — l'instance 4 les retest." },
];

function DonutChart({ data, hidden }: { data: Breakdown; hidden: Set<string> }) {
  const r = 70, cx = 90, cy = 90, sw = 26;
  const C = 2 * Math.PI * r;
  // Ne garder que les segments cochés ; le total se recalcule en conséquence
  const segs = BREAKDOWN_SEGMENTS.filter(s => !hidden.has(s.key));
  const total = segs.reduce((sum, s) => sum + (data[s.key] || 0), 0);
  let offset = 0;
  return (
    <svg viewBox="0 0 180 180" className="w-44 h-44">
      <g transform="rotate(-90 90 90)">
        <circle cx={cx} cy={cy} r={r} fill="none" stroke="#1e293b" strokeWidth={sw} />
        {segs.map(s => {
          const val = data[s.key] || 0;
          const frac = total > 0 ? val / total : 0;
          const dash = frac * C;
          const el = (
            <circle key={s.key} cx={cx} cy={cy} r={r} fill="none"
              stroke={s.color} strokeWidth={sw}
              strokeDasharray={`${dash} ${C - dash}`}
              strokeDashoffset={-offset}
              style={{ transition: 'stroke-dasharray 0.5s, stroke-dashoffset 0.5s' }} />
          );
          offset += dash;
          return el;
        })}
      </g>
      <text x={cx} y={cy - 4} textAnchor="middle" className="fill-white font-bold" style={{ fontSize: 18 }}>
        {total >= 1_000_000 ? (total / 1_000_000).toFixed(2) + 'M' : total.toLocaleString()}
      </text>
      <text x={cx} y={cy + 12} textAnchor="middle" className="fill-slate-400" style={{ fontSize: 8 }}>
        IDs affichés
      </text>
    </svg>
  );
}

interface Stats {
  total_players: number;
  total_inactive: number;
  total_all: number;
  total_dead: number;
  min_id: number;
  max_id: number;
  nickname_changes: number;
}

interface ScraperStatus {
  phase: number;
  scanned: number;
  skipped?: number;
  found: number;
  dead: number;
  errors?: number;
  // Option A: Error breakdown
  rateLimited?: number;
  errorTimeout?: number;
  error5xx?: number;
  errorProxy?: number;
  errorCfQuota?: number;
  ratePerSec: number;
  skipRate?: number;
  processingRate?: number;
  currentId: number;
  cursors?: Record<number, number>;
  deltas?: Record<string, number>;  // avancement /h calculé côté serveur
  srcRate?: { tor: number; proxy: number };  // débit/s par source de transport
  pendingErrors: number;
  concurrency: number;
  concurrencyCF: number;
  concurrencyProxy: number;
  cfActive: boolean;
  cfDelayAvg: number;
  proxyDelayAvg: number;
  proxyTotal: number;
  proxyByType: {
    total?: number;
    alive?: number;
    cooldown?: number;
    dead?: number;
    http?: number;
    socks5?: number;
    socks4?: number;
    byProto?: { http?: number; socks5?: number; socks4?: number };
    totalRequests?: number;
    avgRequestsPerProxy?: number;
    totalTested?: number;
    totalSources?: number;
    sourceStats?: {
      attempted?: number;
      succeeded?: number;
      failed?: number;
      successRate?: number;
      lastRefresh?: number;
      recentFailures?: Array<{ url: string; error: string; ts: number }>;
    };
    proxyHealth?: {
      cooldownReasons?: { [key: string]: number };
      avgFailures?: number;
      qualityDistribution?: { excellent: number; good: number; fair: number; poor: number };
    };
  };
  delayMin: number;
  delayMax: number;
  paused: boolean;
  startTs?: number;
  sessionDuration?: number;
}

interface ProgressData {
  progress: {
    min_id: number;
    max_id: number;
    explored_range: number;
    scanned_count: number;
    coverage: number;
    remaining_ids: number;
  };
  avgRate: {
    avgRatePerSec: number;
    totalScanned: number;
    periodDays: number;
    fallback?: boolean;
  } | null;
  estimatedDaysRemaining: number | null;
}

interface Player {
  id: number;
  nickname: string;
  kid: number;
  state_level: number;
  first_seen: number;
  last_seen: number;
  retested?: number;  // 1 = ID qui a eu une erreur puis été retesté
}

interface Change {
  player_id: number;
  nickname: string;
  field: string;
  old_value: string;
  new_value: string;
  changed_at: number;
}

interface Server {
  kingdom: number;
  total_count: number;
  actif_count: number;
  inactive_count: number;
  lord_count: number;
  max_furnace: number;
  avg_furnace: number;
}

interface ProgressData {
  progress: {
    min_id: number;
    max_id: number;
    explored_range: number;
    scanned_count: number;
    coverage: number;
    remaining_ids: number;
  };
  avgRate: {
    avgRatePerSec: number;
    totalScanned: number;
    periodDays: number;
    fallback?: boolean;
  } | null;
  estimatedDaysRemaining: number | null;
}

export default function WosPlayersPanel() {
  const [stats, setStats]                   = useState<Stats | null>(null);
  const [scraper, setScraper]               = useState<ScraperStatus | null>(null);
  const [recentPlayers, setRecent]          = useState<Player[]>([]);
  const [changes, setChanges]               = useState<Change[]>([]);
  const [servers, setServers]               = useState<Server[]>([]);
  const [search, setSearch]                 = useState('');
  const [searchResults, setSearchResults]   = useState<Player[] | null>(null);
  const [tab, setTab]                       = useState<'overview' | 'servers' | 'search'>('overview');
  const [loading, setLoading]               = useState(true);
  const [srvFilter, setSrvFilter]           = useState('');
  const [srvSort, setSrvSort]               = useState<{ col: keyof Server; dir: 'asc' | 'desc' }>({ col: 'kingdom', dir: 'asc' });
  const [selectedKingdom, setSelectedKingdom]   = useState<number | null>(null);
  const [kingdomPlayers, setKingdomPlayers]     = useState<Player[]>([]);
  const [kingdomTotal, setKingdomTotal]         = useState(0);
  const [kingdomPage, setKingdomPage]           = useState(0);
  const [kingdomLoading, setKingdomLoading]     = useState(false);
  const [kingdomFilter, setKingdomFilter]       = useState<'actifs'|'inactive'|'lords'|'all'>('actifs');
  const [kingdomPlayerSearch, setKingdomPlayerSearch] = useState('');
  const [kingdomSort, setKingdomSort]           = useState<{col:string;dir:'asc'|'desc'}>({col:'state_level',dir:'desc'});
  const [wsStatus, setWsStatus]             = useState<'connecting' | 'live' | 'offline'>('connecting');
  const wsRef                               = useRef<WebSocket | null>(null);
  const [progress, setProgress]             = useState<ProgressData | null>(null);
  const [breakdown, setBreakdown]           = useState<Breakdown | null>(null);
  // Sous-onglet de la section stats : îlots "live" ou camembert "répartition"
  const [statView, setStatView]             = useState<'stats' | 'breakdown'>('stats');
  // Catégories masquées du camembert (cases décochées) — recalcule le donut
  const [hiddenSegments, setHiddenSegments] = useState<Set<string>>(new Set());
  const toggleSegment = useCallback((key: string) => {
    setHiddenSegments(prev => {
      const next = new Set(prev);
      next.has(key) ? next.delete(key) : next.add(key);
      return next;
    });
  }, []);

  // 📊 Métriques visibles (sélectionnables via dropdown, persisté en localStorage)
  const [visibleMetrics, setVisibleMetrics] = useState<string[]>(DEFAULT_METRICS);
  useEffect(() => {
    try {
      const saved = localStorage.getItem(METRICS_LS_KEY);
      if (saved) {
        const arr = JSON.parse(saved);
        if (Array.isArray(arr) && arr.length > 0) setVisibleMetrics(arr);
      }
    } catch { /* ignore */ }
  }, []);
  const toggleMetric = useCallback((id: string) => {
    setVisibleMetrics(prev => {
      const next = prev.includes(id) ? prev.filter(m => m !== id) : [...prev, id];
      try { localStorage.setItem(METRICS_LS_KEY, JSON.stringify(next)); } catch { /* ignore */ }
      return next;
    });
  }, []);

  // 🔒 ROBUSTE : useRef pour garder TOUJOURS dernières valeurs valides (ne jamais revenir à 0)
  const lastValidRateRef        = useRef<number>(0);
  const lastValidSkipRateRef    = useRef<number>(0);
  const lastValidProcessingRef  = useRef<number>(0);
  const lastValidUptimeRef      = useRef<number>(0);

  // (Deltas /h calculés côté serveur — voir scraper.deltas)

  const loadScraper = useCallback(async () => {
    const ctrl = await fetch(API + '/control/state').then(r => r.json()).catch(() => null);
    if (!ctrl) return;

    // 🔒 ROBUSTE : Mettre à jour refs si valeur > 0
    if (ctrl.ratePerSec > 0) lastValidRateRef.current = ctrl.ratePerSec;
    if (ctrl.skipRate > 0) lastValidSkipRateRef.current = ctrl.skipRate;
    if (ctrl.processingRate > 0) lastValidProcessingRef.current = ctrl.processingRate;

    setScraper(prev => ({
      phase:            ctrl.phase            ?? prev?.phase            ?? 1,
      scanned:          ctrl.scanned          || (prev?.scanned          ?? 0),
      found:            ctrl.found            || (prev?.found            ?? 0),
      dead:             ctrl.dead             || (prev?.dead             ?? 0),
      // ROBUSTE : Utiliser ref (JAMAIS 0)
      ratePerSec:       ctrl.ratePerSec > 0 ? ctrl.ratePerSec : lastValidRateRef.current,
      currentId:        ctrl.currentId        || (prev?.currentId        ?? 0),
      cursors:          ctrl.cursors          ?? (prev?.cursors          ?? {}),
      deltas:           ctrl.deltas           ?? (prev?.deltas           ?? {}),
      srcRate:          ctrl.srcRate          ?? (prev?.srcRate          ?? { tor: 0, proxy: 0 }),
      sessionDuration:  ctrl.sessionDuration   ?? (prev?.sessionDuration  ?? 0),
      pendingErrors:    ctrl.pendingErrors     ?? (prev?.pendingErrors    ?? 0),
      concurrency:      ctrl.concurrency      || (prev?.concurrency      ?? 1050),
      concurrencyCF:    ctrl.concurrencyCF    || (prev?.concurrencyCF    ?? 50),
      concurrencyProxy: ctrl.concurrencyProxy || (prev?.concurrencyProxy ?? 1000),
      cfActive:         ctrl.cfActive         ?? (prev?.cfActive         ?? false),
      cfDelayAvg:       ctrl.cfDelayAvg       ?? (prev?.cfDelayAvg       ?? 0),
      proxyDelayAvg:    ctrl.proxyDelayAvg    ?? (prev?.proxyDelayAvg    ?? 0),
      proxyTotal:       ctrl.proxyTotal       ?? (prev?.proxyTotal       ?? 0),
      proxyByType:      ctrl.proxyByType      || (prev?.proxyByType      ?? {}),
      delayMin:         ctrl.delayMin         ?? (prev?.delayMin         ?? 0),
      delayMax:         ctrl.delayMax         ?? (prev?.delayMax         ?? 0),
      paused:           ctrl.paused           ?? (prev?.paused           ?? false),
    }));
  }, []);

  const load = useCallback(async () => {
    const data = await fetch(API + '/stats').then(r => r.json()).catch(() => null);
    if (!data) return;
    setStats(data.stats);
    setRecent(data.recentPlayers || []);
    setChanges(data.recentChanges || []);
    if (data.breakdown) setBreakdown(data.breakdown);
    // (Les deltas /h sont calculés CÔTÉ SERVEUR maintenant — plus de snapshot client.)

    await loadScraper();
    setLoading(false);
  }, [loadScraper]);

  const loadServers = useCallback(async () => {
    const data = await fetch(API + '/servers').then(r => r.json()).catch(() => null);
    if (data) setServers(data.servers || []);
  }, []);

  const loadProgress = useCallback(async () => {
    const data = await fetch(API + '/progress').then(r => r.json()).catch(() => null);
    if (data) setProgress(data);
  }, []);

  // WebSocket — reçoit les stats scraper en temps réel
  useEffect(() => {
    let ws: WebSocket;
    let retryTimer: ReturnType<typeof setTimeout>;

    function connect() {
      ws = new WebSocket(WS_URL);
      wsRef.current = ws;
      setWsStatus('connecting');

      ws.onopen = () => {
        setWsStatus('live');
        load(); // charger les stats initiales
        loadProgress(); // charger progression initiale
      };

      ws.onmessage = (e) => {
        try {
          const msg = JSON.parse(e.data);
          if (msg.type === 'stats') {
            if (msg.global) {
              setStats(prev => prev ? {
                ...prev,
                total_players:    msg.global.total_players    ?? prev.total_players,
                nickname_changes: msg.global.nickname_changes ?? prev.nickname_changes,
              } : prev);
            }
            if (msg.session || msg.rate || msg.phase !== undefined || msg.currentId !== undefined) {
              setScraper(prev => {
                // Si msg.session existe, utiliser ses valeurs, sinon garder prev
                const session = msg.session || {};

                // 🔒 ROBUSTE : Mettre à jour refs si valeur > 0
                if (session.ratePerSec > 0) lastValidRateRef.current = session.ratePerSec;
                if (session.skipRate > 0) lastValidSkipRateRef.current = session.skipRate;
                if (session.processingRate > 0) lastValidProcessingRef.current = session.processingRate;
                if (session.sessionDuration > 0) lastValidUptimeRef.current = session.sessionDuration;

                return {
                  phase:            msg.phase                    ?? prev?.phase            ?? 1,
                  scanned:          session.scanned              ?? prev?.scanned          ?? 0,
                  found:            session.found                ?? prev?.found            ?? 0,
                  dead:             session.dead                 ?? prev?.dead             ?? 0,
                  // ROBUSTE : Utiliser ref comme fallback (JAMAIS 0 une fois qu'on a une valeur)
                  ratePerSec:       session.ratePerSec > 0 ? session.ratePerSec : lastValidRateRef.current,
                  skipRate:         session.skipRate > 0 ? session.skipRate : lastValidSkipRateRef.current,
                  processingRate:   session.processingRate > 0 ? session.processingRate : lastValidProcessingRef.current,
                  sessionDuration:  session.sessionDuration > 0 ? session.sessionDuration : lastValidUptimeRef.current,
                  currentId:        msg.currentId                ?? prev?.currentId        ?? 0,
                  // 🔒 Préserver cursors/deltas/srcRate (le WS ne les envoie pas → sinon clignotement)
                  cursors:          session.cursors              ?? prev?.cursors          ?? {},
                  deltas:           session.deltas               ?? prev?.deltas           ?? {},
                  srcRate:          session.srcRate              ?? prev?.srcRate          ?? { tor: 0, proxy: 0 },
                  pendingErrors:    session.pendingErrors        ?? prev?.pendingErrors    ?? 0,
                  concurrency:      session.concurrency          ?? prev?.concurrency      ?? 150,
                  concurrencyCF:    session.concurrencyCF        ?? prev?.concurrencyCF    ?? 50,
                  concurrencyProxy: session.concurrencyProxy     ?? prev?.concurrencyProxy ?? 100,
                  cfActive:         session.cfActive             ?? prev?.cfActive         ?? false,
                  cfDelayAvg:       session.cfDelayAvg           ?? prev?.cfDelayAvg       ?? 0,
                  proxyDelayAvg:    session.proxyDelayAvg        ?? prev?.proxyDelayAvg    ?? 0,
                  proxyTotal:       session.proxyTotal           ?? prev?.proxyTotal       ?? 0,
                  proxyByType:      session.proxyByType          ?? prev?.proxyByType      ?? {},
                  delayMin:         session.delayMin             ?? prev?.delayMin         ?? 0,
                  delayMax:         session.delayMax             ?? prev?.delayMax         ?? 0,
                  paused:           msg.paused                   ?? prev?.paused           ?? false,
                };
              });
            }

            // (snapshot horaire géré par load() chaque seconde, format générique)
          } else if (msg.type === 'found') {
            // Ajouter en tête des joueurs récents
            setRecent(prev => {
              const p: Player = { id: msg.id, nickname: msg.nickname, kid: msg.kid, state_level: msg.stateLevel ?? 0, first_seen: Date.now(), last_seen: Date.now() };
              if (prev.some(r => r.id === p.id)) return prev;
              return [p, ...prev].slice(0, 20);
            });
          } else if (msg.type === 'init') {
            load();
          }
        } catch {}
      };

      ws.onclose = () => {
        setWsStatus('offline');
        retryTimer = setTimeout(connect, 3000);
      };
    }

    connect();
    // ✅ TOUT rafraîchi CHAQUE SECONDE (l'API sert un cache, donc c'est léger)
    // scraper status : rate, phase, curseurs par instance, à retester
    const scraperTimer = setInterval(loadScraper, 1_000);
    // stats globales + recent players (à retester, recently discovered)
    const restTimer = setInterval(load, 1_000);
    // progression : IDs avec réponse / restants / jours
    const progressTimer = setInterval(loadProgress, 1_000);

    return () => {
      ws?.close();
      clearTimeout(retryTimer);
      clearInterval(scraperTimer);
      clearInterval(restTimer);
      clearInterval(progressTimer);
    };
  }, [load, loadScraper, loadProgress]);

  useEffect(() => {
    if (tab === 'servers' && servers.length === 0) loadServers();
  }, [tab, servers.length, loadServers]);

  const doSearch = async () => {
    if (!search.trim()) return;
    const url = /^\d+$/.test(search)
      ? API + '/player/' + search
      : API + '/search?q=' + encodeURIComponent(search);
    const data = await fetch(url).then(r => r.json()).catch(() => null);
    if (!data) return;
    setSearchResults(data.results ?? (data.player ? [data.player] : []));
  };

  const filteredServers = [...(srvFilter
    ? servers.filter(s => String(s.kingdom).includes(srvFilter.replace(/k/i, '')))
    : servers
  )].sort((a, b) => {
    const va = a[srvSort.col] ?? 0;
    const vb = b[srvSort.col] ?? 0;
    return srvSort.dir === 'asc' ? (va > vb ? 1 : -1) : (va < vb ? 1 : -1);
  });

  function toggleSort(col: keyof Server) {
    setSrvSort(prev => prev.col === col
      ? { col, dir: prev.dir === 'asc' ? 'desc' : 'asc' }
      : { col, dir: col === 'kingdom' ? 'asc' : 'desc' }
    );
  }

  function sortIcon(col: keyof Server) {
    if (srvSort.col !== col) return ' ↕';
    return srvSort.dir === 'asc' ? ' ↑' : ' ↓';
  }

  async function selectKingdom(kid: number) {
    setSelectedKingdom(kid);
    setKingdomPage(0);
    setKingdomPlayerSearch('');
    await loadKingdomPlayers(kid, 'actifs', {col:'state_level',dir:'desc'}, 0);
  }

  async function loadKingdomPlayers(
    kid: number,
    filter: string,
    sort: {col:string;dir:'asc'|'desc'},
    page: number
  ) {
    setKingdomLoading(true);
    const params = new URLSearchParams({ sort: sort.col, dir: sort.dir, filter, page: String(page) });
    const data = await fetch(`${API}/servers/${kid}/players?${params}`)
      .then(r => r.json()).catch(() => null);
    setKingdomPlayers(data?.players ?? []);
    setKingdomTotal(data?.total ?? 0);
    setKingdomLoading(false);
  }

  async function setKingdomFilterAndLoad(f: 'actifs'|'inactive'|'lords'|'all') {
    setKingdomFilter(f);
    setKingdomPage(0);
    if (selectedKingdom) await loadKingdomPlayers(selectedKingdom, f, kingdomSort, 0);
  }

  async function setKingdomSortAndLoad(col: string) {
    const newSort = { col, dir: (kingdomSort.col === col && kingdomSort.dir === 'desc' ? 'asc' : 'desc') as 'asc'|'desc' };
    setKingdomSort(newSort);
    if (selectedKingdom) await loadKingdomPlayers(selectedKingdom, kingdomFilter, newSort, kingdomPage);
  }

  async function changeKingdomPage(delta: number) {
    const newPage = Math.max(0, kingdomPage + delta);
    setKingdomPage(newPage);
    if (selectedKingdom) await loadKingdomPlayers(selectedKingdom, kingdomFilter, kingdomSort, newPage);
  }

  if (loading) return <div className="text-muted-foreground p-6">Loading WPDS data…</div>;

  return (
    <div className="flex flex-col gap-2.5">

      {/* ─── Section stats : 2 sous-onglets (Statistiques live / Répartition) ─── */}
      <div className="flex flex-col gap-2">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-1">
            <span className={`inline-block w-2.5 h-2.5 rounded-full mr-1 ${
              wsStatus === 'live' ? (scraper?.paused ? 'bg-yellow-400' : 'bg-green-400 animate-pulse') :
              wsStatus === 'connecting' ? 'bg-yellow-400 animate-pulse' : 'bg-green-400 animate-pulse'
            }`} />
            <button
              onClick={() => setStatView('stats')}
              className={`px-2.5 py-1 text-sm font-medium rounded-md transition-colors ${
                statView === 'stats' ? 'bg-slate-800 text-foreground' : 'text-muted-foreground hover:text-foreground'
              }`}
            >Statistiques</button>
            <button
              onClick={() => setStatView('breakdown')}
              className={`px-2.5 py-1 text-sm font-medium rounded-md transition-colors ${
                statView === 'breakdown' ? 'bg-slate-800 text-foreground' : 'text-muted-foreground hover:text-foreground'
              }`}
            >Répartition</button>
            {scraper?.paused && <Badge variant="outline" className="ml-1">Paused</Badge>}
          </div>
          {statView === 'stats' && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="outline" size="sm" className="h-7 text-xs">
                  ⚙️ Métriques ({visibleMetrics.length})
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-60 max-h-[70vh] overflow-y-auto">
                {Array.from(new Set(ALL_METRICS.map(m => m.group))).map(group => (
                  <div key={group}>
                    <DropdownMenuLabel className="text-xs text-muted-foreground">{group}</DropdownMenuLabel>
                    {ALL_METRICS.filter(m => m.group === group).map(m => (
                      <DropdownMenuCheckboxItem
                        key={m.id}
                        checked={visibleMetrics.includes(m.id)}
                        onCheckedChange={() => toggleMetric(m.id)}
                        onSelect={(e) => e.preventDefault()}
                      >
                        {m.label}
                      </DropdownMenuCheckboxItem>
                    ))}
                    <DropdownMenuSeparator />
                  </div>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </div>

      {statView === 'stats' ? (<>

        {/* Grille de métriques uniforme (2 lignes max) — chaque îlot a un ⓘ survolable */}
        <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-6 gap-2">
          {(() => {
            const ctx = { stats, scraper, progress };
            return visibleMetrics
              .map(id => ALL_METRICS.find(m => m.id === id))
              .filter((m): m is MetricDef => !!m)
              .map(m => {
                const { value, sub } = m.get(ctx);
                const delta = fmtDelta(m, scraper);   // avancement /h (serveur)
                return (
                  <div
                    key={m.id}
                    className="relative flex flex-col justify-center h-[104px] overflow-hidden bg-slate-900/40 rounded-md px-3 py-2.5 border border-slate-800/60"
                  >
                    <span
                      title={m.info}
                      className="absolute top-1.5 right-2 text-[11px] leading-none text-slate-500 hover:text-slate-200 cursor-help select-none"
                    >ⓘ</span>
                    <div className={`text-2xl font-bold leading-tight truncate ${m.color}`}>{value}</div>
                    <div className="text-[11px] text-muted-foreground leading-tight truncate pr-3 mt-0.5">{m.label}</div>
                    {/* Delta dernière heure (serveur) — AGRANDI, coloré */}
                    {delta && (
                      <div className={`text-base font-semibold leading-tight truncate ${delta.positive ? 'text-green-400' : 'text-red-400'}`}>
                        {delta.text}
                      </div>
                    )}
                    {sub && <div className="text-[11px] text-slate-400 leading-tight truncate">{sub}</div>}
                  </div>
                );
              });
          })()}
        </div>

        {/* Barre de progression globale = IDs avec réponse fiable / 500M */}
        {(() => {
          const resolved = (stats?.total_players ?? 0) + (stats?.total_dead ?? 0);
          const pct = Math.min(100, (resolved / 800_000_000) * 100);
          return (
            <div className="mt-1">
              <div className="flex items-center justify-between text-sm font-medium text-muted-foreground mb-1.5">
                <span className="flex items-center gap-1.5">
                  Progression globale
                  <span
                    title="Nombre d'IDs ayant reçu une réponse fiable (joueur trouvé OU confirmé mort) sur la cible de 800M. Indépendant de la position des scanners (7 curseurs + retest)."
                    className="text-slate-500 hover:text-slate-200 cursor-help select-none"
                  >ⓘ</span>
                </span>
                <span className="font-bold text-lg text-purple-300">{fmt(resolved)} / 800M · {pct.toFixed(2)}%</span>
              </div>
              <div className="w-full bg-slate-800 rounded-full h-5 overflow-hidden relative">
                <div
                  className="bg-gradient-to-r from-indigo-500 via-purple-500 to-pink-500 h-full transition-all duration-500"
                  style={{ width: `${pct}%` }}
                />
              </div>
            </div>
          );
        })()}
      </>) : (
        /* ─── Vue Répartition : camembert + légende détaillée (live) ─── */
        <Card>
          <CardContent className="py-4">
            {(() => {
              const bd: Breakdown = breakdown ?? { f30: 0, existing: 0, lords: 0, dead: 0, pending: 0, totalScanned: 0 };
              // Total recalculé sur les seules catégories cochées (visibles)
              const totalVisible = BREAKDOWN_SEGMENTS
                .filter(s => !hiddenSegments.has(s.key))
                .reduce((sum, s) => sum + (bd[s.key] || 0), 0) || 1;
              return (
                <div className="flex flex-col md:flex-row items-center gap-5">
                  <DonutChart data={bd} hidden={hiddenSegments} />
                  <div className="flex-1 w-full grid grid-cols-1 sm:grid-cols-2 gap-2">
                    {BREAKDOWN_SEGMENTS.map(s => {
                      const val = bd[s.key] || 0;
                      const checked = !hiddenSegments.has(s.key);
                      const pct = checked ? (val / totalVisible * 100) : 0;
                      return (
                        <label key={s.key}
                          className={`flex items-start gap-2 rounded-md px-3 py-2 border cursor-pointer transition-opacity ${checked ? 'bg-slate-900/40 border-slate-800/60' : 'bg-slate-900/20 border-slate-800/40 opacity-50'}`}>
                          <input type="checkbox" checked={checked} onChange={() => toggleSegment(s.key)}
                            className="mt-1 shrink-0 accent-current" style={{ accentColor: s.color }} />
                          <span className="mt-1 w-3 h-3 rounded-sm shrink-0" style={{ background: s.color }} />
                          <div className="min-w-0">
                            <div className="flex items-baseline gap-2">
                              <span className="text-sm font-semibold" style={{ color: s.color }}>{checked ? pct.toFixed(2) + '%' : '—'}</span>
                              <span className="text-sm font-bold text-foreground">{fmt(val)}</span>
                            </div>
                            <div className="text-[11px] text-muted-foreground leading-tight">{s.label}</div>
                            <div className="text-[10px] text-slate-500 leading-tight">{s.desc}</div>
                          </div>
                        </label>
                      );
                    })}
                  </div>
                </div>
              );
            })()}
          </CardContent>
        </Card>
      )}
      </div>

      {/* Tabs */}
      <div className="flex gap-2 border-b">
        {(['overview', 'servers', 'search'] as const).map(t => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`px-3 py-1.5 text-sm font-medium capitalize border-b-2 transition-colors ${
              tab === t ? 'border-orange-400 text-orange-400' : 'border-transparent text-muted-foreground hover:text-foreground'
            }`}
          >
            {t === 'overview' ? 'Recent Players' : t === 'servers' ? 'Kingdoms' : 'Search'}
          </button>
        ))}
      </div>

      {/* Tab: Recent Players */}
      {tab === 'overview' && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm flex items-center gap-2">
                Recently Discovered
                <span className="text-[10px] font-normal text-red-400 flex items-center gap-1">
                  <span className="inline-block w-2 h-2 rounded-full bg-red-500" /> = ID retesté (avait échoué)
                </span>
              </CardTitle>
            </CardHeader>
            <CardContent className="p-0">
              <table className="w-full text-sm">
                <thead><tr className="border-b">
                  <th className="text-left p-2 text-xs text-muted-foreground font-medium">ID</th>
                  <th className="text-left p-2 text-xs text-muted-foreground font-medium">Nickname</th>
                  <th className="text-left p-2 text-xs text-muted-foreground font-medium">K</th>
                  <th className="text-left p-2 text-xs text-muted-foreground font-medium">F</th>
                  <th className="text-left p-2 text-xs text-muted-foreground font-medium">Seen</th>
                </tr></thead>
                <tbody>
                  {recentPlayers.slice(0, 15).map(p => (
                    <tr key={p.id} className="border-b last:border-0 hover:bg-muted/40">
                      <td className={`p-2 font-mono text-xs ${p.retested ? 'text-red-400 font-semibold' : 'text-muted-foreground'}`}
                          title={p.retested ? 'Cet ID avait donné une erreur, il a été retesté avec succès.' : undefined}>
                        {p.retested ? '🔴 ' : ''}{p.id}
                      </td>
                      <td className="p-2 font-medium max-w-[120px] truncate">{p.nickname}</td>
                      <td className="p-2"><Badge variant="outline" className="text-xs py-0">{p.kid}</Badge></td>
                      <td className="p-2 text-yellow-400 text-xs">{p.state_level > 0 ? '🔥' + fmtFurnace(p.state_level) : '—'}</td>
                      <td className="p-2 text-xs text-muted-foreground">{timeAgo(p.first_seen)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-2"><CardTitle className="text-sm">Recent Name Changes</CardTitle></CardHeader>
            <CardContent className="p-0">
              <table className="w-full text-sm">
                <thead><tr className="border-b">
                  <th className="text-left p-2 text-xs text-muted-foreground font-medium">ID</th>
                  <th className="text-left p-2 text-xs text-muted-foreground font-medium">Field</th>
                  <th className="text-left p-2 text-xs text-muted-foreground font-medium">Old</th>
                  <th className="text-left p-2 text-xs text-muted-foreground font-medium">New</th>
                  <th className="text-left p-2 text-xs text-muted-foreground font-medium">When</th>
                </tr></thead>
                <tbody>
                  {changes.slice(0, 15).map((c, i) => (
                    <tr key={i} className="border-b last:border-0 hover:bg-muted/40">
                      <td className="p-2 font-mono text-xs text-muted-foreground">{c.player_id}</td>
                      <td className="p-2 text-xs">{c.field}</td>
                      <td className="p-2 text-xs text-red-400 line-through max-w-[80px] truncate">{c.old_value}</td>
                      <td className="p-2 text-xs text-green-400 max-w-[80px] truncate">{c.new_value}</td>
                      <td className="p-2 text-xs text-muted-foreground">{timeAgo(c.changed_at)}</td>
                    </tr>
                  ))}
                  {changes.length === 0 && (
                    <tr><td colSpan={5} className="p-4 text-center text-muted-foreground text-xs">No changes recorded yet</td></tr>
                  )}
                </tbody>
              </table>
            </CardContent>
          </Card>
        </div>
      )}

      {/* Tab: Kingdoms */}
      {tab === 'servers' && (
        <div className="grid grid-cols-1 lg:grid-cols-[minmax(600px,1fr)_minmax(400px,1fr)] gap-4 items-start">

          {/* ── Liste kingdoms ── */}
          <Card>
            <CardHeader className="pb-2">
              <div className="flex items-center justify-between gap-2">
                <CardTitle className="text-sm">Kingdoms ({fmt(filteredServers.length)})</CardTitle>
              </div>
              <Input placeholder="Filter K…" value={srvFilter} onChange={e => setSrvFilter(e.target.value)} className="h-7 text-xs mt-2" />
            </CardHeader>
            <CardContent className="p-0">
              <div className="overflow-auto max-h-[70vh]">
                <table className="w-full text-sm">
                  <thead className="sticky top-0 bg-card z-10">
                    <tr className="border-b">
                      {([
                        { col: 'kingdom',        label: 'Kingdom'  },
                        { col: 'actif_count',    label: 'F30+'     },
                        { col: 'inactive_count', label: 'Inactive' },
                        { col: 'lord_count',     label: 'Lords'    },
                        { col: 'total_count',    label: 'Total'    },
                        { col: 'max_furnace',    label: 'Max F'    },
                        { col: 'avg_furnace',    label: 'Avg F'    },
                      ] as { col: keyof Server; label: string }[]).map(({ col, label }) => (
                        <th key={col} onClick={() => toggleSort(col)}
                          className="text-left p-2 text-xs text-muted-foreground font-medium cursor-pointer select-none hover:text-foreground whitespace-nowrap">
                          {label}<span className="opacity-40">{sortIcon(col)}</span>
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {filteredServers.map(s => (
                      <tr key={s.kingdom}
                        onClick={() => selectKingdom(s.kingdom)}
                        className={`border-b cursor-pointer transition-colors ${
                          selectedKingdom === s.kingdom ? 'bg-orange-950/40 border-l-2 border-l-orange-400' : 'hover:bg-muted/40'
                        }`}>
                        <td className="p-2 font-bold text-orange-400">K{s.kingdom}</td>
                        <td className="p-2 text-green-400 font-medium">{fmt(s.actif_count)}</td>
                        <td className="p-2 text-muted-foreground">{fmt(s.inactive_count)}</td>
                        <td className="p-2 text-muted-foreground">{fmt(s.lord_count)}</td>
                        <td className="p-2 text-muted-foreground">{fmt(s.total_count)}</td>
                        <td className="p-2 text-yellow-400 text-xs">{s.max_furnace ? fmtFurnace(s.max_furnace) : '—'}</td>
                        <td className="p-2 text-muted-foreground text-xs">{s.avg_furnace ? fmtFurnace(Math.round(s.avg_furnace)) : '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </CardContent>
          </Card>

          {/* ── Panneau détail kingdom ── */}
          {selectedKingdom === null ? (
            <Card>
              <CardContent className="flex items-center justify-center h-48 text-muted-foreground text-sm">
                ← Select a kingdom
              </CardContent>
            </Card>
          ) : (() => {
            const s = servers.find(x => x.kingdom === selectedKingdom);
            if (!s) return null;
            const totalPages = Math.ceil(kingdomTotal / 100);
            const visiblePlayers = kingdomPlayerSearch
              ? kingdomPlayers.filter(p => p.nickname.toLowerCase().includes(kingdomPlayerSearch.toLowerCase()))
              : kingdomPlayers;
            return (
              <Card>
                <CardHeader className="pb-3">
                  <div className="flex items-center gap-3 flex-wrap">
                    <CardTitle className="text-lg text-orange-400">K{s.kingdom}</CardTitle>
                    <div className="text-xs text-muted-foreground">
                      🔥 Max <span className="text-yellow-400 font-bold">{fmtFurnace(s.max_furnace)}</span>
                      {' · '}Avg <span className="text-muted-foreground">{fmtFurnace(Math.round(s.avg_furnace))}</span>
                    </div>
                  </div>
                  {/* KPIs */}
                  <div className="flex gap-3 flex-wrap mt-2">
                    {[
                      { label: 'Active F30+', val: fmt(s.actif_count),   color: 'text-green-400'  },
                      { label: 'Inactive',    val: fmt(s.inactive_count), color: 'text-muted-foreground' },
                      { label: 'Lords',       val: fmt(s.lord_count),     color: 'text-faint'      },
                      { label: 'Total',       val: fmt(s.total_count),    color: 'text-orange-400' },
                    ].map(k => (
                      <div key={k.label} className="bg-muted/30 rounded-lg px-3 py-2 text-center min-w-[80px]">
                        <div className={`text-lg font-bold ${k.color}`}>{k.val}</div>
                        <div className="text-xs text-muted-foreground">{k.label}</div>
                      </div>
                    ))}
                  </div>
                  {/* Filtres + recherche */}
                  <div className="flex gap-2 flex-wrap items-center mt-3">
                    {(['actifs','inactive','lords','all'] as const).map(f => (
                      <button key={f} onClick={() => setKingdomFilterAndLoad(f)}
                        className={`px-2 py-1 text-xs rounded-full border transition-colors ${
                          kingdomFilter === f
                            ? 'border-orange-400 text-orange-400 bg-orange-950/30'
                            : 'border-border text-muted-foreground hover:text-foreground'
                        }`}>
                        {f === 'actifs' ? 'Active F30+' : f === 'inactive' ? 'Inactive' : f === 'lords' ? 'Lords' : 'All'}
                      </button>
                    ))}
                    <Input
                      placeholder="Search nickname…"
                      value={kingdomPlayerSearch}
                      onChange={e => setKingdomPlayerSearch(e.target.value)}
                      className="h-7 text-xs w-36 ml-auto"
                    />
                  </div>
                </CardHeader>
                <CardContent className="p-0">
                  {kingdomLoading ? (
                    <div className="p-4 text-center text-muted-foreground text-xs">Loading…</div>
                  ) : (
                    <>
                    <div className="overflow-auto max-h-[50vh]">
                      <table className="w-full text-sm">
                        <thead className="sticky top-0 bg-card z-10">
                          <tr className="border-b">
                            {([
                              { col: 'id',          label: 'ID'        },
                              { col: 'nickname',    label: 'Nickname'  },
                              { col: 'state_level', label: 'Furnace'   },
                              { col: 'first_seen',  label: 'First Seen'},
                              { col: 'last_seen',   label: 'Last Seen' },
                            ]).map(({ col, label }) => (
                              <th key={col} onClick={() => setKingdomSortAndLoad(col)}
                                className="text-left p-2 text-xs text-muted-foreground font-medium cursor-pointer select-none hover:text-foreground whitespace-nowrap">
                                {label}
                                <span className="opacity-40 ml-0.5">
                                  {kingdomSort.col === col ? (kingdomSort.dir === 'asc' ? '↑' : '↓') : '↕'}
                                </span>
                              </th>
                            ))}
                          </tr>
                        </thead>
                        <tbody>
                          {visiblePlayers.map(p => {
                            const isLord = p.nickname.toLowerCase() === 'lord' + p.id;
                            return (
                              <tr key={p.id} className="border-b last:border-0 hover:bg-muted/40">
                                <td className="p-2 font-mono text-xs text-muted-foreground">{p.id}</td>
                                <td className="p-2">
                                  {isLord
                                    ? <span className="text-muted-foreground text-xs italic">lord{p.id}</span>
                                    : <span className="font-medium">{p.nickname}</span>
                                  }
                                </td>
                                <td className="p-2 text-yellow-400 text-xs font-medium">{p.state_level ? fmtFurnace(p.state_level) : '—'}</td>
                                <td className="p-2 text-xs text-muted-foreground">{timeAgo(p.first_seen)}</td>
                                <td className="p-2 text-xs text-muted-foreground">{timeAgo(p.last_seen)}</td>
                              </tr>
                            );
                          })}
                          {visiblePlayers.length === 0 && (
                            <tr><td colSpan={5} className="p-4 text-center text-muted-foreground text-xs">No players</td></tr>
                          )}
                        </tbody>
                      </table>
                    </div>
                    {/* Pagination */}
                    <div className="flex items-center justify-between px-3 py-2 border-t text-xs text-muted-foreground">
                      <span>Page {kingdomPage + 1} / {Math.max(totalPages, 1)} ({fmt(kingdomTotal)} total)</span>
                      <div className="flex gap-2">
                        <button onClick={() => changeKingdomPage(-1)} disabled={kingdomPage === 0}
                          className="px-2 py-1 rounded border border-border disabled:opacity-30 hover:border-orange-400 hover:text-orange-400">← Prev</button>
                        <button onClick={() => changeKingdomPage(1)} disabled={kingdomPage + 1 >= totalPages}
                          className="px-2 py-1 rounded border border-border disabled:opacity-30 hover:border-orange-400 hover:text-orange-400">Next →</button>
                      </div>
                    </div>
                    </>
                  )}
                </CardContent>
              </Card>
            );
          })()}
        </div>
      )}

      {/* Tab: Search */}
      {tab === 'search' && (
        <Card>
          <CardHeader className="pb-2"><CardTitle className="text-sm">Search Player</CardTitle></CardHeader>
          <CardContent>
            <div className="flex gap-2 mb-4">
              <Input
                placeholder="Nickname or Player ID…"
                value={search}
                onChange={e => setSearch(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && doSearch()}
              />
              <Button onClick={doSearch} size="sm">Search</Button>
            </div>
            {searchResults !== null && (
              searchResults.length === 0
                ? <p className="text-muted-foreground text-sm">No results.</p>
                : <table className="w-full text-sm">
                    <thead><tr className="border-b">
                      <th className="text-left p-2 text-xs text-muted-foreground font-medium">ID</th>
                      <th className="text-left p-2 text-xs text-muted-foreground font-medium">Nickname</th>
                      <th className="text-left p-2 text-xs text-muted-foreground font-medium">Kingdom</th>
                      <th className="text-left p-2 text-xs text-muted-foreground font-medium">Furnace</th>
                      <th className="text-left p-2 text-xs text-muted-foreground font-medium">Last Seen</th>
                    </tr></thead>
                    <tbody>
                      {searchResults.map(p => (
                        <tr key={p.id} className="border-b last:border-0 hover:bg-muted/40">
                          <td className="p-2 font-mono text-xs text-muted-foreground">{p.id}</td>
                          <td className="p-2 font-medium">{p.nickname}</td>
                          <td className="p-2"><Badge variant="outline" className="text-xs py-0">{p.kid}</Badge></td>
                          <td className="p-2 text-yellow-400 text-xs">{p.state_level > 0 ? '🔥' + fmtFurnace(p.state_level) : '—'}</td>
                          <td className="p-2 text-xs text-muted-foreground">{timeAgo(p.last_seen)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
            )}
          </CardContent>
        </Card>
      )}

    </div>
  );
}
