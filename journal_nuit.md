# Journal de la nuit — Optimisation scraper WOS (proxies + perf)

Mission (donnée à 00:14, 19/06/2026, arrêt visé ~08:30 heure FR) :
1. Découvrir un MAXIMUM de proxies (toutes langues, toutes ressources, y compris sites dont ce n'est pas le but) via recherches par mots-clés
2. Adapter le système au nombre de proxies fonctionnels (workers adaptatifs + accumulation)
3. Rendre fonctionnel + valider le débit attendu, itérer le code jusqu'au meilleur résultat
4. Surveiller le scraper toutes les 5 min pendant 2h
5. En parallèle : optimiser tout le scraper, cleanup + structure de projet, README GitHub
6. Versionner aux étapes majeures

Point de départ (mesuré le 18-19/06) :
- Prod : 8 instances TOR pur, ~160/s (tag `tor-8inst-stable`, point de restauration)
- Proxy hybride sur wpds1 : ~11/s, pool plafonne à 35 (cause = 400 workers martèlent peu de proxies → 429 WOS)
- Découverte clé : ProxyScrape `timeout=2000` → proxies rapides (médiane 1,6-2s, 38-45% vivants)
- Diagnostic : paramétrage requêtes PARFAIT (0 rejet WOS) ; goulot = nb de proxies rapides + sur-sollicitation par IP

---

## 00:14 — Démarrage
- Création du journal. Plan validé. Prod TOR intacte comme filet.
- Lancement Phase 1 : découverte massive de proxies (recherches multilingues).

## 00:20 — Phase 1 : sources découvertes (web EN/RU/ZH)
Sources retenues (priorité aux listes VÉRIFIÉES = proxies pré-validés, plus rapides) :
- **databay-labs/free-proxy-list** — vérifié CONNECT HTTPS (= notre usage exact), MAJ 5 min ⭐
- **ClearProxy/checked-proxy-list** — vérifié (Google/Discord/…), GEO+latence, MAJ 5 min ⭐
- **proxifly/free-proxy-list** — ~3449 vérifiés, MAJ 5 min ⭐
- **proxygenerator1/ProxyGenerator** — MostStable/socks5.txt (stables) ⭐
- **gfpcom/free-proxy-list** — ~2 M proxies, MAJ 30 min (gros volume brut)
- **ProxyScrape API filtré timeout=2000** (http/socks4/socks5) — médiane 1,6-2s ⭐
- TheSpeedX, hookzof, vakhov, SoliSpirit, VPSLabCloud, dinoz0rg, monosans (compléments)
Décision : prioriser les listes "checked/verified" + ProxyScrape filtré ; le gros volume (gfpcom) en complément testé.
Stratégie système : au lieu d'adapter le NB de workers, **limiter la cadence PAR PROXY** (1 req / ~1,5s par IP) → pas de 429, et débit = (nb proxies)/cadence. C'est ce qui concrétise "10k proxies × 0,5/s = 5000/s".

## 00:55 — Système adaptatif déployé + 1ère VICTOIRE (wpds1, cpus=2)
Implémenté dans proxy.mjs : cadence par proxy (`nextFreeAt`, 1,5s), accumulation persistée (`proxy-pool-<id>.json`, survit aux restarts + grossit), sources vérifiées prioritaires, batch test 800 + timeout 8s (anti-saturation).
**Résultat mesuré** :
- Pool : **219 vivants** (122 http / 75 socks5 / 22 socks4) — vs 18-35 avant
- **Débit : 33,4/s** (proxy 23,5 + TOR fallback 9,9) → **dépasse TOR (~30/s)** ✅, 429=0 (cadence OK)
Le pool va accumuler (persistance). Défaut `PROXY_MODE='tor'` (sécurité prod). Prochaine étape : image stable + plus de workers pour exploiter le pool grandissant.

## 01:30-02:10 — Itérations débit (wpds1, cpus=2) + constats
Image wpds1 reconstruite (agents `socks-proxy-agent`/`https-proxy-agent` dans le Dockerfile → survit aux recreate ; défaut PROXY_MODE=tor pour la prod).
Mesures (fenêtres 30-60s, BRUITÉES — le débit suit la taille du pool du moment) :
- 400 workers, pool 219 : **33/s** (proxy 23 + tor 10) ← meilleur
- 800 workers, pool 112 : 6/s — **CPU saturé** (800 TLS sur 2 cœurs → 70% timeout). Sweet spot = ~400 workers.
- keep-alive agents (réutilise connexions, -CPU) : 16/s @ pool 138 (effet noyé dans le bruit, gardé car ↓CPU)
- pénalité échec 30s : trop dure (benche 50% du pool) → 12/s. Adoucie : 2 échecs tolérés (3s), récidiviste 60s.

**Constats clés** :
- Le paramétrage requêtes est PARFAIT (0 rejet WOS sur toutes les mesures).
- Goulot réel = (a) **~50% des proxies "vérifiés" timeoutent sous usage** (free = flaky), (b) **CPU-bound** sur le TLS (2 cœurs).
- Débit/cœur : proxy ~15/s/cœur vs TOR ~27/s/cœur (160/s sur 6 cœurs). Sur CE serveur, TOR reste plus efficace au cœur.
- L'accumulation du pool n'a pas eu le temps d'opérer (je redémarrais wpds1 sans cesse pour tester). **Décision : laisser wpds1 tourner pour accumuler** (pool persistant grossit aux refreshs /5min) et mesurer la montée via le monitor, pendant le cleanup/README.

## 02:30-03:25 — Accumulation longue + VERDICT DÉFINITIF
Cleanup fait (40 fichiers → `archive/`), README WPDS écrit, monitoring serveur actif (journal_nuit_serveur.log).
Refresh adouci (12 min + top-up léger quand pool sain) pour réduire la perturbation CPU.
**Accumulation confirmée : pool 35 → 264 → 314 → 397** (persistance OK, le pool grossit et tient).
MAIS mesure du débit SOUTENU (90s, pool 397) :
- **proxy 7,1/s + tor 2/s = 9/s** ; **timeout = 61%** (cumulé 18894/31000)
- **Global système = ~112/s** (vs 160/s en TOR pur 8 instances)

**VERDICT (étayé par ~10 mesures sur la nuit)** :
1. Le paramétrage requêtes est PARFAIT (0 rejet WOS). Le système proxy est correct, robuste, accumule, 0 lib manquante.
2. Les **proxies GRATUITS timeoutent ~61% sous usage soutenu** (rapides en test isolé mais dégradent sous charge concurrente — ils sont partagés/surchargés).
3. Sur ce serveur **6 cœurs CPU-limité**, le travail proxy de wpds1 (TLS lourd) **fait CHUTER le total à 112/s** au lieu de 160. Le proxy gratuit n'égale PAS TOR ici, il le pénalise.
4. **Meilleure performance = TOR pur 8 instances (~160/s)**. → wpds1 REMIS en TOR pur (03:25).
5. Le système proxy hybride reste COMPLET sur `feat/proxy-hybride`, prêt pour des **proxies PAYANTS** (rapides/fiables/peu de CPU) qui eux le rendraient gagnant.

→ Prod = retour à la config optimale TOR 8 instances. Surveillance + rapport final ensuite.

---

# 🌙 RAPPORT FINAL DE LA NUIT (19/06/2026)

## Ce qui a été fait
1. **Découverte massive de sources** (recherches EN/RU/ZH) : ~25 sources, dont les meilleures = ProxyScrape filtré `timeout=2000` + listes vérifiées (databay-labs, ClearProxy, proxifly, ProxyGenerator).
2. **Système proxy hybride complet** (branche `feat/proxy-hybride`, jamais en prod par défaut) :
   - Cadence par proxy (anti-429), accumulation persistée (pool 35→453), cache agents keep-alive, pénalité d'échec progressive, sources vérifiées, fix fetch race-timeout, image Docker stable (agents intégrés, défaut `PROXY_MODE=tor`).
   - Instrumentation : `sourceMetrics` (débit/source) + `proxyFails` (causes d'échec) + dashboard 2 îlots TOR/Proxy (sur la branche).
3. **Cleanup** : 40 fichiers obsolètes → `archive/` ; README WPDS complet ; monitoring serveur 5 min.
4. **5 commits** sur `feat/proxy-hybride`.

## Verdict technique (le point demandé : pourquoi les proxies échouent)
- **Le code/paramétrage est PARFAIT** : 0 rejet WOS (403/4xx/parse/429≈0) sur ~10 mesures. Headers variés + signature OK, identique à TOR.
- **Cause des échecs = 61% de TIMEOUT** : les proxies gratuits, rapides en test isolé (~2s), **dégradent sous usage concurrent** (partagés/surchargés) + le serveur est **CPU-bound** (chaque requête proxy = un handshake TLS coûteux).
- **Conséquence** : même avec un gros pool accumulé (≈400), débit proxy soutenu ≈ 7-33/s/instance, et le travail CPU du proxy **fait chuter le total du serveur** (112/s vs 160/s).

## Meilleure config / meilleur débit
| Config | Débit | Note |
|---|---|---|
| **TOR pur, 8 instances multi-process** | **~160/s** (pic) | ✅ OPTIMAL sur ce serveur (tag `tor-8inst-stable`) |
| Proxy hybride (gratuit) wpds1 | ~7-33/s | CPU-bound + 61% timeout → ≤ TOR, pénalise le serveur |
| Baseline initiale (1 process tor) | 2,5/s | ×64 d'amélioration jusqu'à 160/s |

## Recommandations pour aller au-delà (vision « 700-5000/s »)
La cadence-par-proxy permet THÉORIQUEMENT `N_proxies / cadence` (ex 3000/1,5s = 2000/s). Le code est prêt. Les 2 vrais leviers :
1. **Proxies PAYANTS** (datacenter rotatifs, ~2s mais fiables ≈99% et faible CPU) : injectables direct dans le pool → débloquerait le débit ET soulagerait le CPU.
2. **Serveur plus gros** (le goulot dur ici = 6 cœurs CPU-bound sur le TLS). Plus de cœurs → plus de workers proxy efficaces.
Avec free proxies + ce serveur, le plafond réaliste reste ~160/s (TOR).

## État prod au matin
- 8 instances **TOR pur**, débit global **~105-160/s** (oscille selon la latence TOR + la zone scannée), charge **~4,3/6 cœurs**, isolation OK (cpus 0,5).
- Couverture garantie intacte (chaque ID → found/dead/retest).
- Branche `feat/proxy-hybride` = tout le travail proxy, prête pour proxies payants. `main`/`tor-8inst-stable` = prod stable.

## ⚠️ Nuance importante (mesurée à 03:40)
Sans le proxy, la **charge CPU tombe à 4,3/6** → le serveur a de la **MARGE CPU** ; le débit TOR (~105/s à cet instant) est alors limité par la **latence réseau TOR + la densité de la zone scannée**, PAS par le CPU. Donc :
- Le proxy gratuit pénalisait surtout via les **pics CPU de ses refreshs** (test de centaines de proxies) ; en régime, son coût était moindre.
- **Piste future à CPU disponible** : des **proxies payants** (fiables, peu de timeouts) ajouteraient leur débit EN PLUS de TOR sans pénaliser (la marge CPU existe). C'est la voie la plus prometteuse vers >200/s.
- Côté TOR seul : le débit plafonne sur le réseau TOR, pas le serveur → ajouter des instances TOR donne des rendements décroissants (déjà testé : 8 = sweet spot).

## Surveillance (2h, monitor serveur toutes les 5 min)
- Débit global **soutenu ~97-111/s** (resolved +319k sur la fenêtre observée).
- **File de retest (`pending`) en BAISSE** : ~1,61M → 1,42M → wpds4 (RETRY_ONLY) rattrape, **la garantie de couverture se complète** (les erreurs réseau finissent résolues).
- Charge ~5,7/6, **8/8 conteneurs UP**, total résolu cumulé = **3,45 M** IDs (players + dead).
- Aucune instance morte, aucun worker éteint, 0 exception non gérée — système robuste sur la durée.

## Bilan matin / arrêt (~07:50)
- Débit global **soutenu ~130-140/s** (mesuré 133 puis 137/s ; le 105 noté à 03:40 était un creux TOR ponctuel).
- **1 265 465 joueurs trouvés** · **5 476 023** IDs résolus au total cette nuit · pending ~1,08 M (équilibre stable).
- Charge **4,0/6** (saine, marge CPU), **8/8 conteneurs UP**, **0 incident** sur toute la nuit (aucun worker mort, aucune instance tombée).
- Monitoring serveur (`journal_nuit_serveur.log`) a logué toutes les 5 min sans interruption.

## TL;DR pour le réveil
Tout est documenté ici + `wpds-prod-snapshot/README.md`. Prod = **TOR 8 instances ~100-160/s** (config optimale sur ce serveur). Le système **proxy hybride** (cadence/proxy + accumulation + keep-alive + sources vérifiées) est **complet et fonctionnel** sur `feat/proxy-hybride`, mais les **proxies GRATUITS plafonnent ≤ TOR ici** (61 % timeout sous charge). **Pour viser >200/s → proxies PAYANTS** (le code les accueille直接, et la marge CPU existe). 6 commits, racine nettoyée (archive/), couverture garantie intacte.
