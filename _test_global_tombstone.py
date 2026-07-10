"""Regression test: tombstones ({..., "_deleted": true}) must NOT be persisted
by the GLOBAL superadmin branch of DataStore.update_state.

Historically the global-superadmin branch (admin / tanoh) stored casiers and
generic collections raw, keeping the client tombstone rows. Result: deleted
casiers/charges reappeared as phantom rows (e.g. an empty casier cap 24 qte 0)
for global superadmins only — scoped superadmins were unaffected because their
branch always goes through merge_scoped_rows (which strips _deleted).

Run: python3 _test_global_tombstone.py
"""
import tempfile
from pathlib import Path

import server


def _make_store():
    tmp = tempfile.NamedTemporaryFile(suffix=".json", delete=False)
    tmp.close()
    store = server.DataStore(Path(tmp.name))
    sites = store._state.get("sites") or [{"id": "s1", "name": "Maquis 1"}]
    if not store._state.get("sites"):
        store._state["sites"] = sites
    site_id = str(sites[0]["id"])
    # Ensure auth.users exists (DEFAULT_STATE.auth has no users).
    store._state["auth"] = {
        "users": [
            {
                "username": "admin",
                "passwordHash": server.hash_password("x"),
                "role": "superadmin",
                "allowedSiteIds": [site_id],
            }
        ]
    }
    return store, site_id


def _global_session(site_id):
    return {
        "username": "admin",
        "role": "superadmin",
        "allowedSiteIds": [site_id],
        "globalSuperadmin": True,
    }


def test_casiers_full_save_strips_tombstone():
    store, sid = _make_store()
    store._state["casiers"] = [
        {"id": "c1", "siteId": sid, "quantiteActuelle": 3, "capacite": 24},
        {"id": "c2", "siteId": sid, "quantiteActuelle": 5, "capacite": 24},
    ]
    payload = {
        "casiers": [
            {"id": "c1", "siteId": sid, "_deleted": True},
            {"id": "c2", "siteId": sid, "quantiteActuelle": 5, "capacite": 24},
        ]
    }
    store.update_state(payload, _global_session(sid))
    ids = {r.get("id") for r in store._state["casiers"]}
    assert "c1" not in ids, f"phantom casier persisted: {store._state['casiers']}"
    assert "c2" in ids
    assert all(not r.get("_deleted") for r in store._state["casiers"])
    print("OK casiers full-save strips tombstone")


def test_casiers_delta_strips_tombstone():
    store, sid = _make_store()
    store._state["casiers"] = [
        {"id": "c1", "siteId": sid, "quantiteActuelle": 3, "capacite": 24},
    ]
    payload = {
        "casiers": [{"id": "c1", "siteId": sid, "_deleted": True}],
        "_putDelta": {"casiers": True},
    }
    store.update_state(payload, _global_session(sid))
    ids = {r.get("id") for r in store._state["casiers"]}
    assert "c1" not in ids, f"phantom casier persisted (delta): {store._state['casiers']}"
    print("OK casiers delta strips tombstone")


def test_charges_full_save_strips_tombstone():
    store, sid = _make_store()
    store._state["charges"] = [
        {"id": "ch1", "siteId": sid, "montant": 1000},
        {"id": "ch2", "siteId": sid, "montant": 2000},
    ]
    payload = {
        "charges": [
            {"id": "ch1", "siteId": sid, "_deleted": True},
            {"id": "ch2", "siteId": sid, "montant": 2000},
        ]
    }
    store.update_state(payload, _global_session(sid))
    ids = {r.get("id") for r in store._state["charges"]}
    assert "ch1" not in ids, f"phantom charge persisted: {store._state['charges']}"
    assert "ch2" in ids
    assert all(not r.get("_deleted") for r in store._state["charges"])
    print("OK charges full-save strips tombstone")


if __name__ == "__main__":
    test_casiers_full_save_strips_tombstone()
    test_casiers_delta_strips_tombstone()
    test_charges_full_save_strips_tombstone()
    print("ALL TESTS PASSED")
