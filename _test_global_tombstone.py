"""Régression : les tombstones (_deleted) ne doivent PAS être persistés comme
lignes fantômes dans la branche superadmin GLOBAL (admin/tanoh).

Bug récurrent : dans update_state, la branche superadmin global stockait
directement les lignes du payload pour casiers (non-delta) et via le `else`
générique, conservant les lignes {id, siteId, _deleted:true}. Résultat côté
admin/tanoh : casier fantôme (capacité 24, quantité 0), charge/consigne
fantôme, etc.

Les utilisateurs scopés ne sont pas touchés (branche scopée utilise toujours
merge_scoped_rows), d'où l'échappement au test manuel superadmin scopé.

Exécution : python3 _test_global_tombstone.py
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


SESSION = {
    "username": "admin",
    "role": "superadmin",
    "allowedSiteIds": ["s1"],
    "globalSuperadmin": True,
}


def has_deleted(rows):
    return any(isinstance(r, dict) and r.get("_deleted") for r in (rows or []))


def test_casiers_full_save():
    store = make_store()
    store._state["casiers"] = [
        {"id": "c1", "siteId": "s1", "quantiteActuelle": 5, "capacite": 24},
    ]
    payload = {"casiers": [{"id": "c1", "siteId": "s1", "_deleted": True}]}
    store.update_state(payload, SESSION)
    casiers = store._state.get("casiers", [])
    assert not has_deleted(casiers), f"casier fantôme (full-save): {casiers}"
    assert all(r.get("id") != "c1" for r in casiers), f"c1 non supprimé: {casiers}"
    print("OK casiers full-save")


def test_casiers_delta():
    store = make_store()
    store._state["casiers"] = [
        {"id": "c1", "siteId": "s1", "quantiteActuelle": 5, "capacite": 24},
        {"id": "c2", "siteId": "s1", "quantiteActuelle": 3, "capacite": 24},
    ]
    payload = {
        "casiers": [{"id": "c1", "siteId": "s1", "_deleted": True}],
        "_putDelta": {"casiers": True},
    }
    store.update_state(payload, SESSION)
    casiers = store._state.get("casiers", [])
    assert not has_deleted(casiers), f"casier fantôme (delta): {casiers}"
    ids = {r.get("id") for r in casiers}
    assert ids == {"c2"}, f"delta casiers incorrect: {casiers}"
    print("OK casiers delta")


def test_charges_full_save():
    store = make_store()
    store._state["charges"] = [
        {"id": "ch1", "siteId": "s1", "montant": 1000, "libelle": "loyer"},
    ]
    payload = {"charges": [{"id": "ch1", "siteId": "s1", "_deleted": True}]}
    store.update_state(payload, SESSION)
    charges = store._state.get("charges", [])
    assert not has_deleted(charges), f"charge fantôme (full-save): {charges}"
    assert all(r.get("id") != "ch1" for r in charges), f"ch1 non supprimé: {charges}"
    print("OK charges full-save")


if __name__ == "__main__":
    test_casiers_full_save()
    test_casiers_delta()
    test_charges_full_save()
    print("\nTOUS LES TESTS PASSENT")
