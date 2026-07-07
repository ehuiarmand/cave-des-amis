"""Régression : les tombstones {id, siteId, _deleted:true} envoyés en sauvegarde
complète (patch SANS _putDelta) par un superadmin GLOBAL (admin/tanoh) ne doivent
jamais être persistés comme lignes fantômes.

Bug historique : la branche global-superadmin de DataStore.update_state assignait
brut `current[_key] = payload[_key]` (et `current["casiers"] = sanitized`), ce qui
conservait les lignes marquées `_deleted` -> casier fantôme (cap 24, qte 0), charge
fantôme, etc. réapparaissant côté admin/tanoh.

Lancer :  python3 _test_global_tombstone.py
"""
import tempfile
from pathlib import Path

import server


def _make_store():
    tmp = Path(tempfile.mkdtemp()) / "data.json"
    store = server.DataStore(tmp)
    store._state = {
        "sites": [{"id": "s1", "name": "Maquis 1"}, {"id": "s2", "name": "Maquis 2"}],
        "activeSiteId": "s1",
        "ventes": [],
        "stock": [],
        "commandes": [],
        "stockChecks": [],
        "dayBooks": [],
        "purchaseOrders": [],
        "supplierPrices": [],
        "casiers": [
            {"id": "c1", "siteId": "s1", "capacite": 24, "quantiteActuelle": 5},
            {"id": "c2", "siteId": "s1", "capacite": 24, "quantiteActuelle": 3},
        ],
        "casierMouvements": [],
        "creditRecoveries": [],
        "clientAvoirs": [],
        "loyaltyClients": [],
        "consignes": [],
        "charges": [
            {"id": "ch1", "siteId": "s1", "libelle": "Loyer", "montant": 1000},
            {"id": "ch2", "siteId": "s1", "libelle": "Eau", "montant": 200},
        ],
        "staffAuditLog": [],
        "stockEntrees": [],
        "stockLosses": [],
        "restaurantMenu": [],
        "ingredientStock": [],
        "categories": server.DEFAULT_STATE["categories"],
        "nextId": {},
        "auth": {"users": [{"username": "admin", "role": "superadmin", "allowedSiteIds": ["s1", "s2"], "passwordHash": "x"}]},
    }
    return store


GLOBAL_SESSION = {"username": "admin", "role": "superadmin", "globalSuperadmin": True, "allowedSiteIds": ["s1", "s2"]}


def test_charges_fullsave_tombstone():
    store = _make_store()
    # Client supprime ch2 -> envoie la collection restante + tombstone, SANS _putDelta.
    payload = {
        "activeSiteId": "s1",
        "charges": [
            {"id": "ch1", "siteId": "s1", "libelle": "Loyer", "montant": 1000},
            {"id": "ch2", "siteId": "s1", "_deleted": True},
        ],
    }
    store.update_state(payload, GLOBAL_SESSION)
    ids = [c.get("id") for c in store._state["charges"]]
    assert "ch2" not in ids, f"tombstone charge persistée: {store._state['charges']}"
    assert any(c.get("_deleted") for c in store._state["charges"]) is False, "aucune ligne _deleted ne doit rester"
    assert ids == ["ch1"], ids
    print("OK charges full-save tombstone")


def test_casiers_fullsave_tombstone():
    store = _make_store()
    payload = {
        "activeSiteId": "s1",
        "casiers": [
            {"id": "c1", "siteId": "s1", "capacite": 24, "quantiteActuelle": 5},
            {"id": "c2", "siteId": "s1", "_deleted": True},
        ],
    }
    store.update_state(payload, GLOBAL_SESSION)
    ids = [c.get("id") for c in store._state["casiers"]]
    assert "c2" not in ids, f"tombstone casier persistée (fantôme): {store._state['casiers']}"
    assert all(not c.get("_deleted") for c in store._state["casiers"])
    assert ids == ["c1"], ids
    print("OK casiers full-save tombstone")


def test_casiers_delta_tombstone():
    store = _make_store()
    payload = {
        "activeSiteId": "s1",
        "casiers": [{"id": "c2", "siteId": "s1", "_deleted": True}],
        "_putDelta": {"casiers": True},
    }
    store.update_state(payload, GLOBAL_SESSION)
    ids = [c.get("id") for c in store._state["casiers"]]
    assert ids == ["c1"], f"delta suppression cassée: {store._state['casiers']}"
    print("OK casiers delta tombstone")


if __name__ == "__main__":
    test_charges_fullsave_tombstone()
    test_casiers_fullsave_tombstone()
    test_casiers_delta_tombstone()
    print("\nTous les tests OK")
