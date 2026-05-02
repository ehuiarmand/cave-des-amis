# Guide d'utilisation — TDB Bar Secure

Application web locale de gestion de bar : ventes, stock, achats fournisseurs, charges et paramètres multi-sites.

**Version navigateur / PDF** : menu **Guide** dans la navigation principale (barre latérale ou menu du bas sur mobile), puis *Ouvrir le guide complet* ou *impression PDF* ; ou fichier `guide.html` directement.

---

## 1. Première connexion

1. Ouvrez l’application dans le navigateur (adresse fournie par votre installation, souvent `http://127.0.0.1:8001` si le serveur Python tourne sur la machine).
2. Saisissez **nom d’utilisateur** et **mot de passe**.
3. Si la **double authentification (2FA)** est activée pour votre compte, entrez aussi le **code à 6 chiffres** de votre application d’OTP (Google Authenticator, Authy, etc.).
4. Validez pour accéder au **tableau de bord**.

**Déconnexion** : bouton prévu dans la barre latérale (ordinateur) ; sur téléphone, utilisez la navigation du bas puis les paramètres ou la zone session selon votre écran.

---

## 2. Navigation générale

| Zone | Contenu principal |
|------|-------------------|
| **Tableau de bord** | Indicateurs du jour, alertes stock, répartition ventes / paiements |
| **Point du jour** | Synthèse journalière détaillée (CA, créances, remises, boissons vendues) |
| **Ventes** | Commandes en cours, caisse et crédits clients, QR codes tables |
| **Stock** | Catalogue, mouvements, achats fournisseurs, créanciers fournisseurs, pertes |
| **Charges** | Dépenses (loyer, achats, etc.) |
| **Paramètres** | Fiche établissement, utilisateurs, catégories, options avancées |

En haut à droite : **sélecteur de site** si vous gérez plusieurs établissements — les données affichées suivent le site choisi.

Sur **téléphone**, la navigation principale est en **barre du bas** ; sur grand écran, elle est dans la **colonne à gauche**.

---

## 3. Tableau de bord

- Consultez le **chiffre d’affaires**, les **charges**, le **bénéfice** indicatif et le **nombre de ventes**.
- Les graphiques résument les ventes par **catégorie** et par **mode de paiement**.
- **Alertes stock** : articles dont le stock réel est au niveau du seuil ou en dessous.
  - **Proposer commande** : ouvre l’onglet Achats avec une ligne pré-remplie (quantité suggérée selon le seuil).
  - **Toutes les alertes** : ajoute tous les articles en alerte au **brouillon** de commande fournisseur.
  - Cochez des lignes puis **Sélection cochée** pour n’en prendre qu’une partie.
  - **Tout cocher / Tout décocher** : préparer rapidement une sélection.

---

## 4. Point du jour

Vue pensée pour la **clôture ou le bilan quotidien** : CA encaissé, montants « à régler », nombre de transactions, remises, répartition des paiements et détail des boissons vendues sur la période affichée.

---

## 5. Ventes

L’écran Ventes comporte plusieurs sous-onglets :

### Commandes

- Créez ou rouvrez une **commande** (nouvelle commande, sélection d’une commande existante).
- Ajoutez des **lignes** : article, format de vente (bouteille, pack, etc.), quantité, lieu (intérieur / extérieur si prévu).
- Le stock disponible est pris en compte selon les règles du logiciel (frigo / réserve).
- Actions possibles selon les droits : validation, impression ticket / facture, annulation de ligne ou de commande, QR table, etc.

### Caisse et crédit client

- Suivi des **encaissements** et des **crédits clients** (clients qui doivent encore payer).
- Possibilité d’enregistrer des **versements** sur un crédit.

### QR codes

- Génération / impression de **QR** pour tables ou espaces (usage interne / externe selon votre configuration).

Le bouton **flottant « + »** sur la page Ventes ouvre rapidement l’éditeur de commande.

---

## 6. Stock

### Catalogue

- Liste des articles avec stocks **frigo**, **réserve**, seuils, prix d’achat, formats de vente, etc.
- **Recherche** et mode tableau **compact / détaillé** selon les boutons prévus.
- **Nouvel article** ou modification : via le « + » sur la page Stock (onglet catalogue) ou les actions par ligne.
- Lors de la saisie d’un article : renseignez catégorie, **bouteilles par casier**, seuil minimum, prix d’achat au casier, formats de vente (quantités et prix intérieur / extérieur), répartition frigo / réserve si vous utilisez cette séparation.

### Mouvements

- Historique des **entrées** et mouvements liés au stock (selon données enregistrées).

### Achats fournisseurs

- **Nouvelle commande fournisseur** : fournisseur, date, mode de paiement (dont crédit fournisseur si activé).
- Ajout de lignes : l’article doit exister dans le stock du site ; le **prix au casier** et le **btl/casier** viennent du catalogue ; les **casiers** sont suggérés selon le niveau de stock et le seuil (modifiable avant validation).
- **Enregistrer la commande** : la commande reste « En attente » jusqu’à réception.
- **Réceptionner** : une fenêtre permet d’indiquer les **casiers réellement livrés** par ligne (peut différer de la commande) ; le stock et une **charge** « Approvisionnement » sont mis à jour en conséquence.
- Actions possibles sur une commande en attente : **annuler**, **retirer une ligne**.
- Sur téléphone, le **« + »** sur l’onglet Achats ouvre ce formulaire (et non la création d’article).

### Créanciers (dettes fournisseurs)

- Suivi des montants dus aux fournisseurs ; le « + » peut ouvrir une **dépense** avec paiement « Crédit fournisseur » selon votre version.

### Pertes / casse

- Enregistrement des sorties de stock hors vente (casse, casier cassé, etc.) selon les écrans prévus.

### Excel

- **Exporter** : fichier Excel du stock du site courant (colonnes alignées avec l’import).
- **Importer** : mise à jour ou création d’articles à partir du fichier ; les colonnes **Frigo**, **Réserve**, **Entrées**, **Sorties**, **Stock actuel** sont prises en compte quand elles sont présentes, en complément des champs catalogue.

---

## 7. Charges

- Enregistrez les **dépenses** : date, libellé, catégorie, montant, mode de paiement.
- Les charges alimentent le tableau de bord (charges vs CA) et peuvent inclure des paiements **crédit fournisseur**.

Le bouton **« + »** sur la page Charges ouvre rapidement une nouvelle dépense.

---

## 8. Paramètres

Sections typiques (selon votre rôle **administrateur**, **gérant**, **serveuse**) :

- **Établissement** : nom, ville, objectif de CA, seuil stock par défaut, préfixe factures, catégories de vente.
- **Utilisateurs et sites** : création de comptes, rôles, sites autorisés ; configuration **2FA** si disponible.
- **Données** : export JSON global, restauration depuis fichier serveur selon procédure affichée à l’écran — à manipuler avec précaution.

Les éléments masqués selon le **rôle** ne sont pas accessibles aux utilisateurs non autorisés.

---

## 9. Utilisation sur téléphone

- Interface adaptée : navigation basse d’écran, boutons plus grands, listes empilées, modales en grand format défilable.
- Les **tableaux larges** (stock, historiques) se parcourent **horizontalement** : faites défiler avec le doigt.
- Les champs de saisie utilisent une taille lisible pour limiter les zoom intempestifs.

---

## 10. Bonnes pratiques

1. **Commencer par le stock** : articles et prix à jour avant les ventes et les commandes fournisseur.
2. **Réceptionner les achats** avec les **quantités livrées réelles** pour que le stock et les dépenses reflètent la livraison.
3. **Choisir le bon site** avant de saisir ventes ou stock multi-établissements.
4. **Exporter régulièrement** le stock (Excel ou JSON depuis les paramètres) selon votre politique de sauvegarde.
5. Maintenir le **serveur** (`server.py`) actif sur la machine qui héberge les données ; les données sont enregistrées côté serveur (fichier JSON et/ou SQLite selon configuration).

---

## 11. En cas de problème

- **Session expirée** : reconnectez-vous.
- **Action refusée** : vérifiez votre **rôle** ou le **site** sélectionné.
- **Import Excel** : respectez les **intitulés de colonnes** du fichier exporté ; une ligne sans nom d’article est ignorée ; sans **prix d’achat** catalogue, une ligne de commande fournisseur peut être ignorée.
- Après mise à jour des fichiers de l’application, faites un **rechargement forcé** du navigateur (Ctrl+F5) pour prendre la dernière version des scripts.

---

*Document rédigé pour la version du projet « gestion cave » / TDB Bar Secure. Les libellés exacts des boutons peuvent légèrement varier selon les évolutions du logiciel.*
