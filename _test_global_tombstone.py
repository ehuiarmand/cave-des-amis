"""Regression test: tombstone rows (_deleted:true) must NOT be persisted in the
GLOBAL superadmin branch of DataStore.update_state.

Recurring bug (see automation memory): when a global superadmin (admin/tanoh)
deletes a casier / charge / consigne / etc. the client sends the row with
`_deleted: true` (a tombstone) via a NON-delta PUT /api/state. The global
branch used to store the payload verbatim, persisting phantom "ghost" rows
(e.g. an empty ghost casier of capacity 24, qty 0).

Run: python3 _test_global_tombstone.py
"""
import copy
import tempfile
from pathlib import Path

import server


def _make_store():
    tmp = Path(tempfile.mkdtemp()) / "data.json"
    store = server.DataStore(tmp)
    state = copy.deepcopy(server.DEFAULT_STATE)
    state["auth"] = {"users": [
        {"username": "admin", "role": "superadmin", "passwordHash": "x", "allowedSiteIds": []},
    ]}
    if not state.get("sites"):
        state["sites"] = [{"id": "s1", "name": "Maquis 1"}]
    state["activeSiteId"] = state["sites"][0]["id"]
    store._state = state
    return store, state["sites"][0]["id"]


def _global_session():
    return {"username": "admin", "role": "superadmin", "globalSuperadmin": True}


def test_casiers_non_delta_tombstone_stripped():
    store, sid = _make_store()
    store._state["casiers"] = [
        {"id": "c1", "siteId": sid, "article": "B", "capacite": 24, "quantiteActuelle": 5},
    ]
    # Client deletes c1 -> non-delta full save with tombstone
    store.update_state(
        {"casiers": [{"id": "c1", "siteId": sid, "_deleted": True}]},
        _global_session(),
    )
    ids = [r.get("id") for r in store._state.get("casiers", [])]
    assert "c1" not in ids, f"tombstoned casier persisted: {store._state['casiers']}"
    assert not any(r.get("_deleted") for r in store._state.get("casiers", [])), \
        f"phantom _deleted casier persisted: {store._state['casiers']}"


def test_casiers_delta_tombstone_stripped():
    store, sid = _make_store()
    store._state["casiers"] = [
        {"id": "c1", "siteId": sid, "article": "B", "capacite": 24, "quantiteActuelle": 5},
        {"id": "c2", "siteId": sid, "article": "C", "capacite": 12, "quantiteActuelle": 2},
    ]
    store.update_state(
        {"casiers": [{"id": "c1", "siteId": sid, "_deleted": True}], "_putDelta": {"casiers": True}},
        _global_session(),
    )
    ids = [r.get("id") for r in store._state.get("casiers", [])]
    assert "c1" not in ids, f"delta tombstone not applied: {store._state['casiers']}"
    assert "c2" in ids, f"delta wrongly dropped untouched casier: {store._state['casiers']}"


def test_charges_non_delta_tombstone_stripped():
    store, sid = _make_store()
    store._state["charges"] = [
        {"id": "ch1", "siteId": sid, "label": "Loyer", "montant": 1000},
    ]
    store.update_state(
        {"charges": [{"id": "ch1", "siteId": sid, "_deleted": True}]},
        _global_session(),
    )
    ids = [r.get("id") for r in store._state.get("charges", [])]
    assert "ch1" not in ids, f"tombstoned charge persisted: {store._state['charges']}"
    assert not any(r.get("_deleted") for r in store._state.get("charges", [])), \
        f"phantom _deleted charge persisted: {store._state['charges']}"


if __name__ == "__main__":
    test_casiers_non_delta_tombstone_stripped()
    test_casiers_delta_tombstone_stripped()
    test_charges_non_delta_tombstone_stripped()
    print("OK: global-branch tombstones stripped (casiers non-delta + delta, charges)")
