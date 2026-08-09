"""Regression test : un superadmin global supprimant une ligne d'une collection
à tombstone (charges, casiers, ...) ne doit PAS persister la ligne tombstone
{id, siteId, _deleted: true} comme une ligne fantôme.

Bug d'origine : la branche superadmin global de DataStore.update_state faisait
`current[_key] = payload[_key]` sans filtrer les tombstones ajoutées par le
client (commit 048ec96), alors que la branche scopée les filtrait via
merge_scoped_rows. Résultat : ligne fantôme persistée (montant absent → total
NaN côté client, ré-affichage du fantôme, persistance en base).

Lancer : python test_tombstone_global_superadmin.py
"""
import os
import tempfile
from pathlib import Path

os.environ.setdefault("MAQUIS_MANAGER_STORAGE", "json")

import server


def _new_store() -> "server.DataStore":
    tmp = Path(tempfile.mkdtemp()) / "data.json"
    return server.DataStore(tmp)


def _global_super_session() -> dict:
    return {
        "username": "admin",
        "role": "superadmin",
        "allowedSiteIds": [],
        "globalSuperadmin": True,
    }


def test_global_superadmin_charge_deletion_drops_tombstone() -> None:
    store = _new_store()
    site_id = store.all_site_ids()[0]

    # État initial : deux charges sur le maquis.
    store._state["charges"] = [
        {"id": 1, "siteId": site_id, "lib": "Loyer", "montant": 50000,
         "cat": "Fixe", "paiement": "Espèces", "date": "2026-06-01"},
        {"id": 2, "siteId": site_id, "lib": "Eau", "montant": 12000,
         "cat": "Fixe", "paiement": "Espèces", "date": "2026-06-02"},
    ]

    session = _global_super_session()
    assert server.session_is_superadmin(session, all_site_ids=store.all_site_ids())

    # Le client supprime la charge #2 : il envoie le reste + une tombstone.
    payload = {
        "activeSiteId": site_id,
        "charges": [
            {"id": 1, "siteId": site_id, "lib": "Loyer", "montant": 50000,
             "cat": "Fixe", "paiement": "Espèces", "date": "2026-06-01"},
            {"id": 2, "siteId": site_id, "_deleted": True},
        ],
    }
    store.update_state(payload, session)

    charges = store._state["charges"]
    ids = sorted(c.get("id") for c in charges)
    assert ids == [1], f"attendu [1], obtenu {ids} (charges={charges})"
    assert all(not c.get("_deleted") for c in charges), \
        f"tombstone persistée comme ligne fantôme : {charges}"
    # Pas de NaN possible : toutes les lignes ont un montant numérique.
    total = sum(c.get("montant", 0) for c in charges)
    assert total == 50000, f"total inattendu : {total}"
    print("OK: tombstone supprimée, charge #1 conservée, total =", total)


def test_global_superadmin_casier_deletion_drops_tombstone() -> None:
    store = _new_store()
    site_id = store.all_site_ids()[0]
    store._state["casiers"] = [
        {"id": 10, "siteId": site_id, "capacite": 24, "quantiteActuelle": 5},
        {"id": 11, "siteId": site_id, "capacite": 24, "quantiteActuelle": 3},
    ]
    session = _global_super_session()
    payload = {
        "activeSiteId": site_id,
        "casiers": [
            {"id": 10, "siteId": site_id, "capacite": 24, "quantiteActuelle": 5},
            {"id": 11, "siteId": site_id, "_deleted": True},
        ],
    }
    store.update_state(payload, session)
    casiers = store._state["casiers"]
    ids = sorted(c.get("id") for c in casiers)
    assert ids == [10], f"attendu [10], obtenu {ids} (casiers={casiers})"
    assert all(not c.get("_deleted") for c in casiers), \
        f"tombstone casier persistée : {casiers}"
    print("OK: tombstone casier supprimée, casier #10 conservé")


if __name__ == "__main__":
    test_global_superadmin_charge_deletion_drops_tombstone()
    test_global_superadmin_casier_deletion_drops_tombstone()
    print("Tous les tests passent.")
