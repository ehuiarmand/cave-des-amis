"""Régression : les tombstones (_deleted) doivent être purgés par la branche
superadmin GLOBAL de DataStore.update_state (pas seulement la branche scopée).

Bug récurrent : pour un superadmin global (admin/tanoh), la sauvegarde
non-delta d'une collection (casiers ou clé générique via tombstone) réinjectait
les lignes {id, siteId, _deleted:true} telles quelles dans l'état persistant,
créant des lignes fantômes (ex. casier vide capacité 24, quantité 0).

Lancer : python3 _test_global_tombstone.py
"""
import copy
import sys
from pathlib import Path

import server


def _make_store():
    store = server.DataStore(Path("/tmp/_tombstone_test_data.json"))
    state = copy.deepcopy(server.DEFAULT_STATE)
    state["sites"] = [{"id": "s1", "nom": "Maquis 1"}]
    state["activeSiteId"] = "s1"
    state.setdefault("auth", {})
    state["auth"] = {"users": [
        {"username": "admin", "passwordHash": "x", "role": "superadmin", "allowedSiteIds": ["s1"]},
    ]}
    store._state = state
    return store


GLOBAL_SESSION = {"username": "admin", "role": "superadmin", "globalSuperadmin": True, "allowedSiteIds": ["s1"]}


def test_casiers_full_save_strips_tombstone():
    store = _make_store()
    store._state["casiers"] = [
        {"id": "c1", "siteId": "s1", "article": "Castel", "capacite": 24, "quantiteActuelle": 12},
    ]
    # Le client supprime c1 : envoie un tombstone en sauvegarde complète (pas de _putDelta).
    payload = {"casiers": [{"id": "c1", "siteId": "s1", "_deleted": True}]}
    store.update_state(payload, dict(GLOBAL_SESSION))
    remaining = store._state["casiers"]
    assert remaining == [], f"tombstone casier persisté (full-save global): {remaining}"


def test_casiers_delta_strips_tombstone():
    store = _make_store()
    store._state["casiers"] = [
        {"id": "c1", "siteId": "s1", "article": "Castel", "capacite": 24, "quantiteActuelle": 12},
        {"id": "c2", "siteId": "s1", "article": "Beaufort", "capacite": 24, "quantiteActuelle": 5},
    ]
    payload = {"casiers": [{"id": "c1", "siteId": "s1", "_deleted": True}], "_putDelta": {"casiers": True}}
    store.update_state(payload, dict(GLOBAL_SESSION))
    ids = sorted(str(r.get("id")) for r in store._state["casiers"])
    assert ids == ["c2"], f"delta casier: attendu ['c2'], obtenu {ids}"


def test_charges_full_save_strips_tombstone():
    store = _make_store()
    store._state["charges"] = [
        {"id": 1, "siteId": "s1", "lib": "Loyer", "montant": 1000},
    ]
    payload = {"charges": [{"id": 1, "siteId": "s1", "_deleted": True}]}
    store.update_state(payload, dict(GLOBAL_SESSION))
    remaining = store._state["charges"]
    assert not any(r.get("_deleted") for r in remaining), f"tombstone charge persisté: {remaining}"
    assert all(r.get("id") != 1 for r in remaining), f"charge 1 non supprimée: {remaining}"


if __name__ == "__main__":
    failures = 0
    for name, fn in list(globals().items()):
        if name.startswith("test_") and callable(fn):
            try:
                fn()
                print(f"PASS {name}")
            except AssertionError as e:
                failures += 1
                print(f"FAIL {name}: {e}")
    if failures:
        print(f"\n{failures} test(s) échoué(s)")
        sys.exit(1)
    print("\nTous les tests OK")
