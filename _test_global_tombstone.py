"""Regression test: global-superadmin PUT /api/state must strip _deleted tombstones.

Reproduces the recurring bug where casiers/charges deletions by admin/tanoh
(global superadmin) persisted phantom rows {id, siteId, _deleted:true} because
the non-delta branches stored the payload verbatim (keeping _deleted rows).

Run: python3 _test_global_tombstone.py
"""
import copy
import tempfile
from pathlib import Path

import server


def make_store():
    store = server.DataStore(Path(tempfile.mkdtemp()) / "data.json")
    state = copy.deepcopy(server.DEFAULT_STATE)
    state["sites"] = [{"id": "s1", "name": "Maquis 1"}]
    state["activeSiteId"] = "s1"
    state["auth"] = {
        "users": [
            {
                "username": "admin",
                "role": "superadmin",
                "allowedSiteIds": ["s1"],
                "passwordHash": "x",
            }
        ]
    }
    store._state = state
    return store


SESSION = {"username": "admin", "role": "superadmin", "globalSuperadmin": True}


def test_casiers_full_save():
    store = make_store()
    store._state["casiers"] = [{"id": "c1", "siteId": "s1", "capacite": 24, "quantiteActuelle": 5}]
    # Client deletes c1 -> sends full list with tombstone, no _putDelta
    store.update_state(
        {"casiers": [{"id": "c1", "siteId": "s1", "_deleted": True}]},
        dict(SESSION),
    )
    casiers = store._state["casiers"]
    assert not any(c.get("id") == "c1" for c in casiers), f"phantom casier persisted: {casiers}"
    print("OK casiers full-save")


def test_casiers_delta():
    store = make_store()
    store._state["casiers"] = [{"id": "c1", "siteId": "s1", "capacite": 24, "quantiteActuelle": 5}]
    store.update_state(
        {"casiers": [{"id": "c1", "siteId": "s1", "_deleted": True}], "_putDelta": {"casiers": True}},
        dict(SESSION),
    )
    casiers = store._state["casiers"]
    assert not any(c.get("id") == "c1" for c in casiers), f"phantom casier persisted (delta): {casiers}"
    print("OK casiers delta")


def test_charges_full_save():
    store = make_store()
    store._state["charges"] = [{"id": "ch1", "siteId": "s1", "montant": 1000}]
    store.update_state(
        {"charges": [{"id": "ch1", "siteId": "s1", "_deleted": True}]},
        dict(SESSION),
    )
    charges = store._state["charges"]
    assert not any(c.get("id") == "ch1" for c in charges), f"phantom charge persisted: {charges}"
    print("OK charges full-save")


if __name__ == "__main__":
    test_casiers_full_save()
    test_casiers_delta()
    test_charges_full_save()
    print("ALL PASS")
