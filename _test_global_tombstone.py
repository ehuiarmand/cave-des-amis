"""Régression : les tombstones {id, _deleted:true} ne doivent jamais être
persistés par la branche superadmin GLOBAL (admin/tanoh) de update_state.

Bug historique récurrent : en sauvegarde complète (non-delta), un tombstone
envoyé par le client pour supprimer une ligne (charge, casier, consigne...)
était stocké tel quel, créant une ligne fantôme qui réapparaissait pour
admin/tanoh (ex. casier vide capacité 24 quantité 0).

Lancer : python3 _test_global_tombstone.py
Retourne un code de sortie non nul si le bug est présent.
"""
import os
import tempfile
from pathlib import Path

os.environ.setdefault("MAQUIS_MANAGER_STORAGE", "json")

import server  # noqa: E402


def _new_store():
    tmp = tempfile.mkdtemp()
    store = server.DataStore(Path(tmp) / "data.json")
    store._state = {
        "sites": [{"id": "s1", "name": "Maquis 1"}],
        "activeSiteId": "s1",
        "ventes": [],
        "stock": [],
        "commandes": [],
        "stockChecks": [],
        "dayBooks": [],
        "purchaseOrders": [],
        "supplierPrices": [],
        "casiers": [
            {"id": "c1", "siteId": "s1", "capacite": 24, "quantiteActuelle": 3},
            {"id": "c2", "siteId": "s1", "capacite": 12, "quantiteActuelle": 0},
        ],
        "casierMouvements": [],
        "creditRecoveries": [],
        "clientAvoirs": [],
        "loyaltyClients": [],
        "consignes": [],
        "charges": [
            {"id": "ch1", "siteId": "s1", "libelle": "Loyer", "montant": 100},
            {"id": "ch2", "siteId": "s1", "libelle": "Eau", "montant": 20},
        ],
        "staffAuditLog": [],
        "stockEntrees": [],
        "stockLosses": [],
        "restaurantMenu": [],
        "ingredientStock": [],
        "categories": [],
        "nextId": {},
        "auth": {"users": [
            {"username": "admin", "passwordHash": "x", "role": "superadmin", "allowedSiteIds": ["s1"]},
        ]},
    }
    return store


ADMIN_SESSION = {"username": "admin", "role": "superadmin", "allowedSiteIds": ["s1"], "globalSuperadmin": True}


def _ids(rows):
    return {str(r.get("id")) for r in rows}


def _has_tombstone(rows):
    return any(isinstance(r, dict) and r.get("_deleted") for r in rows)


failures = []

# 1. Suppression d'une charge en sauvegarde complète (non-delta) — chemin réel du client (charge delete).
store = _new_store()
store.update_state(
    {
        "activeSiteId": "s1",
        "charges": [
            {"id": "ch1", "siteId": "s1", "libelle": "Loyer", "montant": 100},
            {"id": "ch2", "siteId": "s1", "_deleted": True},
        ],
    },
    ADMIN_SESSION,
)
charges = store._state.get("charges", [])
if _has_tombstone(charges):
    failures.append("charges: tombstone _deleted persisté (ligne fantôme)")
if _ids(charges) != {"ch1"}:
    failures.append(f"charges: ids attendus {{ch1}}, obtenu {_ids(charges)}")

# 2. Suppression d'un casier en sauvegarde complète (non-delta) — deleteCasier envoie sans _putDelta.
store = _new_store()
store.update_state(
    {
        "activeSiteId": "s1",
        "casiers": [
            {"id": "c1", "siteId": "s1", "capacite": 24, "quantiteActuelle": 3},
            {"id": "c2", "siteId": "s1", "_deleted": True},
        ],
    },
    ADMIN_SESSION,
)
casiers = store._state.get("casiers", [])
if _has_tombstone(casiers):
    failures.append("casiers: tombstone _deleted persisté (casier fantôme)")
if _ids(casiers) != {"c1"}:
    failures.append(f"casiers: ids attendus {{c1}}, obtenu {_ids(casiers)}")

# 3. Mode delta (merge_scoped_rows) doit continuer à supprimer correctement.
store = _new_store()
store.update_state(
    {
        "activeSiteId": "s1",
        "_putDelta": {"casiers": True},
        "casiers": [{"id": "c2", "siteId": "s1", "_deleted": True}],
    },
    ADMIN_SESSION,
)
casiers = store._state.get("casiers", [])
if _has_tombstone(casiers):
    failures.append("casiers(delta): tombstone _deleted persisté")
if _ids(casiers) != {"c1"}:
    failures.append(f"casiers(delta): ids attendus {{c1}}, obtenu {_ids(casiers)}")

if failures:
    print("ECHEC — bug de tombstone présent :")
    for f in failures:
        print("  -", f)
    raise SystemExit(1)

print("OK — aucun tombstone persisté dans la branche superadmin global.")
