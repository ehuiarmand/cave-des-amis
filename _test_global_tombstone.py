"""Regression test: tombstones must be stripped in the GLOBAL superadmin branch.

Bug (recurring): when a global superadmin (admin/tanoh) deletes a casier /
charge / consigne, the client sends a full-save payload containing a tombstone
row {"id": X, "siteId": ..., "_deleted": true} WITHOUT _putDelta. The
non-delta path in DataStore.update_state must strip these rows; otherwise the
phantom row is persisted and reappears (e.g. a ghost empty casier capacity 24
qty 0) on the next sync.

Run: python3 _test_global_tombstone.py
"""
import copy
import tempfile
from pathlib import Path

import server


def _make_store():
    tmp = tempfile.NamedTemporaryFile(suffix=".json", delete=False)
    tmp.close()
    store = server.DataStore(Path(tmp.name))
    state = copy.deepcopy(server.DEFAULT_STATE)
    # Ensure auth.users exists (DEFAULT_STATE may vary).
    state.setdefault("auth", {})
    if not state["auth"].get("users"):
        state["auth"]["users"] = [
            {"username": "admin", "passwordHash": "x", "role": "superadmin",
             "allowedSiteIds": ["maquis-1"]},
        ]
    if not state.get("sites"):
        state["sites"] = [{"id": "maquis-1", "name": "Test"}]
        state["activeSiteId"] = "maquis-1"
    store._state = state
    return store


GLOBAL_SESSION = {
    "username": "admin",
    "role": "superadmin",
    "allowedSiteIds": ["maquis-1"],
    "globalSuperadmin": True,
}


def _assert_no_deleted(rows, label):
    ghosts = [r for r in (rows or []) if isinstance(r, dict) and r.get("_deleted")]
    assert not ghosts, f"{label}: phantom tombstone rows persisted: {ghosts}"


def test_casiers_full_save():
    store = _make_store()
    store._state["casiers"] = [
        {"id": "c1", "siteId": "maquis-1", "capacite": 24, "quantiteActuelle": 5},
    ]
    # Client full-save deleting c1 -> tombstone, NO _putDelta.
    store.update_state({"casiers": [{"id": "c1", "siteId": "maquis-1", "_deleted": True}]},
                       dict(GLOBAL_SESSION))
    _assert_no_deleted(store._state.get("casiers"), "casiers full-save")
    assert not [r for r in store._state["casiers"] if r.get("id") == "c1"], \
        "casiers full-save: c1 should be gone"


def test_casiers_delta():
    store = _make_store()
    store._state["casiers"] = [
        {"id": "c1", "siteId": "maquis-1", "capacite": 24, "quantiteActuelle": 5},
        {"id": "c2", "siteId": "maquis-1", "capacite": 24, "quantiteActuelle": 3},
    ]
    store.update_state({"casiers": [{"id": "c1", "siteId": "maquis-1", "_deleted": True}],
                        "_putDelta": {"casiers": True}}, dict(GLOBAL_SESSION))
    _assert_no_deleted(store._state.get("casiers"), "casiers delta")
    ids = {r.get("id") for r in store._state["casiers"]}
    assert ids == {"c2"}, f"casiers delta: expected only c2, got {ids}"


def test_charges_full_save():
    store = _make_store()
    store._state["charges"] = [
        {"id": "ch1", "siteId": "maquis-1", "montant": 1000},
    ]
    store.update_state({"charges": [{"id": "ch1", "siteId": "maquis-1", "_deleted": True}]},
                       dict(GLOBAL_SESSION))
    _assert_no_deleted(store._state.get("charges"), "charges full-save")


if __name__ == "__main__":
    test_casiers_full_save()
    test_casiers_delta()
    test_charges_full_save()
    print("OK: global-branch tombstones stripped (casiers full-save, casiers delta, charges)")
