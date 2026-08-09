"""Regression test: tombstones must be stripped in the GLOBAL superadmin branch.

Bug (recurring): when a global superadmin (admin/tanoh or a superadmin covering
all sites) deletes a row, the client sends a full-save patch containing an
explicit tombstone {"id": X, "siteId": ..., "_deleted": true} WITHOUT the
`_putDelta` flag for that key. The global branch of DataStore.update_state used
to store the payload verbatim (`current[key] = payload[key]` / `current["casiers"]
= sanitized`), persisting the phantom `_deleted` row. On the next sync the ghost
row reappears (e.g. an empty casier of capacity 24, quantity 0).

Run: python3 _test_global_tombstone.py
"""
import json
import tempfile
from pathlib import Path

import server


def make_store():
    tmp = tempfile.NamedTemporaryFile(mode="w", suffix=".json", delete=False)
    state = json.loads(json.dumps(server.DEFAULT_STATE))
    state["sites"] = [{"id": "s1", "name": "Maquis 1"}]
    state["activeSiteId"] = "s1"
    state["auth"] = {"users": [
        {"username": "admin", "passwordHash": "", "role": "superadmin", "allowedSiteIds": ["s1"]},
    ]}
    state["casiers"] = [
        {"id": "c1", "siteId": "s1", "article": "Beer", "capacite": 24, "quantiteActuelle": 5},
    ]
    state["charges"] = [
        {"id": "ch1", "siteId": "s1", "libelle": "Loyer", "montant": 1000},
    ]
    tmp.write(json.dumps(state))
    tmp.flush()
    tmp.close()
    store = server.DataStore(Path(tmp.name))
    store._state = state
    return store


GLOBAL_SESSION = {"username": "admin", "role": "superadmin", "globalSuperadmin": True}


def test_charges_full_save_tombstone():
    store = make_store()
    store.update_state(
        {"charges": [{"id": "ch1", "siteId": "s1", "_deleted": True}]},
        GLOBAL_SESSION,
    )
    charges = store._state.get("charges", [])
    assert charges == [], f"charge tombstone not stripped (full save): {charges}"
    print("OK charges full-save tombstone stripped")


def test_casiers_full_save_tombstone():
    store = make_store()
    store.update_state(
        {"casiers": [{"id": "c1", "siteId": "s1", "_deleted": True}]},
        GLOBAL_SESSION,
    )
    casiers = store._state.get("casiers", [])
    assert casiers == [], f"casier tombstone not stripped (full save): {casiers}"
    print("OK casiers full-save tombstone stripped")


def test_casiers_delta_tombstone():
    store = make_store()
    store.update_state(
        {
            "casiers": [{"id": "c1", "siteId": "s1", "_deleted": True}],
            "_putDelta": {"casiers": True},
        },
        GLOBAL_SESSION,
    )
    casiers = store._state.get("casiers", [])
    assert casiers == [], f"casier tombstone not stripped (delta): {casiers}"
    print("OK casiers delta tombstone stripped")


if __name__ == "__main__":
    test_charges_full_save_tombstone()
    test_casiers_full_save_tombstone()
    test_casiers_delta_tombstone()
    print("ALL TESTS PASSED")
