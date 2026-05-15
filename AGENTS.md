# Agents — cave-des-amis (Maquis Manager)

Consignes pour tout agent IA sur ce dépôt. **Lire ce fichier et les règles Cursor avant toute modification.**

## Contexte réel (ne pas supposer Flask/Django)

| Couche | Fichiers |
|--------|----------|
| Serveur HTTP | `server.py` — `ThreadingHTTPServer`, API JSON, sessions cookie `maquis_manager_session` |
| Données | `data.json` par défaut ; option `MAQUIS_MANAGER_STORAGE=sqlite` → `app.sqlite3` |
| Front principal | `index.html`, `app-orders.js`, `app-api.js`, `styles.css` |
| Autre front | `app.js` + `order.html` / `order.js` (commandes QR) |
| Déploiement | `scripts/deploy.ps1`, `.github/workflows/` |

Application de gestion multi-maquis : stock, ventes, PDJ, recouvrement crédit, charges, utilisateurs.

## Règles Cursor (obligatoires)

| Fichier | Portée | Points clés |
|---------|--------|-------------|
| `.cursor/rules/security.mdc` | Toujours | Droits **côté serveur** ; anti-IDOR ; pas de secrets en dur ; XSS ; routes sensibles par rôle ; actions destructives confirmées + journalisées ; déconnexion propre |
| `.cursor/rules/code-architecture.mdc` | Toujours | Lire le contexte ; patch minimal ; pas de refactor hors scope ; réutiliser l’existant ; noms explicites |
| `.cursor/rules/ui-ux.mdc` | Fichiers front listés | Mobile-first ; labels/erreurs clairs ; confirmation actions importantes ; cohérence visuelle |

**Priorités :** Sécurité > Fonctionnel > UX > Performance

## Carte des responsabilités

- **Autorisation / fusion d’état :** `server.py` — `require_session`, `session_is_superadmin`, `compute_global_superadmin`, `merge_auth_users_scoped`, filtrage par `allowedSiteIds`
- **Superadmin global vs scopé :** global = tous les maquis (ou comptes protégés `admin` / `tanoh`) ; scopé = droits limités aux maquis cochés
- **Sync client :** `app-api.js` — login, `PUT /api/state`, polling `/api/changes`
- **UI métier :** `app-orders.js` — PDJ, recouvrement, paramètres utilisateurs ; incrémenter `?v=` dans `index.html` après changement JS

## Checklist avant de livrer

1. Lire les fichiers touchés par la fonctionnalité (serveur + front).
2. Vérifier que **chaque** nouvelle route ou branche `PUT` valide session, rôle et périmètre maquis sur le serveur.
3. Ne pas faire confiance au client pour `role`, `allowedSiteIds`, `siteId` — le serveur recalcule / filtre.
4. Affichage HTML dynamique : utiliser `escapeHtml()` (déjà dans `app-orders.js` / `app.js`).
5. Suppression / restauration / purge : `window.confirm` côté UI + `audit_log()` côté serveur si action sensible.
6. Changement JS cache-bust : `index.html` → `app-orders.js?v=…`
7. Messages d’erreur utilisateur : génériques (« Accès refusé », « La modification n'a pas été sauvegardée… ») — pas de stack trace.
8. Signaler toute anomalie de sécurité hors scope sans la corriger silencieusement si non demandé.

## Sécurité CSRF

- Jeton `csrfToken` par session (réponse login / `/api/session`), en-tête `X-CSRF-Token` sur `POST`/`PUT` via `apiRequest` (`app-orders.js`, `app-api.js`).
- Validé côté serveur (`require_csrf`) sur `PUT /api/state` et routes admin sensibles.
- En HTTPS prod : `MAQUIS_MANAGER_COOKIE_SECURE=1` pour le cookie `Secure`.
- **SQL :** requêtes paramétrées dans le mode SQLite ; pas d’ORM.
- **Secrets :** variables d’environnement pour prod (voir `deploy.local.env.example`, `README-ROBUSTESSE.md`).

## Tests manuels rapides (après changement métier)

1. Connexion superadmin **scopé** (1 maquis) → Paramètres → enregistrement sans toast d’échec.
2. Recouvrement : « Total dû » ≈ PDJ « Reste à recouvrer » ; versement espèces reflété au théorique caisse du jour comptable.
3. Ctrl+F5 + redémarrage `python server.py` si le serveur a changé.

## Backlog GitHub (recommandations issues)

Dépôt : [github.com/ehuiarmand/cave-des-amis/issues](https://github.com/ehuiarmand/cave-des-amis/issues)

Chaque issue contient **Problème**, **Solution recommandée** et **Critères d'acceptance**. Pour appliquer une recommandation :

1. Lire l'issue (corps + commentaires) — API : `https://api.github.com/repos/ehuiarmand/cave-des-amis/issues/{num}`
2. Implémenter la solution en respectant les critères (cases à cocher)
3. Référencer l'issue dans le message de commit : `fix: … (#8)`
4. Ne pas fermer l'issue sur GitHub sauf demande explicite de l'utilisateur

| Priorité | # | Sujet |
|----------|---|--------|
| CRITIQUE | 2 | Masquer « JSON local » en production |
| CRITIQUE | 3 | Confirmation suppression charge |
| CRITIQUE | 4 | Confirmation perte stock |
| CRITIQUE | 5 | Alerte comptes sans 2FA |
| IMPORTANT | 6–11 | PDJ, ventes TABLE, charges, stock |
| UTILE | 12–15 | Filtres stock, guide, export CSV, objectif mensuel |

Issues déjà traitées dans le code local : voir commits récents ou comparer avec les critères d'acceptance.

## Documentation complémentaire

- `README-ROBUSTESSE.md` — sync, anti brute-force, SQLite, sauvegardes
- `GUIDE_UTILISATION.md` / `CAHIER_DES_CHARGES.md` — métier
