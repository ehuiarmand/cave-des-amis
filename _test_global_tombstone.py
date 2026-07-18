"""Regression test: tombstones (`_deleted`) must be stripped in the
global-superadmin branch of DataStore.update_state (non-delta paths).

Reproduces the recurring bug where a global superadmin (admin/tanoh) deleting a
casier / charge via persistStatePatch (no _putDelta) persisted a phantom row
`{id, siteId, _deleted:true}` (rendered as a ghost empty casier, cap 24 qte 0).

Run: python3 _test_global_tombstone.py
"""
import copy
import tempfile
from pathlib import Path

import server


def _make_store():
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
    store = server.DataStore(Path(tempfile.mkdtemp()) / "data.json")
    store._state = state
    return store


SESSION = {"username": "admin", "role": "superadmin", "globalSuperadmin": True}


def _assert_no_deleted(rows, label):
    ghosts = [r for r in rows if isinstance(r, dict) and r.get("_deleted")]
    assert not ghosts, f"{label}: phantom tombstone rows persisted: {ghosts}"


def test_casiers_full_save():
    store = _make_store()
    store._state["casiers"] = [
        {"id": "c1", "siteId": "s1", "capacite": 24, "quantiteActuelle": 5},
    ]
    payload = {"casiers": [{"id": "c1", "siteId": "s1", "_deleted": True}]}
    store.update_state(payload, dict(SESSION))
    _assert_no_deleted(store._state["casiers"], "casiers full-save")
    assert not [r for r in store._state["casiers"] if r.get("id") == "c1"], \
        "casiers full-save: deleted casier still present"


def test_casiers_delta():
    store = _make_store()
    store._state["casiers"] = [
        {"id": "c1", "siteId": "s1", "capacite": 24, "quantiteActuelle": 5},
    ]
    payload = {
        "casiers": [{"id": "c1", "siteId": "s1", "_deleted": True}],
        "_putDelta": {"casiers": True},
    }
    store.update_state(payload, dict(SESSION))
    _assert_no_deleted(store._state["casiers"], "casiers delta")


def test_charges_full_save():
    store = _make_store()
    store._state["charges"] = [
        {"id": "ch1", "siteId": "s1", "montant": 1000},
    ]
    payload = {"charges": [{"id": "ch1", "siteId": "s1", "_deleted": True}]}
    store.update_state(payload, dict(SESSION))
    _assert_no_deleted(store._state["charges"], "charges full-save")


if __name__ == "__main__":
    test_casiers_full_save()
    test_casiers_delta()
    test_charges_full_save()
    print("OK: global-superadmin tombstones correctly stripped")
