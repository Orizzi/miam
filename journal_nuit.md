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
