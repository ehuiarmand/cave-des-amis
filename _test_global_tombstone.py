"""Regression test : les tombstones {..., "_deleted": true} envoyés en
sauvegarde complète (sans _putDelta) par un superadmin GLOBAL (admin/tanoh)
ne doivent pas persister comme lignes fantômes.

Contexte : la suppression d'un casier / d'une charge côté client
(deleteCasier -> markRowDeleted -> persistStatePatch SANS _putDelta) ajoute
un tombstone au tableau envoyé. La branche superadmin global de
update_state faisait `current[key] = payload[key]` (ou casiers = sanitized),
conservant le tombstone -> ligne corrompue persistée puis re-synchronisée.

Lancer : python3 _test_global_tombstone.py
"""
import os
import sys
import tempfile

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
os.environ.setdefault("MAQUIS_MANAGER_STORAGE", "json")

import server  # noqa: E402


def _make_store():
    fd, path = tempfile.mkstemp(suffix=".json")
    os.close(fd)
    store = server.DataStore(server.Path(path))
    store._state["sites"] = [{"id": "s1", "nom": "Maquis 1"}]
    store._state["activeSiteId"] = "s1"
    store._state["casiers"] = [
        {"id": 1, "siteId": "s1", "code": "C1", "article": "Biere", "capacite": 24, "quantiteActuelle": 0},
        {"id": 2, "siteId": "s1", "code": "C2", "article": "Soda", "capacite": 12, "quantiteActuelle": 0},
    ]
    store._state["charges"] = [
        {"id": 10, "siteId": "s1", "lib": "Loyer", "montant": 50000},
        {"id": 11, "siteId": "s1", "lib": "Eau", "montant": 3000},
    ]
    return store, path


ADMIN_SESSION = {"username": "admin", "role": "superadmin", "allowedSiteIds": ["s1"]}


def test_casiers_full_save_strips_tombstone():
    store, path = _make_store()
    try:
        # Suppression du casier 1 : le client renvoie les casiers restants + tombstone, SANS _putDelta.
        store.update_state(
            {
                "casiers": [
                    {"id": 2, "siteId": "s1", "code": "C2", "article": "Soda", "capacite": 12, "quantiteActuelle": 0},
                    {"id": 1, "siteId": "s1", "_deleted": True},
                ],
            },
            ADMIN_SESSION,
        )
        casiers = store._state["casiers"]
        ids = sorted(c.get("id") for c in casiers)
        assert ids == [2], f"attendu [2], obtenu {ids} (casier fantôme persisté ?)"
        assert all(not c.get("_deleted") for c in casiers), f"tombstone persisté : {casiers}"
        print("OK casiers full-save : tombstone filtré, casier réellement supprimé")
    finally:
        os.unlink(path)


def test_casiers_delta_still_deletes():
    store, path = _make_store()
    try:
        payload = {
            "_putDelta": {"casiers": True},
            "casiers": [{"id": 1, "siteId": "s1", "_deleted": True}],
        }
        store.update_state(payload, ADMIN_SESSION)
        ids = sorted(c.get("id") for c in store._state["casiers"])
        assert ids == [2], f"delta : attendu [2], obtenu {ids}"
        print("OK casiers delta : suppression correcte")
    finally:
        os.unlink(path)


def test_charges_full_save_strips_tombstone():
    store, path = _make_store()
    try:
        store.update_state(
            {
                "charges": [
                    {"id": 11, "siteId": "s1", "lib": "Eau", "montant": 3000},
                    {"id": 10, "siteId": "s1", "_deleted": True},
                ],
            },
            ADMIN_SESSION,
        )
        charges = store._state["charges"]
        ids = sorted(c.get("id") for c in charges)
        assert ids == [11], f"attendu [11], obtenu {ids} (charge fantôme persistée ?)"
        assert all(not c.get("_deleted") for c in charges), f"tombstone persisté : {charges}"
        print("OK charges full-save : tombstone filtré, charge réellement supprimée")
    finally:
        os.unlink(path)


if __name__ == "__main__":
    test_casiers_full_save_strips_tombstone()
    test_casiers_delta_still_deletes()
    test_charges_full_save_strips_tombstone()
    print("\nTous les tests passent.")
