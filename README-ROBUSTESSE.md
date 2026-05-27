# Améliorations robustesse & performance (Maquis Manager)

## 1) Réduire la charge réseau (live sync)

- Le front utilise maintenant `GET /api/changes?since=...` pour ne récupérer **que les nouvelles commandes QR**, au lieu de télécharger tout `/api/state` en boucle.
- L’API `/api/state` supporte aussi **ETag + 304** (utile en fallback).

## 2) Anti brute‑force + audit

- Limitation simple des tentatives de login sur `/api/login` (par IP + username).
- Journalisation minimale dans `audit.log.jsonl` (succès/échec/blocage login).

## 3) Stockage SQLite (optionnel)

Par défaut, le serveur lit/écrit `data.json`.

Pour activer SQLite (plus robuste quand les données grossissent) :

### Windows PowerShell

```powershell
cd "C:\COURS INPHB IC 2026\gestion cave"
$env:MAQUIS_MANAGER_STORAGE="sqlite"
# Ancien nom encore accepte par le serveur : $env:TDB_BAR_STORAGE="sqlite"
python server.py
```

## 4) Notifications WhatsApp

Le serveur prend en charge l’envoi d’alertes WhatsApp via l’API WhatsApp Cloud (Meta). Configurez ces variables d’environnement avant de lancer l’application :

```powershell
$env:WHATSAPP_PHONE_NUMBER_ID="<ID de votre numéro WhatsApp Cloud>"
$env:WHATSAPP_ACCESS_TOKEN="<votre jeton d'accès Graph API>"
$env:WHATSAPP_TEMPLATE_NAME="<optionnel>"
$env:WHATSAPP_TEMPLATE_LANG="fr"
```

Ensuite, ajoutez dans la configuration du site (`data.json` ou votre export de maquis) :

- `waNotifyPhones` : numéro(s) WhatsApp du maquis
- `waEvents` : inclure `commande_qr` pour les alertes de commandes QR

Et pour les serveuses en service, renseignez `waPhone` dans leur compte et planifiez leurs `workShifts`.
## 5) Sauvegarde OneDrive

Le script `backup_onedrive.ps1` copie les fichiers importants dans OneDrive et garde les **30** dernières sauvegardes.

### Lancer une sauvegarde manuelle

```powershell
cd "C:\COURS INPHB IC 2026\gestion cave"
powershell -ExecutionPolicy Bypass -File ".\backup_onedrive.ps1"
```

### Planifier (tâche Windows)

- Ouvre **Planificateur de tâches** → **Créer une tâche**
- Déclencheur: chaque jour (ex: 23h00)
- Action:
  - Programme: `powershell.exe`
  - Arguments:
    - `-ExecutionPolicy Bypass -File "C:\COURS INPHB IC 2026\gestion cave\backup_onedrive.ps1"`

