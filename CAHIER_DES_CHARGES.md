# Cahier des charges — Maquis Manager

**Projet** : application web de pilotage opérationnel et financier pour maquis / bars / caves (ventes, stock, achats, casiers physiques, charges).  
**Nom produit** : **Maquis Manager** (interface et manifeste PWA).  
**Documentation associée** : [GUIDE_UTILISATION.md](GUIDE_UTILISATION.md), [guide.html](guide.html) (guide utilisateur imprimable).

---

## 1. Contexte et objectifs

### 1.1 Contexte d’usage

Les établissements concernés gèrent des ventes au comptoir ou à table, un stock de boissons (souvent avec séparation **frigo / réserve**), des **commandes fournisseurs**, des **charges** d’exploitation, et lorsque c’est pertinent un **parc de casiers physiques** (pleins, partiels, vides) lié aux achats et au réapprovisionnement.

### 1.2 Objectifs métier

- Centraliser **ventes**, **stocks**, **achats**, **crédits clients et fournisseurs**, **consignes / reliquats**, et **charges** sur un même outil.
- Permettre le **pilotage journalier** (point du jour, clôture, vérification stock) et le **tableau de bord** synthétique.
- Supporter le **multi-établissements** (plusieurs « sites » / maquis) avec bascule de contexte.
- Offrir une interface **ordinateur et mobile** (navigation adaptée, tableaux défilables).

### 1.3 Hors périmètre (implicitement)

- Comptabilité générale complète, paie détaillée, gestion fiscale avancée : non couverts ; l’outil reste orienté **opérationnel** et **trésorerie** simple (FCFA, modes de paiement).
- Déploiement cloud managé : le déploiement type reste **serveur local** opéré par l’établissement (voir §6).

---

## 2. Utilisateurs et rôles

### 2.1 Profils

Le système distingue au minimum les rôles suivants (libellés et droits effectifs portés par le compte utilisateur) :

| Rôle (technique) | Intitulé usuel | Usage typique |
|------------------|----------------|----------------|
| `serveuse` | Serveuse / serveur | Saisie commandes, consultation limitée du point du jour selon écrans |
| `gerant` | Gérant | Pilotage quotidien, ouverture caisse / clôture, validation stock |
| `manager` | Manager | Gestion étendue (paramètres catalogue / accès selon masques UI) |
| `admin` | Administrateur | Sites, utilisateurs, réouverture journée clôturée, administration données |
| `superadmin` | Super administrateur | Correction date de journée PDJ, actions d’administration sensibles, compte technique réservé |

Les éléments d’interface portent des classes du type `manager-only`, `any-admin`, `superadmin-only` : **tout écran ou bouton non affiché est considéré comme interdit** pour le rôle courant.

### 2.2 Multi-utilisateurs et sites

- Chaque utilisateur peut être limité à un ensemble de **`siteId`** autorisés.
- Le **sélecteur de site** en en-tête fixe le contexte de toutes les données affichées et enregistrées.

---

## 3. Périmètre fonctionnel par module

### 3.1 Authentification et session

- **Connexion** : identifiant + mot de passe ; mots de passe stockés avec dérivation **PBKDF2** (serveur), compatibilité éventuelle avec ancien hachage documentée côté implémentation.
- **Sessions HTTP** : cookie de session avec **TTL** configurable (ex. 8 h), déconnexion explicite.
- **Limite de tentatives** sur la route de login : protection contre bruteforce (backoff par IP + utilisateur).
- **2FA (TOTP)** : secret Base32, vérification ±1 pas de temps ; routes d’activation / désactivation / vérification à la connexion.

### 3.2 Tableau de bord

- Indicateurs : **CA**, **charges**, **bénéfice** indicatif, **nombre de transactions**.
- Graphiques : ventes par **catégorie**, par **mode de paiement**.
- **Alertes stock** (articles au seuil ou en dessous) avec actions vers le brouillon **commande fournisseur** (ligne unique, sélection multiple, tout cocher / décocher).
- **Casiers physiques** : synthèse du parc (total, pleins, partiels, vides) et **suggestions** de réapprovisionnement alignées sur la logique « casiers » du stock.

### 3.3 Point du jour (PDJ)

- Synthèse du jour (ou période) : CA encaissé, créances, transactions, remises, répartition paiements, **boissons vendues**, **détail des ventes**.
- **Ouverture de caisse** (selon paramétrage / droits : réservé gérant ou administrateur là où l’UI impose).
- **Vérification stock avant clôture** : saisie contrôlée, écarts, possibilité d’**imprimer le rapport de clôture**.
- **Journées clôturées — réouverture** : réservé administrateurs ; annule la fiche de clôture et les écritures associées, avec avertissement sur le stock courant.
- **Super administrateur** : choix d’une **date de journée** à traiter pour corrections post-réouverture.

### 3.4 Ventes — Commandes

- Création et suivi de **commandes** (statuts type en attente / servi selon implémentation).
- Lignes : article catalogue, **formats** (bouteille, pack, casier…), quantités, **remises**, lieu **Intérieur / Extérieur** si **tarification dual zone** activée pour le site.
- Prise en compte du **stock physique** (frigo + réserve), **réservations** sur commandes ouvertes.
- Finalisation, **facture** / ticket, annulations selon droits ; **audit** des actions sensibles (trace côté données).

### 3.5 Ventes — Caisse et recouvrement

- **Historique des ventes** finalisées sur plage de dates, impression période.
- **Recouvrement crédits** : tableau **reste à payer** par débiteur, enregistrement des **versements** (montant, mode, date/heure, note).
- **Historique des paiements** : liste de tous les versements enregistrés, y compris lorsqu’il n’y a plus de dette active (réconciliation).

### 3.6 Ventes — Consignes

- Enregistrement **reliquat payé** (client reviendra consommer) vs **consigne bouteille** (dépôt / retour physique) via case dédiée.
- Liaison optionnelle à une **facture** ; saisie **multi-lignes** avec colonne **Reliquat (btl)** pour mélanges sur une même facture.
- Indicateurs agrégés (bouteilles en retour, reliquats à servir, clôturées, montant dépôt dû).
- Actions de cycle de vie : rendu bouteille, passage en reliquat, reliquat servi, remboursement / suppression selon règles métier.

### 3.7 Ventes — QR codes

- Génération de liens / QR pour commande **client** (flux public contrôlé).
- Côté serveur : API publique limitée (menu, création / lecture commande) ; possibilité d’**alertes** (webhook, SMS via intégration Twilio si variables d’environnement présentes).

### 3.8 Stock — Catalogue

- CRUD articles : catégorie, **seuil**, **prix d’achat** (notamment au casier), **formats de vente**, **lot** (casier / carton), **brasserie** pour filtrage achats, **frigo / réserve**.
- **Pertes** : modal de sortie de stock hors vente (motif, quantité).

### 3.9 Stock — Mouvements

- Historique des **entrées** et mouvements liés aux opérations (ventes, réceptions, pertes, transferts selon données).

### 3.10 Stock — Achats fournisseurs

- **Brouillon / commande** : fournisseur, date, lignes (article du site, quantités en casiers, prix catalogue).
- **Réservation de casiers vides** pour lignes « casier consigne » lorsque le parc l’exige ; bouton **Créer des casiers vides** pour enchaîner sur la création physique puis **reprendre** la commande.
- Statuts : commande **en attente** jusqu’à **réception**.
- **Réception** : saisie des **casiers livrés** réels par ligne ; case **Ranger dans des casiers physiques** (répartition sur partiels, création de nouveaux casiers) ; mise à jour **stock**, **charge** d’approvisionnement, **casiers** et **mouvements casiers**.

### 3.11 Stock — Créanciers fournisseurs

- Suivi des dettes fournisseurs ; enregistrement de charges en **crédit fournisseur** lorsque le flux est utilisé.

### 3.12 Stock — Gestion casiers

- Inventaire des **casiers physiques** : code, article, capacité, quantité courante, bouteilles vides, emplacement, statut (plein / partiel / vide), réservation éventuelle par commande d’achat.
- **Mouvements** de casiers tracés (entrées, sorties, sources).
- Cohérence avec le **tableau de bord** et les **achats**.

### 3.13 Stock — Import / export Excel

- **Export** du stock du site (colonnes alignées import).
- **Import** : création / mise à jour d’articles ; prise en compte des colonnes physiques (**Frigo**, **Réserve**, **Entrées**, **Sorties**, **Stock actuel**) lorsqu’elles sont présentes.

### 3.14 Charges

- Saisie des dépenses : date, libellé, catégorie, montant, mode de paiement (incluant **crédit fournisseur** si applicable).
- Agrégation dans les indicateurs globaux (tableau de bord).

### 3.15 Paramètres

- **Profil** site / bar : nom, localisation, objectif CA, seuils, préfixe factures, options (brasserie unique, dual zone tarifaire…).
- **Catégories** de vente.
- **Accès** : utilisateurs, mots de passe, rôles, sites autorisés, 2FA.
- **Administration** (profils élevés) : export JSON, sauvegardes, restauration, options sensibles.

### 3.16 Guide intégré

- Page **Guide** dans l’application : liens vers sections du fichier **guide.html** (y compris export PDF navigateur).

---

## 4. Données et persistance

### 4.1 Modèle de données (vue logique)

État applicatif central incluant notamment : `sites`, `params` / paramètres par site, `ventes`, `commandes` et lignes, `stock`, `charges`, `purchaseOrders`, `supplierPrices`, `creditRecoveries`, `consignes`, `casiers`, `casierMouvements`, `stockChecks`, `dayBooks`, `categories`, compteurs **`nextId`**, journaux d’**audit** (actions personnel / système selon implémentation).

### 4.2 Modes de stockage côté serveur

- **`MAQUIS_MANAGER_STORAGE`** (prioritaire) ou ancien **`TDB_BAR_STORAGE`** : au minimum **`json`** (fichier `data.json`) ; option **`sqlite`** (`app.sqlite3`) selon configuration opérationnelle.
- **Sauvegardes** : répertoire `backups/` avec politique de **rétention** (`MAQUIS_MANAGER_BACKUP_KEEP` ou `TDB_BAR_BACKUP_KEEP`).
- **Hôte / port** : `MAQUIS_MANAGER_HOST`, `MAQUIS_MANAGER_PORT` (anciens `TDB_BAR_HOST`, `TDB_BAR_PORT` encore lus).

### 4.3 API principale (REST minimaliste)

Accès authentifié typique : `POST /api/login`, `POST /api/logout`, `GET /api/session`, `GET|POST /api/state`, `GET /api/changes` (synchronisation), routes **2FA**, routes **admin** (restauration, backups).  
Routes **publiques** limitées pour le flux **QR** (`/api/public/...`).

---

## 5. Exigences non fonctionnelles

### 5.1 Sécurité

- Transport **HTTPS** recommandé en production (hébergement derrière reverse proxy).
- Cookies de session **HttpOnly** côté bonnes pratiques déploiement ; secret serveur et fichiers de données **hors web public**.
- Journalisation d’**audit** serveur (fichier JSONL) pour événements sensibles.

### 5.2 Performance et disponibilité

- Serveur **multi-thread** (classe `ThreadingHTTPServer`) pour requêtes concurrentes sur petit déploiement local.
- Interface : chargement **SPA** légère (HTML + JS) ; pas d’obligation de framework côté client dans le CdC (implémentation actuelle : JS vanilla + modules métier).

### 5.3 Ergonomie

- **Responsive** : sidebar desktop, barre de navigation basse sur mobile ; FAB contextuel (commandes, stock, charges).
- **PWA** : `manifest.json`, **thème** et icône pour installation sur l’écran d’accueil.

### 5.4 Fiabilité

- Persistance atomique des écritures d’état (stratégie implémentée côté `server.py`).
- Messages d’erreur utilisateur en cas de **refus de permission** ou **session expirée**.

---

## 6. Architecture technique de référence

| Composant | Rôle |
|-----------|------|
| **`server.py`** | Serveur HTTP Python, routage API, authentification, persistance JSON/SQLite, sauvegardes, audit |
| **`index.html`** | Coque UI, pages et modales |
| **`app-orders.js`** (et scripts associés) | Logique métier client : navigation, rendu, appels API, règles stock / commandes / casiers |
| **`styles.css`** | Thème Maquis Manager |
| **`guide.html`**, **`GUIDE_UTILISATION.md`** | Documentation utilisateur |

**Prérequis** : Python 3, navigateur moderne ; pas de base de données obligatoire si mode JSON.

---

## 7. Critères d’acceptation globaux

- Un utilisateur **serveuse** peut enregistrer des ventes / commandes dans la limite de ses droits sans accéder aux écrans d’administration masqués.
- Un **gérant** peut réaliser le cycle **PDJ** (ouverture, vérification, clôture) et les **réceptions fournisseur** avec impact stock et charges cohérent.
- Un **administrateur** peut gérer les **comptes**, les **sites**, et les opérations de **sauvegarde / restauration** documentées.
- Le **multi-site** isole correctement les données ; aucune fuite de données entre sites pour un utilisateur non autorisé.
- Le **guide utilisateur** et le **cahier des charges** restent alignés sur les fonctionnalités livrées (révision à chaque évolution majeure).

---

## 8. Évolutions futures (hors version actuelle)

Les évolutions sont laissées à la discrétion du product owner ; exemples souvent demandés : intégration comptable, multi-devises, application mobile native, API tierce complète, pilotage central multi-franchise.

---

*Document : cahier des charges fonctionnel et technique de référence — **Maquis Manager** — généré pour le dépôt « gestion cave ». À maintenir lors des ajouts fonctionnels majeurs.*
