# Guide d'utilisation — Maquis Manager

Application web de gestion de maquis / bar : ventes, point du jour, stock, achats fournisseurs, casiers, charges, recouvrement, avoirs clients et paramètres **multi-maquis**.

**Dans l'application** : menu **Guide** (barre latérale ou menu du bas sur mobile) → *Ouvrir le guide complet* ou *Impression PDF*.  
**Hors ligne / PDF** : fichier `guide.html` à la racine du projet (ancres `#connexion`, `#stock-inventaire`, etc.).

---

## 1. Première connexion

1. Ouvrez l'application dans le navigateur (adresse fournie par votre hébergeur, ex. `https://app.cave-des-amis.com`, ou `http://127.0.0.1:8001` en local).
2. Saisissez **nom d'utilisateur** et **mot de passe**.
3. **Double authentification (2FA)** si activée :
   - **Code OTP** (Google Authenticator, Authy…) sur 6 chiffres, ou
   - **Code WhatsApp** reçu sur le numéro enregistré sur votre compte.
4. **Renouvellement mensuel du mot de passe** (si activé sur le serveur) : au **1er du mois**, un écran peut vous demander de saisir l'ancien mot de passe et un **nouveau** avant d'accéder à l'application. Un changement effectué **dans le mois en cours** vous couvre jusqu'à la fin de ce mois ; le 1er du mois suivant, un nouveau changement sera demandé.
5. Validez pour accéder au **tableau de bord**.

**Déconnexion** : bouton **Déconnexion** (barre latérale sur ordinateur ; sur mobile, menu **Plus** ou **Paramètres**).

---

## 2. Navigation générale

Le menu **Guide** ouvre un sommaire avec liens vers ce document (`guide.html`) pour lecture ou impression PDF.

| Zone | Contenu principal |
|------|-------------------|
| **Tableau de bord** | CA, charges, bénéfice estimé, alertes stock, casiers, plus/moins vendues, export |
| **Point du jour** | Synthèse · **Clôture** · Ventes (journée comptable) |
| **Ventes** | Commandes · **Caisse & Paiement** · Consignes · QR Codes |
| **Stock** | Catalogue · **Inventaire** · Mouvements · Achats · Créanciers · Casiers |
| **Charges** | Dépenses du mois |
| **Planning** | Mes horaires · Équipe (gérant) |
| **Historique ventes** | Ventes du jour (profil serveuse, si activé) |
| **Guide** | Liens vers le guide imprimable |
| **Paramètres** | Profil · Catégories · Accès · Sauvegarde · **Correction** · Administration |

En haut : **sélecteur de maquis** — toutes les données concernent le **site choisi**.

Sur **téléphone** : navigation en **barre du bas** (+ menu **Plus** pour Guide, Charges, Paramètres, etc.).

**Rôles** (aperçu) : **serveuse**, **gérant**, **manager**, **administrateur**, **super administrateur**. Menus ou boutons absents = droits insuffisants pour votre compte.

---

## 3. Tableau de bord

- **CA**, **charges**, **bénéfice estimé** (marge brute − charges), **nombre de ventes** sur la période affichée.
- Graphiques : ventes par **catégorie** et par **mode de paiement**.
- **Imprimer le point** : récapitulatif CA / marge / charges pour la période.
- **Casiers physiques** : total, pleins, partiels, vides + suggestions de réappro (lié à Stock → Gestion casiers).
- **Plus / moins vendues** : classement en **bouteilles** sur l'historique du site.
- **Alertes stock** : articles au seuil ou en dessous.
  - **Proposer commande** / **Toutes les alertes** / **Sélection cochée** : alimentent le brouillon **Achats fournisseurs**.

**Export** (Paramètres → Profil, section export) : ventes et charges en **Excel** sur une période (jour, semaine, mois ou dates personnalisées).

---

## 4. Point du jour

Trois sous-onglets : **Synthèse**, **Clôture**, **Ventes**.

### Synthèse

CA encaissé, montants à régler, transactions, remises, répartition des paiements, boissons vendues (plus/moins vendues du jour), détail des ventes.  
**Imprimer le point du jour** disponible selon votre profil.

### Clôture

Procédure de **fin de journée comptable** :

1. **Ouverture de caisse** (si activée) : montant d'ouverture + snapshot stock.
2. **Vérification stock** : comparaison théorique (ouverture + **achats du jour** − ventes − pertes) vs frigo/réserve saisis ou catalogue (selon rôle).
3. **Caisse de clôture** : montant espèces comptées vs **théorique** (ouverture + ventes espèces + recouvrements espèces + **avoirs émis** − charges espèces non déduites du théorique affiché — voir écran).
4. **Clôturer la journée** (gérant / admin) ou **Fin de service** (serveuse : transmission au gérant).

**Imprimer le rapport de clôture** après vérification.

**Administrateurs** :
- **Journées clôturées (réouverture)** : supprime la fiche et annule les écritures stock liées ; le physique frigo/réserve n'est pas recalculé automatiquement.
- **Super admin** : bloc **journée à traiter** pour corriger une date passée puis reclôturer.

### Ventes (PDJ)

Liste des ventes de la **journée comptable** affichée (date PDJ en haut de page).

---

## 5. Ventes

Quatre sous-onglets : **Commandes**, **Caisse & Paiement**, **Consignes**, **QR Codes**.

### Commandes

Créer ou rouvrir une commande ; lignes (article, format kit/bouteille/casier, quantité, Intérieur/Extérieur). Stock frigo/réserve pris en compte. Validation, ticket, facture, annulations selon droits.

Le bouton flottant **+** ouvre une **nouvelle commande** lorsque l'onglet Commandes est actif.

### Caisse & Paiement

Trois volets internes :

#### Historique ventes

Ventes finalisées (**Du** / **Au**), filtres, **Imprimer la période**. Colonnes **Table** et **Mode** selon configuration.

#### Recouvrement crédit

Tableau **Crédits en cours (reste à payer)** → **Encaisser** (montant, mode, date/heure, note).  
**Historique des paiements** : tous les versements enregistrés.  
Le recouvrement en **espèces** alimente le théorique caisse du jour comptable.

#### Avoirs clients

Quand le client laisse sa **monnaie** au maquis (pas de rendu immédiat) :

- **Garder la monnaie** : client, montant, note → crée un **avoir**.
- Solde par client = émissions − utilisations.
- Lors d'un encaissement, mode de paiement **Avoir client** pour consommer le solde.

#### Remplacer un article encaissé

Factures de la **journée comptable en cours** : sélectionner une facture, **Remplacer** sur une ligne → choix du nouvel article, quantité, confirmation.  
Le **stock** et le **montant encaissé** sont realignés (supplément à encaisser si prix supérieur). Réservé aux profils autorisés.

### Consignes

**Reliquat payé** (client reviendra boire) ou **consigne bouteille** (dépôt / retour physique — décocher « Reliquat payé… »).

Indicateurs : *Bouteilles — retour*, *Reliquats à servir*, *Clôturées*, *Dépôt bouteille dû*.  
Actions : Bouteille rendue, Reliquat servi, Remboursé, Suppr., etc.

### QR Codes

Génération / impression QR **Intérieur** / **Extérieur** ; commandes clients via scan.

---

## 6. Stock

### Catalogue

Articles : frigo, réserve, seuils, prix achat, formats de vente. Recherche, filtres, vue compacte / complète.

- **+** (FAB) : nouvel article (onglet Catalogue actif).
- **Perte** : sortie hors vente (casse…) — **confirmation** obligatoire.
- **Exporter / Importer Excel** : colonnes Frigo, Réserve, Entrées, Sorties, Stock actuel si présentes.
- **Imprimer** : état du stock catalogue.

### Inventaire (gérant / manager)

Synthèse sur une **période** (Du / Au) pour **tout le catalogue** :

| Colonne | Signification |
|---------|----------------|
| Stock début | Stock à l'ouverture de la période |
| Achats | Entrées (commandes fournisseur reçues, etc.) |
| Ventes | Sorties ventes |
| Pertes | Sorties pertes |
| Écarts inexpliqués | Écarts PDJ recalculés |
| Stk fin (th.) | Début + achats − ventes − pertes |
| Stk réconcilié | Fin théorique + écarts clôture |
| Stk actuel | Frigo + réserve catalogue (lignes en jaune si écart avec réconcilié) |

**Afficher** puis **Imprimer**.

### Mouvements

Journal des mouvements sur une période. Filtre **Type** : Tous / Entrées / Sorties.

**Imprimer par article** : synthèse par article (début, entrées, sorties, fin) selon le filtre type. Tableau synthèse visible à l'écran (profils manager).

### Achats fournisseurs

1. **Nouvelle commande** : fournisseur, date, paiement (dont **Crédit fournisseur**).
2. Lignes depuis le catalogue ; quantités en **casiers** suggérées selon stock/seuil.
3. **Casiers vides** : bouton **Créer des casiers vides…** si le parc est insuffisant.
4. **Enregistrer** → statut **En attente**.
5. **Réceptionner** : quantités **réellement livrées** par ligne ; option **Ranger dans des casiers physiques** (défaut coché). Crée **une seule charge** « Approvisionnement » liée à la commande (pas de doublon si double clic).

Actions : **Annuler**, retirer une ligne. Sur mobile, **+** ouvre le formulaire d'achat.

### Créanciers

Dettes fournisseurs ; charges en **Crédit fournisseur**.

### Gestion casiers

Parc physique : codes, articles, capacités, statuts (vide, partiel, plein), mouvements, export CSV.

---

## 7. Charges

Dépenses : date, libellé, catégorie, montant, paiement.

- Saisie manuelle via **+** sur la page Charges.
- **Automatique** à la **réception** d'une commande fournisseur (catégorie Approvisionnement).
- Alimentent le tableau de bord et le PDJ.
- **Suppr.** : administrateurs uniquement — **confirmation** avant suppression.

---

## 8. Planning

- **Mes horaires** : créneaux de la serveuse / gérante connectée (plage Du / Au en haut).
- **Équipe** (gérant) : planifier serveuses et gérantes ; **Générer une rotation** (jours travaillés / repos, heures début/fin).
- Jour de **repos** planifié : la serveuse ne peut pas vendre ce jour-là (message explicite).

---

## 9. Historique ventes (serveuse)

Ventes de la **journée** pour le compte connecté : filtres, totaux, **Imprimer la période**. Visible selon profil (menu dédié sur mobile).

---

## 10. Paramètres

| Onglet | Contenu |
|--------|---------|
| **Profil** | Nom du maquis, objectif CA, seuil stock, préfixe factures, WhatsApp, export Excel période, mot de passe personnel |
| **Catégories** | Catégories boissons |
| **Accès** | Utilisateurs, rôles, maquis autorisés, **2FA**, WhatsApp 2FA |
| **Sauvegarde** | Snapshots / restauration (admins habilités) |
| **Correction** | **Correction de facture** sans annulation : recherche par n° facture → corriger **paiement** ou **quantités** (motif obligatoire) ; **Historique des corrections** en bas de page |
| **Administration** | Journal audit gérant/serveuses, options super admin (secours JSON, purge maquis, décalage journées…) |

**Sécurité** :
- Comptes admin / gérant : **2FA recommandée ou obligatoire** selon configuration serveur.
- **Renouvellement mensuel** du mot de passe (voir §1).

---

## 11. Module restaurant (si activé)

Menus **Menu cuisine** et **Stock ingrédients** : cartes plats et stock ingrédients pour établissements avec restauration. Masqués si le maquis n'a pas l'option restaurant.

---

## 12. Utilisation sur téléphone

- Barre de navigation basse, boutons larges, modales défilables.
- Tableaux : **défilement horizontal** (stock, inventaire, recouvrement).
- **Plus** : accès Guide, Charges, Paramètres, PDJ, etc.

---

## 13. Bonnes pratiques

1. Tenir le **catalogue stock** à jour avant ventes et commandes.
2. **Réceptionner** les achats avec quantités **réelles** ; une réception = une charge.
3. **Clôturer** chaque journée comptable : stock + caisse cohérents avec le physique.
4. Vérifier le **maquis actif** avant toute saisie multi-sites.
5. Utiliser **Correction de facture** (motif tracé) plutôt que des manipulations stock manuelles après clôture.
6. **Exporter** régulièrement (Excel / sauvegarde Paramètres).
7. Après mise à jour : **Ctrl+F5** (rechargement forcé) sur l'application.

---

## 14. En cas de problème

| Symptôme | Piste |
|----------|--------|
| Session expirée | Reconnectez-vous |
| Écran « Renouvellement mensuel » | Changez le mot de passe (1er du mois ou compte jamais renouvelé ce mois-ci) |
| Action refusée | Rôle ou maquis sélectionné |
| 2FA obligatoire | Activez 2FA dans Paramètres → Accès |
| Charge en double fournisseur | Supprimez le doublon (admin) ; les nouvelles réceptions sont protégées |
| Écart stock PDJ / inventaire | Vérifiez achats du jour à la clôture ; consultez Inventaire (écarts, stk réconcilié vs actuel) |
| Correction qty sans montant | Refaites une correction quantité (sync paiement automatique) ou correction paiement |
| Import Excel | Reprenez les en-têtes de l'export ; article et prix achat requis pour achats |
| Casiers vides insuffisants | **Créer des casiers vides…** depuis l'achat |
| Page blanche / bouton mort | **Ctrl+F5** ; redémarrer `python server.py` si le serveur a changé |

---

*Document **Maquis Manager** — mis à jour pour les fonctionnalités récentes (inventaire, mouvements, correction facture, avoirs clients, renouvellement mot de passe, clôture PDJ). Les libellés à l'écran priment en cas de divergence.*
