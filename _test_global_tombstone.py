"""Regression test: tombstones (_deleted rows) must NOT be persisted in the
global-superadmin branch of DataStore.update_state.

Reproduces the recurring bug where deleting a casier/charge as admin/tanoh
(global superadmin) via persistStatePatch (no _putDelta) leaves phantom
`{id, siteId, _deleted: true}` rows in stored state -> ghost empty casier
(capacite 24, qte 0) reappears after sync.

Run: python3 _test_global_tombstone.py
"""
import copy
import sys

import server


def make_store():
    store = server.DataStore(server.Path("/tmp/_tombstone_test_data.json"))
    state = copy.deepcopy(server.DEFAULT_STATE)
    state["sites"] = [{"id": "s1", "name": "Maquis 1"}]
    state["activeSiteId"] = "s1"
    state["auth"] = {
        "users": [
            {
                "username": "admin",
                "role": "superadmin",
                "passwordHash": server.hash_password("x"),
                "allowedSiteIds": ["s1"],
            }
        ]
    }
    store._state = state
    return store


SESSION = {"username": "admin", "role": "superadmin", "globalSuperadmin": True}


def test_casiers_full_save():
    store = make_store()
    store._state["casiers"] = [
        {"id": "c1", "siteId": "s1", "capacite": 24, "quantiteActuelle": 5},
        {"id": "c2", "siteId": "s1", "capacite": 24, "quantiteActuelle": 3},
    ]
    # Client deletes c1 -> sends full casiers list with tombstone, NO _putDelta.
    payload = {
        "casiers": [
            {"id": "c1", "siteId": "s1", "_deleted": True},
            {"id": "c2", "siteId": "s1", "capacite": 24, "quantiteActuelle": 3},
        ]
    }
    store.update_state(payload, dict(SESSION))
    ids = [r.get("id") for r in store._state["casiers"]]
    assert "c1" not in ids, f"phantom casier c1 persisted: {store._state['casiers']}"
    assert ids == ["c2"], f"unexpected casiers: {store._state['casiers']}"
    print("OK casiers full-save (non-delta) strips tombstone")


def test_casiers_delta():
    store = make_store()
    store._state["casiers"] = [
        {"id": "c1", "siteId": "s1", "capacite": 24, "quantiteActuelle": 5},
    ]
    payload = {
        "casiers": [{"id": "c1", "siteId": "s1", "_deleted": True}],
        "_putDelta": {"casiers": True},
    }
    store.update_state(payload, dict(SESSION))
    ids = [r.get("id") for r in store._state["casiers"]]
    assert "c1" not in ids, f"phantom casier c1 persisted (delta): {store._state['casiers']}"
    print("OK casiers delta strips tombstone")


def test_charges_full_save():
    store = make_store()
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
    assert "ch1" not in ids, f"phantom charge ch1 persisted: {store._state['charges']}"
    assert ids == ["ch2"], f"unexpected charges: {store._state['charges']}"
    print("OK charges full-save (non-delta) strips tombstone")


if __name__ == "__main__":
    test_casiers_full_save()
    test_casiers_delta()
    test_charges_full_save()
    print("\nAll tombstone regression tests passed.")
    sys.exit(0)
