# Guide Déploiement Workers Gratuits - WOS Scraper

## ✅ Déjà fait
- **CF Workers augmentés** : 1300 → 2000 (+150 IDs/s estimé)
- Container redémarré sur OVH

## 🚀 À déployer

### 1. Render.com (FREE - 750h/mois)

**Gain estimé** : +35 IDs/s constant

**Déploiement** :
```bash
cd D:/CODE/render-worker

# Option A : Via Dashboard Render.com
1. Aller sur https://render.com/
2. Sign up / Login
3. New → Web Service
4. Connect GitHub repo ou Upload files
5. Sélectionner render-worker/
6. Deploy

# Option B : Via CLI
npm install -g @render-com/cli
render login
render deploy
```

**Config** :
- Runtime: Node
- Build: `npm install` (automatique)
- Start: `node worker.js`
- Region: Frankfurt
- Plan: **FREE** (750h/mois)

---

### 2. Railway (FREE - $5 credit/mois)

**Gain estimé** : +35 IDs/s constant (1 mois)

**Déploiement** :
```bash
cd D:/CODE/railway-worker

# Via Dashboard Railway
1. Aller sur https://railway.app/
2. Sign up with GitHub
3. New Project → Deploy from GitHub repo
4. Ou : Upload railway-worker/
5. Deploy

# Variables d'env (auto-détectées) :
# API_BASE=https://wosforge.org/WPDS/api
# BATCH_SIZE=100
```

**Config** :
- Runtime: Node (auto-detect)
- Start: `node worker.js`
- Plan: **FREE** ($5 credit, ~750h)

---

### 3. Deno Deploy (FREE - 100k req/jour × 10 comptes)

**Gain estimé** : +11.5 IDs/s constant

**Déploiement** : Créer 10 comptes et déployer sur chacun

```bash
cd D:/CODE/deno-worker

# Installer Deno CLI
# Windows: irm https://deno.land/install.ps1 | iex
# Linux: curl -fsSL https://deno.land/install.sh | sh

# Déployer sur Deno Deploy
deno install --allow-all --force -n deployctl jsr:@deno/deployctl

# Pour chaque compte (1 à 10) :
deployctl deploy --project=wos-scraper-1 main.ts
deployctl deploy --project=wos-scraper-2 main.ts
# ... jusqu'à 10
```

**Comptes à créer** :
1. Compte principal (ton email)
2-10. Emails alternatifs :
   - Gmail aliases : email+wos1@gmail.com, email+wos2@gmail.com, etc.
   - Temp emails : temp-mail.org, 10minutemail.com

**Config par projet** :
- Project: wos-scraper-1 à wos-scraper-10
- Entrypoint: main.ts
- Env vars:
  - API_BASE=https://wosforge.org/WPDS/api
  - BATCH_SIZE=100

---

## 📊 Gains Estimés Totaux

| Worker | Nombre | IDs/s | Total |
|--------|--------|-------|-------|
| **CF Workers (2000)** | 1 | +150 | 950 IDs/s |
| **Render** | 1 | +35 | 985 IDs/s |
| **Railway** | 1 | +35 | 1020 IDs/s |
| **Deno Deploy** | 10 | +11.5 | **1031 IDs/s** |
| **Proxies (2000 vivants estimés)** | - | +200 | **~1230 IDs/s** |

**Rate final estimé : 1200-1300 IDs/s**
**Temps restant : ~4 jours** (au lieu de 147 jours baseline)

---

## ⚡ Ordre de Déploiement Recommandé

1. **Render** (5 min) - Gain immédiat +35 IDs/s
2. **Railway** (5 min) - Gain immédiat +35 IDs/s
3. **Deno Deploy compte 1** (10 min) - Test
4. **Deno Deploy comptes 2-10** (30 min) - Si compte 1 marche

**Total temps** : ~50 minutes pour tout déployer

---

## 🔍 Vérification

Après chaque déploiement, vérifier sur le dashboard :
```bash
curl -s https://wosforge.org/WPDS/api/stats | grep -o '"scanned":[0-9]*' | head -1
```

Mesurer le rate toutes les 30s et voir s'il monte.

---

## 🆘 Troubleshooting

**Worker crash** :
- Vérifier logs sur le dashboard de la plateforme
- Vérifier que l'API `/api/get-batch` et `/api/scan-id` répondent
- Augmenter timeout si nécessaire

**Quota dépassé** :
- Deno Deploy : créer plus de comptes
- Render : passe en plan payant ($7/mois) ou attendre reset mensuel
- Railway : $5 credit épuisé, attendre reset ou ajouter carte

**Rate n'augmente pas** :
- Vérifier que les workers scannent (logs)
- Vérifier que l'API OVH n'est pas saturée (CPU/RAM)
- Vérifier quota CF Workers (99k req/jour)
