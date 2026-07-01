"""Regression: les tombstones {_deleted:true} ne doivent PAS être persistés
comme de vraies lignes dans la branche superadmin GLOBAL de update_state.

Bug historique : la branche globale faisait `current[key] = payload[key]` sans
filtrer les tombstones envoyés par le client (voir TOMBSTONE_KEYS côté front),
ce qui laissait des lignes fantômes {id, siteId, _deleted:true} pour les comptes
admin/tanoh (et un casier fantôme vide capacité 24).

Lancer : python3 _test_global_tombstone.py
"""
import copy
import tempfile
from pathlib import Path

import server


def _make_store():
    tmp = Path(tempfile.mkdtemp()) / "data.json"
    state = copy.deepcopy(server.DEFAULT_STATE)
    state["sites"] = [{"id": "SITE1", "name": "Maquis 1"}]
    state["activeSiteId"] = "SITE1"
    state.setdefault("auth", {}).setdefault("users", [])
    state["charges"] = [
        {"id": "c1", "siteId": "SITE1", "libelle": "Loyer", "montant": 1000},
        {"id": "c2", "siteId": "SITE1", "libelle": "Eau", "montant": 200},
    ]
    state["casiers"] = [
        {"id": "k1", "siteId": "SITE1", "article": "B12", "quantiteActuelle": 5, "capacite": 12},
    ]
    store = server.DataStore(tmp)
    store._state = state
    return store


def run():
    store = _make_store()
    session = {"username": "admin", "role": "superadmin", "allowedSiteIds": ["SITE1"]}
    assert server.session_is_superadmin(session, all_site_ids=["SITE1"]), "session doit être superadmin global"

    # Le client supprime la charge c1 et le casier k1 -> envoie les lignes restantes + tombstones.
    payload = {
        "charges": [
            {"id": "c2", "siteId": "SITE1", "libelle": "Eau", "montant": 200},
            {"id": "c1", "siteId": "SITE1", "_deleted": True},
        ],
        "casiers": [
            {"id": "k1", "siteId": "SITE1", "_deleted": True},
        ],
    }
    store.update_state(payload, session)

    charges = store._state.get("charges", [])
    casiers = store._state.get("casiers", [])

    ghost_charges = [r for r in charges if isinstance(r, dict) and r.get("_deleted")]
    assert not ghost_charges, f"tombstone charge persisté: {ghost_charges}"
    ids = sorted(r.get("id") for r in charges)
    assert ids == ["c2"], f"charges attendues [c2], obtenu {ids}"

    ghost_casiers = [r for r in casiers if isinstance(r, dict) and r.get("_deleted")]
    assert not ghost_casiers, f"tombstone casier persisté (fantôme): {ghost_casiers}"
    assert casiers == [], f"casiers attendus [], obtenu {casiers}"

    print("OK: tombstones filtrés dans la branche superadmin globale")


if __name__ == "__main__":
    run()
