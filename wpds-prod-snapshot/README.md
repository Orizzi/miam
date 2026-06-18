# WPDS — WOS Player Data Scraper

Scraper distribué qui explore l'intégralité des IDs joueurs de **Whiteout Survival** (WOS) et
construit une base de données complète (joueurs, IDs morts, changements de pseudo, royaumes),
avec un dashboard temps réel.

## À quoi ça sert

L'API WOS (`wos-giftcode-api.centurygame.com/api/player`) permet de récupérer les infos d'un
joueur par son `fid`. Le scraper teste **tous les IDs de 1 à 800 M** pour découvrir chaque joueur
existant et marquer les IDs morts, en garantissant que **chaque ID reçoit une réponse fiable**
(joueur trouvé OU confirmé mort), avec retest automatique des erreurs réseau.

## Architecture

```
8 conteneurs Docker (wpds1..8) — DB SQLite UNIFIÉE /opt/wpds/data/players.db
  ├── wpds1..3, wpds5..8 : SCAN (plages disjointes 1→800M, curseur cursor_inst_<id>)
  └── wpds4              : RETRY_ONLY (retest des error_ids en priorité)

Chaque conteneur (scraper.mjs) :
  modèle PULL — N workers tirent le prochain ID (nextScanId, skip des IDs déjà connus
  par blocs SQL de 50k) → probeId → fetchPlayerViaProxy → écrit en DB
     ├── found  → players      (+ resolveError)
     ├── dead   → dead_ids      (200 « role not exist »)
     └── erreur → error_ids     → RETESTÉ (couverture garantie, aucun ID perdu)

Transport (proxy.mjs), 3 modes via env PROXY_MODE :
  • tor    : TOR pur — circuit isolé par port SOCKS (multi-process tor@default/b..h)
  • hybrid : proxies publics PRIORITAIRES + TOR en fallback
  • proxy  : proxies publics seuls

API + dashboard :
  wpds-api-server.mjs (port 4250, cache 1s) → Nginx /WPDS/ → dashboard Next.js
  (dashboard.orizzi.io/dashboard/wos-players)
```

### Fichiers clés (`src/`)

| Fichier | Rôle |
|---|---|
| `scraper.mjs` | Boucle principale : modèle pull, workers, curseurs, couverture, métriques |
| `proxy.mjs` | Pool de transport : TOR + proxies publics, cadence/proxy, accumulation, sources |
| `api.mjs` | Requêtes WOS : headers complets + signature MD5, `fetchPlayerViaProxy` |
| `db.mjs` | SQLite (players, dead_ids, error_ids, scan_state, …) |
| `dashboard.mjs` | API REST/WS interne |
| `../wpds-api-server.mjs` | API publique du dashboard (stats, curseurs, débit/source, deltas /h) |

## Configuration OPTIMALE trouvée (meilleur débit)

> **Meilleur débit stable mesuré : ~160 IDs/s** — configuration **TOR pur, 8 instances multi-process.**

| Réglage | Valeur optimale | Pourquoi |
|---|---|---|
| Transport | **TOR pur** (`PROXY_MODE=tor`) | Plus efficace au cœur CPU que les proxies gratuits sur ce serveur (6 cœurs) |
| Process tor | **8** (`tor@default`,`b`..`h`), 100 SocksPort chacun (30000-30799) | 1 process tor sature à ~100-150 circuits ; multi-process = parallélisme réel |
| Isolation | 1 circuit par port (SOCKS auth `userId=p<port>`) | Stream-isolation `IsolateSOCKSAuth` |
| Workers | **1 / circuit** (`WORKERS_PER_PROXY=1`, ~100/instance) | Mesuré : +de workers/circuit → contention TOR → timeouts |
| Headers WOS | UA aléatoire + Origin + Referer + Accept + Content-Type | **Sans eux → 403** (ce n'est PAS un blocage IP) |
| Requête | 1 tentative, timeout 8s | Circuit lent → on logge pour retest (ne bloque pas le worker) |
| CPU | `cpus: 0.5`/conteneur | **Isolation** : laisse du CPU aux autres projets du serveur |

Débit historique : **2,5/s (1 process tor) → ~160/s (8 process)** = ×64.

### Mode proxy hybride (expérimental — branche `feat/proxy-hybride`)

Étudié en profondeur (nuit 19/06). Le **paramétrage des requêtes est parfait** (0 rejet WOS).
Découverte clé : **ProxyScrape filtré `timeout=2000`** + listes vérifiées (databay-labs, ClearProxy,
proxifly) donnent des proxies à ~2 s. Système : cadence par proxy (anti-429), accumulation
persistée, cache d'agents keep-alive, pénalité d'échec progressive.
**Plafond mesuré : ~33 IDs/s par instance** (cpus=2), limité par (a) ~50 % des proxies gratuits
qui timeoutent sous usage, (b) le CPU (handshakes TLS). → Sur ce serveur 6 cœurs, **TOR reste
plus efficace**. Le mode hybride deviendrait gagnant avec des **proxies payants** (rapides/fiables)
— le code est prêt à les accueillir (injecter leurs endpoints dans le pool).

## Exploitation

```bash
# Déployer un fichier source
scp src/scraper.mjs ubuntu@<srv>:/tmp/ && \
  ssh ubuntu@<srv> "sudo docker cp /tmp/scraper.mjs wpds1:/app/src/scraper.mjs && sudo docker restart wpds1"

# Rebuild image (persiste code + deps)
ssh ubuntu@<srv> "cd /opt/wpds && sudo docker compose build wpds1 && sudo docker compose up -d wpds1"

# Stats DB
docker exec wpds1 node -e "const db=require('better-sqlite3')('/app/data/players.db');\
console.log('players',db.prepare('SELECT COUNT(*) c FROM players').get().c);db.close();"
```

Point de restauration stable : tag git **`tor-8inst-stable`**.
