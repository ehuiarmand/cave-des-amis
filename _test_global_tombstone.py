"""Régression : la branche superadmin global de DataStore.update_state ne doit pas
persister les tombstones {id, siteId, _deleted: true} envoyés par le client comme
des lignes fantômes (sinon montant absent → totaux faux, ré-affichage du fantôme).

Lancer : python _test_global_tombstone.py
"""
import tempfile
from pathlib import Path

import server


def _make_store() -> server.DataStore:
    tmp = Path(tempfile.mkdtemp()) / "state.json"
    store = server.DataStore(tmp)
    store._state["sites"] = [{"id": "ROMY", "name": "Romy"}]
    store._state["activeSiteId"] = "ROMY"
    store._state["charges"] = [
        {"id": 1, "siteId": "ROMY", "libelle": "Loyer", "montant": 50000},
        {"id": 2, "siteId": "ROMY", "libelle": "Eau", "montant": 3000},
    ]
    store._state["casiers"] = [
        {"id": 10, "siteId": "ROMY", "article": "B12", "capacite": 24, "quantiteActuelle": 5},
    ]
    return store


def test_global_superadmin_strips_tombstones() -> None:
    store = _make_store()
    session = {"username": "admin", "role": "superadmin", "globalSuperadmin": True}

    # Le client a supprimé la charge id=2 : il renvoie la liste réduite + un tombstone.
    payload = {
        "charges": [
            {"id": 1, "siteId": "ROMY", "libelle": "Loyer", "montant": 50000},
            {"id": 2, "siteId": "ROMY", "_deleted": True},
        ],
        # idem pour un casier supprimé (branche sanitisée).
        "casiers": [
            {"id": 10, "siteId": "ROMY", "article": "B12", "capacite": 24, "quantiteActuelle": 5},
            {"id": 11, "siteId": "ROMY", "_deleted": True},
        ],
    }
    store.update_state(payload, session)

    charges = store._state["charges"]
    assert all(not c.get("_deleted") for c in charges), f"tombstone persistée : {charges}"
    assert {c["id"] for c in charges} == {1}, f"charges inattendues : {charges}"

    casiers = store._state["casiers"]
    assert all(not c.get("_deleted") for c in casiers), f"casier fantôme persisté : {casiers}"
    assert {c["id"] for c in casiers} == {10}, f"casiers inattendus : {casiers}"
    print("OK test_global_superadmin_strips_tombstones")


if __name__ == "__main__":
    test_global_superadmin_strips_tombstones()
    print("All tests passed.")
