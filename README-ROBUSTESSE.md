# Améliorations robustesse & performance (TDB Bar)

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
$env:TDB_BAR_STORAGE="sqlite"
python server.py
```

Le fichier est `app.sqlite3` (avec sauvegardes dans `backups/`).

## 4) Sauvegarde OneDrive

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

