"""Regression test: tombstones must NOT persist as phantom rows for a global
superadmin (admin/tanoh) doing a full/non-delta PUT /api/state.

Trigger reproduced: login admin (global superadmin) -> delete a charge / casier.
The client sends the reduced array PLUS a tombstone {id, siteId, _deleted:true}
(buildStatePutBody -> applyPendingTombstones), WITHOUT _putDelta. Before the fix
the global branch did `current[key] = payload[key]` (and casiers = sanitized),
persisting the {_deleted:true} row as a corrupt ghost row.

Run: python3 _test_global_tombstone.py
"""
import json
import tempfile
from pathlib import Path

import server


def _make_store():
    tmp = Path(tempfile.mkdtemp()) / "data.json"
    state = json.loads(json.dumps(server.DEFAULT_STATE))
    state["sites"] = [{"id": "s1", "name": "Maquis 1"}]
    state["activeSiteId"] = "s1"
    state["charges"] = [
        {"id": "c1", "siteId": "s1", "libelle": "Loyer", "montant": 1000},
        {"id": "c2", "siteId": "s1", "libelle": "Eau", "montant": 200},
    ]
    state["casiers"] = [
        {"id": "k1", "siteId": "s1", "capacite": 24, "quantiteActuelle": 5},
        {"id": "k2", "siteId": "s1", "capacite": 24, "quantiteActuelle": 3},
    ]
    tmp.write_text(json.dumps(state), encoding="utf-8")
    store = server.DataStore(tmp)
    return store


GLOBAL_SESSION = {"username": "admin", "role": "superadmin", "allowedSiteIds": ["s1"]}


def _assert_no_phantom(rows, key):
    phantom = [r for r in rows if isinstance(r, dict) and r.get("_deleted")]
    assert not phantom, f"PHANTOM {key} rows persisted: {phantom}"


def test_full_save_charges_delete():
    store = _make_store()
    # client deleted c2 -> reduced array + tombstone, NO _putDelta (persistStatePatch/persistState)
    payload = {
        "charges": [
            {"id": "c1", "siteId": "s1", "libelle": "Loyer", "montant": 1000},
            {"id": "c2", "siteId": "s1", "_deleted": True},
        ],
    }
    store.update_state(payload, GLOBAL_SESSION)
    charges = store._state["charges"]
    _assert_no_phantom(charges, "charges")
    ids = {r["id"] for r in charges}
    assert ids == {"c1"}, f"expected only c1, got {ids}"
    print("OK full-save charges delete (global)")


def test_full_save_casiers_delete():
    store = _make_store()
    payload = {
        "casiers": [
            {"id": "k1", "siteId": "s1", "capacite": 24, "quantiteActuelle": 5},
            {"id": "k2", "siteId": "s1", "_deleted": True},
        ],
    }
    store.update_state(payload, GLOBAL_SESSION)
    casiers = store._state["casiers"]
    _assert_no_phantom(casiers, "casiers")
    ids = {r["id"] for r in casiers}
    assert ids == {"k1"}, f"expected only k1, got {ids}"
    print("OK full-save casiers delete (global)")


def test_delta_mode_still_works():
    store = _make_store()
    payload = {
        "_putDelta": {"charges": True},
        "charges": [{"id": "c2", "siteId": "s1", "_deleted": True}],
    }
    store.update_state(payload, GLOBAL_SESSION)
    charges = store._state["charges"]
    _assert_no_phantom(charges, "charges")
    ids = {r["id"] for r in charges}
    assert ids == {"c1"}, f"delta expected c1 kept, got {ids}"
    print("OK delta charges delete (global)")


if __name__ == "__main__":
    test_full_save_charges_delete()
    test_full_save_casiers_delete()
    test_delta_mode_still_works()
    print("ALL PASS")
