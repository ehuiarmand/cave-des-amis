# Guide d'utilisation — Maquis Manager

Application web locale de gestion de bar : ventes, stock, achats fournisseurs, casiers physiques, charges et paramètres multi-sites.

**Version navigateur / PDF** : menu **Guide** dans la navigation principale (barre latérale ou menu du bas sur mobile), puis *Ouvrir le guide complet* ou *Ouvrir et proposer l'impression (PDF)* ; ou ouvrez directement le fichier `guide.html` à la racine du projet.

La version détaillée imprimable est aussi la référence pour les **liens par section** (ancres `#connexion`, `#consignes`, etc.).

---

## 1. Première connexion

1. Ouvrez l’application dans le navigateur (adresse fournie par votre installation, souvent `http://127.0.0.1:8001` si le serveur Python tourne sur la machine).
2. Saisissez **nom d’utilisateur** et **mot de passe**.
3. Si la **double authentification (2FA)** est activée pour votre compte, entrez aussi le **code à 6 chiffres** de votre application d’OTP (Google Authenticator, Authy, etc.).
4. Validez pour accéder au **tableau de bord**.

**Déconnexion** : bouton **Déconnexion** dans la barre latérale (ordinateur) ; sur téléphone, selon l’écran, la zone session ou les **Paramètres**.

---

## 2. Navigation générale

<p id="guide-app">Le menu <strong>Guide</strong> ouvre une page sommaire dans l’application avec des liens vers chaque chapitre du présent document (fichier <code>guide.html</code>) pour lecture ou impression PDF.</p>

| Zone | Contenu principal |
|------|-------------------|
| **Tableau de bord** | Indicateurs du jour, alertes stock, **casiers physiques** (parc), répartition ventes / paiements |
| **Point du jour** | Synthèse journalière (CA, créances, remises, boissons vendues), vérification stock avant clôture |
| **Ventes** | **Commandes**, **Caisse & Paiement** (historique ventes + recouvrement crédits), **Consignes**, **QR Codes** |
| **Stock** | **Catalogue**, **Mouvements**, **Achats fournisseurs**, **Créanciers**, **Gestion casiers** |
| **Charges** | Dépenses (loyer, achats, etc.) |
| **Guide** | Liens vers ce guide imprimable et PDF |
| **Paramètres** | Profil établissement, catégories, accès utilisateurs, administration |

En haut à droite : **sélecteur de site** si vous gérez plusieurs établissements — toutes les données affichées et saisies concernent le **site choisi**.

Sur **téléphone**, la navigation principale est en **barre du bas** ; sur grand écran, elle est dans la **colonne à gauche**.

**Rôles** (aperçu) : **serveuse**, **gérant**, **manager**, **administrateur**, **super administrateur**. Certaines actions (réouverture d’une journée clôturée au point du jour, choix de la date de journée à traiter, options d’administration) sont réservées aux profils autorisés ; les menus ou boutons absents signifient que votre compte n’y a pas accès.

---

## 3. Tableau de bord

- Consultez le **chiffre d’affaires**, les **charges**, le **bénéfice** indicatif et le **nombre de ventes**.
- Les graphiques résument les ventes par **catégorie** et par **mode de paiement**.
- **Casiers physiques** : carte récapitulative du parc (**total**, **pleins**, **partiels**, **vides**) et **suggestions** pour le réapprovisionnement (cohérent avec l’onglet Stock **Gestion casiers**).
- **Plus / moins vendues** : classement des boissons par **quantité (bouteilles)** sur **l’historique du site** — les plus vendues et (si au moins six références différentes ont été vendues au cumul) les moins vendues parmi les articles ayant eu au moins une vente.
- **Alertes stock** : articles dont le stock réel est au niveau du seuil ou en dessous.
  - **Proposer commande** : ouvre l’onglet Achats avec une ligne pré-remplie (quantité suggérée selon le seuil).
  - **Toutes les alertes** : ajoute tous les articles en alerte au **brouillon** de commande fournisseur.
  - Cochez des lignes puis **Sélection cochée** pour n’en prendre qu’une partie.
  - **Tout cocher / Tout décocher** : préparer rapidement une sélection.

---

## 4. Point du jour

Vue pensée pour la **clôture ou le bilan quotidien** : CA encaissé, montants « à régler », nombre de transactions, remises, répartition des paiements, détail des boissons vendues et **détail des ventes** sur la période affichée.

Sous **Boissons vendues (par jour)** : résumé **plus / moins vendues** ce jour-là (quantité en bouteilles), puis tableau détaillé trié par **CA net**. Si peu de références différentes dans la journée, le bloc « moins vendues » peut être masqué pour éviter la redondance avec « plus vendues ».

<h3 id="pdj-cloture">Vérification stock, clôture et administrateurs</h3>

- **Ouverture de caisse** : si votre installation l’utilise, la zone prévue en haut de page permet d’enregistrer l’ouverture du jour.
- **Vérifier avant clôture** : lance la **vérification de stock** de fermeture (comparaison avec le physique) ; vous pouvez ensuite utiliser **Imprimer le rapport de cloture** lorsqu’il est proposé.
- **Journées clôturées (réouverture)** : réservé aux **administrateurs** — permet de supprimer une fiche de clôture et d’annuler les écritures de stock associées à cette journée. Les quantités frigo / réserve actuelles ne sont pas recalculées automatiquement : vérifiez le stock physique si besoin.
- **Super administrateur** : si un bloc **« journée à traiter »** avec une **date** apparaît, vous pouvez appliquer cette date pour corriger ou contrôler une journée précise (par exemple après réouverture), puis reclôturer selon votre procédure interne.

---

## 5. Ventes

L’écran **Ventes** comporte quatre sous-onglets : **Commandes**, **Caisse & Paiement**, **Consignes**, **QR Codes**.

### Commandes

- Créez ou rouvrez une **commande** (bouton **Nouvelle commande** ou commande existante).
- Ajoutez des **lignes** : article, format de vente (bouteille, pack, casier, etc.), quantité, lieu (**Intérieur** / **Extérieur** si les tarifs diffèrent).
- Le stock disponible est pris en compte (frigo / réserve).
- Actions possibles selon les droits : validation, impression ticket / facture, annulation de ligne ou de commande, etc.

### Caisse & Paiement

Deux volets internes :

- **Historique ventes** : ventes finalisées sur une période (**Du** / **Au**), impression de la période possible.
- **Recouvrement crédits** : tableau **Crédits en cours (reste à payer)** avec bouton **Encaisser** par débiteur, saisie des **versements** (montant, mode de paiement, date/heure, note). Après **Enregistrer le versement**, chaque paiement apparaît aussi dans la section **Historique des paiements** (liste de tous les versements enregistrés, y compris lorsqu’il n’y a plus de solde actif).

<h3 id="consignes">Consignes — suivi des reliquats</h3>

L’onglet sert à deux situations fréquentes :

1. **Reliquat payé** : la facture est payée mais le client n’a pas tout bu — vous enregistrez ce qu’il laisse (**quantité** / **boisson**) pour qu’il revienne consommer plus tard.
2. **Consigne bouteille** : **dépôt** avec **retour physique** de la bouteille (décochez **« Reliquat payé : le client reviendra boire… »** pour ce mode).

**Indicateurs** en haut : *Bouteilles — retour*, *Reliquats à servir*, *Clôturées*, *Dépôt bouteille dû*.

**Nouvelle consigne** : client, date, **Facture concernée** (liste des factures ou saisie manuelle). Pour un **mélange** sur une même facture, renseignez la colonne **Reliquat (btl)** par ligne d’article puis **Enregistrer** — une ligne de consigne est créée par article. Le bouton **+1** sur une ligne peut préremplir une unité.

Case à cocher **« Reliquat payé : le client reviendra boire ce qui reste… »** : laissez coché pour un reliquat à honorer à la prochaine visite ; décochez pour une consigne **bouteille** (dépôt / retour physique).

Dans le tableau, selon le **statut**, des actions du type **Bouteille rendue**, **Reliquat payé (prochaine visite)**, **Reliquat servi**, **Remboursé / annulé**, **Suppr.** peuvent être proposées.

### QR codes

- Génération / impression de **QR** pour tables ou espaces (usage interne / externe selon votre configuration).

Le bouton **flottant « + »** sur la page Ventes ouvre en priorité l’éditeur de **commande** (sous-onglet Commandes).

---

## 6. Stock

### Catalogue

- Liste des articles avec stocks **frigo**, **réserve**, seuils, prix d’achat, formats de vente, etc.
- **Recherche** et mode tableau **compact / détaillé** selon les boutons prévus.
- **Nouvel article** ou modification : via le **« + »** sur la page Stock lorsque l’onglet **Catalogue** est actif, ou les actions par ligne.
- Bouton **Perte** : ouvre l’enregistrement d’une **sortie hors vente** (casse, casier cassé, etc.) — ce n’est pas un onglet séparé, l’action est dans le catalogue.
- Lors de la saisie d’un article : catégorie, **bouteilles par casier**, seuil minimum, prix d’achat au casier, formats de vente (quantités et prix intérieur / extérieur), répartition frigo / réserve si vous utilisez cette séparation.

### Mouvements

- Historique des **entrées** et mouvements liés au stock.

### Achats fournisseurs

- **Nouvelle commande fournisseur** : fournisseur, date, mode de paiement (dont **Crédit fournisseur** si activé).
- Ajout de lignes : l’article doit exister dans le stock du site ; le **prix au casier** et le format **btl/casier** viennent du catalogue ; les quantités en **casiers** sont suggérées selon le niveau de stock et le seuil (modifiable avant validation).
- Pour certaines lignes (lots type casier avec consigne), le logiciel peut exiger des **casiers vides** du parc : un bouton **Créer des casiers vides…** (mis en évidence) ouvre la création rapide d’un casier physique, puis vous pouvez **reprendre** la commande.
- **Enregistrer la commande** : la commande reste **En attente** jusqu’à réception.
- **Réceptionner** : fenêtre **Réception commande fournisseur** — indiquez les **casiers réellement livrés** par ligne (peut différer de la commande). Option **Ranger dans des casiers physiques** (cochée par défaut) : répartition automatique sur des casiers **partiels** existants, sinon création de **nouveaux casiers** pour les lots type casier ; le **stock catalogue** et l’onglet **Gestion casiers** sont mis à jour en cohérence. Le stock et une **charge** « Approvisionnement » reflètent le montant réceptionné.
- Actions possibles sur une commande en attente : **annuler**, **retirer une ligne**.
- Sur téléphone, le **« + »** sur l’onglet **Achats fournisseurs** ouvre le formulaire de **commande fournisseur** (et non la création d’article).

### Créanciers (dettes fournisseurs)

- Suivi des montants dus aux fournisseurs ; possibilité d’enregistrer une **dépense** avec paiement **Crédit fournisseur** selon votre flux.

<h3 id="casiers">Gestion casiers</h3>

- Vue du **parc de casiers physiques** : codes, articles, capacités, quantités, **statuts** (vide, partiel, plein), emplacements, mouvements.
- Cohérent avec la carte **Casiers physiques** du tableau de bord (compteurs et suggestions).
- Lors des **commandes fournisseur**, les casiers **vides** disponibles (hors réservation sur un brouillon) limitent parfois les quantités : utilisez **Créer des casiers vides…** depuis l’écran d’achat si le logiciel vous y invite.

### Excel

- **Exporter** : fichier Excel du stock du site courant (colonnes alignées avec l’import).
- **Importer** : mise à jour ou création d’articles à partir du fichier ; les colonnes **Frigo**, **Réserve**, **Entrées**, **Sorties**, **Stock actuel** sont prises en compte quand elles sont présentes, en complément des champs catalogue.

---

## 7. Charges

- Enregistrez les **dépenses** : date, libellé, catégorie, montant, mode de paiement.
- Les charges alimentent le tableau de bord (charges vs CA) et peuvent inclure des paiements **Crédit fournisseur**.

Le bouton **« + »** sur la page Charges ouvre rapidement une nouvelle dépense.

---

## 8. Paramètres

Sous-onglets typiques (selon votre rôle) :

- **Profil** : nom du bar, objectif de CA, seuil stock par défaut, préfixe factures, options (vente limitée à une brasserie, tarifs zone cave / terrasse, etc.).
- **Catégories** : liste des catégories boissons (profils autorisés).
- **Accès** : utilisateurs, rôles, sites autorisés, **2FA**.
- **Administration** : export JSON, sauvegardes, options avancées — à manipuler avec précaution.

Les éléments masqués selon le **rôle** ne sont pas accessibles.

---

## 9. Utilisation sur téléphone

- Interface adaptée : navigation basse d’écran, boutons plus grands, listes empilées, modales en grand format défilable.
- Les **tableaux larges** (stock, historiques, recouvrement) se parcourent **horizontalement** : faites défiler avec le doigt.
- Les champs de saisie utilisent une taille lisible pour limiter les zoom intempestifs.

---

## 10. Bonnes pratiques

1. **Commencer par le stock** : articles et prix à jour avant les ventes et les commandes fournisseur.
2. **Réceptionner les achats** avec les **quantités livrées réelles** et la case **Ranger dans des casiers physiques** adaptée à votre processus réel de cave.
3. **Choisir le bon site** avant de saisir ventes ou stock multi-établissements.
4. **Exporter régulièrement** le stock (Excel ou JSON depuis les paramètres) selon votre politique de sauvegarde.
5. Maintenir le **serveur** (`server.py`) actif sur la machine qui héberge les données ; les données sont enregistrées côté serveur (fichier JSON et/ou SQLite selon configuration).

---

## 11. En cas de problème

- **Session expirée** : reconnectez-vous.
- **Action refusée** : vérifiez votre **rôle** ou le **site** sélectionné.
- **Import Excel** : respectez les **intitulés de colonnes** du fichier exporté ; une ligne sans nom d’article est ignorée ; sans **prix d’achat** catalogue, une ligne de commande fournisseur peut être ignorée.
- **Casiers vides insuffisants** (message lors de l’enregistrement d’une commande fournisseur) : créez des **casiers vides** via le bouton proposé, ou réduisez les quantités / le brouillon sur les lignes concernées.
- Après mise à jour des fichiers de l’application, faites un **rechargement forcé** du navigateur (Ctrl+F5) pour prendre la dernière version des scripts.

---

*Document rédigé pour **Maquis Manager** (projet « gestion cave »). Les libellés exacts des boutons peuvent légèrement varier selon les évolutions du logiciel.*
