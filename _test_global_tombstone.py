"""Régression : les tombstones ({..., "_deleted": true}) ne doivent JAMAIS être
persistés dans la branche global-superadmin de DataStore.update_state.

Bug récurrent : un superadmin global (admin/tanoh) qui supprime un casier / une
charge envoie un PATCH non-delta contenant la ligne tombstone. Sans filtrage,
la ligne fantôme {"id":..., "_deleted":true} est réécrite dans l'état -> casier
fantôme (capacité 24, quantité 0), charge fantôme, etc.

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
    state["casiers"] = [
        {"id": "c1", "siteId": "s1", "article": "Beaufort", "capacite": 24, "quantiteActuelle": 5}
    ]
    state["charges"] = [
        {"id": "ch1", "siteId": "s1", "libelle": "Loyer", "montant": 1000}
    ]
    store._state = state
    return store


SESSION = {
    "username": "admin",
    "role": "superadmin",
    "allowedSiteIds": ["s1"],
    "globalSuperadmin": True,
}


def _assert_no_deleted(rows, key):
    ghosts = [r for r in rows if isinstance(r, dict) and r.get("_deleted")]
    assert not ghosts, f"Tombstone persisté dans {key}: {ghosts}"


def test_casiers_full_save():
    store = _make_store()
    # Suppression non-delta (persistStatePatch n'envoie pas _putDelta) :
    store.update_state({"casiers": [{"id": "c1", "siteId": "s1", "_deleted": True}]}, dict(SESSION))
    casiers = store._state["casiers"]
    _assert_no_deleted(casiers, "casiers")
    assert not any(r.get("id") == "c1" for r in casiers), f"c1 aurait dû être supprimé: {casiers}"
    print("OK casiers full-save")


def test_casiers_delta():
    store = _make_store()
    store.update_state(
        {"casiers": [{"id": "c1", "siteId": "s1", "_deleted": True}], "_putDelta": {"casiers": True}},
        dict(SESSION),
    )
    casiers = store._state["casiers"]
    _assert_no_deleted(casiers, "casiers")
    assert not any(r.get("id") == "c1" for r in casiers), f"c1 aurait dû être supprimé (delta): {casiers}"
    print("OK casiers delta")


def test_charges_full_save():
    store = _make_store()
    store.update_state({"charges": [{"id": "ch1", "siteId": "s1", "_deleted": True}]}, dict(SESSION))
    charges = store._state["charges"]
    _assert_no_deleted(charges, "charges")
    assert not any(r.get("id") == "ch1" for r in charges), f"ch1 aurait dû être supprimé: {charges}"
    print("OK charges full-save")


if __name__ == "__main__":
    test_casiers_full_save()
    test_casiers_delta()
    test_charges_full_save()
    print("TOUS LES TESTS PASSENT")
