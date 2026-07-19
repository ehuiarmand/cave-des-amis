"""Régression : les tombstones (`_deleted: true`) envoyés par un superadmin GLOBAL
(admin / tanoh) via un PUT non-delta (full save) doivent réellement supprimer la
ligne — et non persister une ligne fantôme `{id, siteId, _deleted: true}`.

Bug récurrent de la branche superadmin global dans DataStore.update_state :
- casiers non-delta -> `current["casiers"] = sanitized` gardait les `_deleted`.
- générique else -> `current[_key] = payload[_key]` gardait les `_deleted`.

Lancer : python3 _test_global_tombstone.py
"""
import copy
import tempfile
from pathlib import Path

import server


def _make_store():
    tmp = Path(tempfile.mkdtemp()) / "data.json"
    store = server.DataStore(tmp)
    state = copy.deepcopy(server.DEFAULT_STATE)
    state["sites"] = [{"id": "s1", "name": "Maquis 1"}]
    state["activeSiteId"] = "s1"
    state["auth"] = {
        "users": [
            {
                "username": "admin",
                "passwordHash": server.hash_password("x"),
                "role": "superadmin",
                "allowedSiteIds": ["s1"],
            }
        ]
    }
    store._state = state
    return store


SESSION = {
    "username": "admin",
    "role": "superadmin",
    "allowedSiteIds": ["s1"],
    "globalSuperadmin": True,
}


def test_casiers_full_save_strips_tombstone():
    store = _make_store()
    store._state["casiers"] = [
        {"id": "c1", "siteId": "s1", "quantiteActuelle": 5, "capacite": 24},
        {"id": "c2", "siteId": "s1", "quantiteActuelle": 3, "capacite": 24},
    ]
    # Full save (pas de _putDelta) : c1 supprimé -> tombstone, c2 conservé.
    payload = {
        "casiers": [
            {"id": "c1", "siteId": "s1", "_deleted": True},
            {"id": "c2", "siteId": "s1", "quantiteActuelle": 3, "capacite": 24},
        ]
    }
    store.update_state(payload, dict(SESSION))
    ids = [r.get("id") for r in store._state["casiers"]]
    assert "c1" not in ids, f"casier fantôme persisté (full save): {store._state['casiers']}"
    assert "c2" in ids
    assert all(not r.get("_deleted") for r in store._state["casiers"])


def test_casiers_delta_strips_tombstone():
    store = _make_store()
    store._state["casiers"] = [
        {"id": "c1", "siteId": "s1", "quantiteActuelle": 5, "capacite": 24},
    ]
    payload = {
        "_putDelta": {"casiers": True},
        "casiers": [{"id": "c1", "siteId": "s1", "_deleted": True}],
    }
    store.update_state(payload, dict(SESSION))
    ids = [r.get("id") for r in store._state["casiers"]]
    assert "c1" not in ids, f"casier fantôme persisté (delta): {store._state['casiers']}"


def test_charges_full_save_strips_tombstone():
    store = _make_store()
    store._state["charges"] = [
        {"id": "ch1", "siteId": "s1", "montant": 1000},
        {"id": "ch2", "siteId": "s1", "montant": 2000},
    ]
    payload = {
        "charges": [
            {"id": "ch1", "siteId": "s1", "_deleted": True},
            {"id": "ch2", "siteId": "s1", "montant": 2000},
        ]
    }
    store.update_state(payload, dict(SESSION))
    ids = [r.get("id") for r in store._state["charges"]]
    assert "ch1" not in ids, f"charge fantôme persistée: {store._state['charges']}"
    assert "ch2" in ids


if __name__ == "__main__":
    test_casiers_full_save_strips_tombstone()
    test_casiers_delta_strips_tombstone()
    test_charges_full_save_strips_tombstone()
    print("OK: tombstones correctement supprimés dans la branche superadmin global")
