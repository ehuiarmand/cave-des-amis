# Copilot Instructions — Maquis Manager (Cave des Amis)

## Présentation du projet

Application web de gestion de bar/maquis/cave. Interface PWA en HTML/CSS/JS vanilla, serveur Python (stdlib uniquement), données persistées en JSON + SQLite, tunnel Cloudflare pour l'accès distant.

## Architecture

```
index.html          Interface principale (PWA)
app-orders.js       Logique front-end (version serveur API)
app.js              Logique front-end (version localStorage locale)
app-api.js          Utilitaires et point du jour
server.py           Serveur HTTP Python (pas de framework — stdlib uniquement)
data.json           Persistance principale des données
app.sqlite3         Base SQLite (sessions, audit log)
launcher.py         Démarre server.py + tunnel ngrok en local
demarrer.bat        Point d'entrée Windows
scripts/deploy.ps1  Déploiement vers le VPS via SSH
```

## Stack technique

- **Front-end** : HTML5, CSS3, JavaScript ES2020+ vanilla — pas de framework, pas de bundler
- **Back-end** : Python 3, `http.server` stdlib uniquement — pas de Flask, pas de FastAPI
- **Persistance** : `data.json` (état applicatif) + `app.sqlite3` (sessions/audit)
- **Auth** : Sessions côté serveur, cookies `maquis_manager_session`, mots de passe PBKDF2-SHA256
- **Déploiement** : VPS Hostinger, domaine `app.cave-des-amis.com`, HTTPS via Cloudflare

## Données et état

L'état applicatif (`state`) est un objet JSON avec ces collections :

- `ventes` — lignes de vente `{ id, siteId, date, article, cat, prix, qty, remise, paiement, debiteur? }`
- `charges` — dépenses `{ id, siteId, date, lib, cat, montant, paiement }`
- `stock` — articles `{ id, article, cat, init, entrees, seuilMin, prixAchat }`
- `commandes` — commandes fournisseurs
- `creditRecoveries` — remboursements crédit `{ id, siteId, date, paidAt, debiteur, montant, paiement, note }`
- `sites` — multi-établissements `{ id, nom, ... }`
- `nextId` — compteurs d'identifiants par collection

## Conventions de code

- **Langue** : interface et messages en français, code (variables, fonctions) en anglais ou français selon le contexte existant
- **Monnaie** : FCFA, formatage via `fmt()` (Intl.NumberFormat fr-FR)
- **Dates** : stockage ISO `YYYY-MM-DD`, affichage `DD-MM-YYYY` via `formatDateDdMmYyyy()`
- **Paiements crédit** : `isCreditClientMethod()` et `isAReglerPaiement()` pour détecter les créances
- **Multi-site** : filtrer toujours avec `recordsForSite()` avant d'accéder aux collections
- **Persistance front** : toujours appeler `persistState()` après modification de `state`
- **Persistance back** : `data.json` écrit atomiquement (fichier tmp + rename)

## Modes de paiement

```js
["Espèces", "Orange Money", "MTN MoMo", "Wave", "Carte", "Crédit client"]
```

`"Crédit client"` et `"A regler"` sont des créances — exclues de la recette encaissée, incluses dans `caCreances`.

## Point du jour (renderPointDuJour)

- `caEncaisse` = ventes du jour hors crédit + remboursements crédit (`creditRecoveries`) du jour
- `caCreances` = ventes "Crédit client" du jour
- Les `creditRecoveries` du jour sont ajoutés à `caEncaisse` et au graphique de répartition

## Sécurité

- Ne jamais exposer les mots de passe en clair
- Les sessions expirent après 8 h (`SESSION_TTL_SECONDS`)
- Toujours valider `siteId` côté serveur avant d'écrire des données
- Échapper systématiquement les valeurs HTML avec `escapeHtml()` côté front

## Ce qu'il ne faut pas faire

- Ne pas introduire de dépendances npm ou pip — le projet est volontairement sans dépendances
- Ne pas utiliser `localStorage` dans `app-orders.js` — les données sont côté serveur
- Ne pas modifier `data.json` directement — passer par l'API `PUT /api/state`
- Ne pas casser la compatibilité des champs existants dans `data.json` (migration douce uniquement)
