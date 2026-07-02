"""Régression : un superadmin global (admin/tanoh) ne doit jamais laisser
persister de ligne fantôme {id, siteId, _deleted:true} après suppression.

Le client retire la ligne du tableau ET ajoute un tombstone explicite pour
forcer la suppression côté fusion. Le branchement scopé (merge_scoped_rows)
retire déjà ces tombstones ; le branchement superadmin global les gardait en
remplacement complet -> lignes fantômes corrompues (charge/casier/consigne...).

Usage : python3 _test_global_tombstone.py
"""
import tempfile
from pathlib import Path

import server


def make_store():
    tmp = Path(tempfile.mkdtemp()) / "data.json"
    store = server.DataStore(tmp)
    store._state = {
        "sites": [{"id": "SITE_A", "name": "Maquis A"}, {"id": "SITE_B", "name": "Maquis B"}],
        "activeSiteId": "SITE_A",
        "ventes": [],
        "stock": [],
        "commandes": [],
        "stockChecks": [],
        "dayBooks": [],
        "purchaseOrders": [],
        "supplierPrices": [],
        "casiers": [
            {"id": 10, "siteId": "SITE_A", "code": "C10", "article": "Beer", "capacite": 24, "quantiteActuelle": 5},
            {"id": 11, "siteId": "SITE_A", "code": "C11", "article": "Beer", "capacite": 24, "quantiteActuelle": 3},
        ],
        "casierMouvements": [],
        "creditRecoveries": [],
        "clientAvoirs": [],
        "loyaltyClients": [],
        "consignes": [],
        "charges": [
            {"id": 1, "siteId": "SITE_A", "lib": "Loyer", "montant": 100, "cat": "Fixe", "date": "2026-07-01", "paiement": "Espèces"},
            {"id": 2, "siteId": "SITE_A", "lib": "Eau", "montant": 20, "cat": "Fixe", "date": "2026-07-01", "paiement": "Espèces"},
        ],
        "staffAuditLog": [],
        "stockEntrees": [],
        "stockLosses": [],
        "restaurantMenu": [],
        "ingredientStock": [],
        "workShifts": [],
        "categories": [],
        "nextId": {},
        "auth": {"users": [{"username": "admin", "role": "superadmin", "allowedSiteIds": ["SITE_A", "SITE_B"], "passwordHash": "x"}]},
    }
    return store


def session_admin():
    return {"username": "admin", "role": "superadmin", "allowedSiteIds": ["SITE_A", "SITE_B"]}


def count_phantoms(rows):
    return sum(1 for r in rows if isinstance(r, dict) and r.get("_deleted"))


def run():
    sess = session_admin()
    assert server.session_is_superadmin(sess, all_site_ids=["SITE_A", "SITE_B"]), (
        "admin doit être superadmin global pour ce test"
    )

    failures = []

    # 1) Suppression d'une charge (full save, sans _putDelta) — chemin le plus courant.
    store = make_store()
    payload = {
        "charges": [
            {"id": 2, "siteId": "SITE_A", "lib": "Eau", "montant": 20, "cat": "Fixe", "date": "2026-07-01", "paiement": "Espèces"},
            {"id": 1, "siteId": "SITE_A", "_deleted": True},  # tombstone
        ],
    }
    store.update_state(payload, sess)
    charges = store._state["charges"]
    ids = sorted(str(c.get("id")) for c in charges)
    ph = count_phantoms(charges)
    if ph != 0:
        failures.append(f"charges: {ph} ligne(s) fantôme(s) _deleted persistée(s) -> {charges}")
    if ids != ["2"]:
        failures.append(f"charges: état final inattendu, ids={ids} (attendu ['2'])")

    # 2) Suppression d'un casier (full save, sans _putDelta).
    store = make_store()
    payload = {
        "casiers": [
            {"id": 11, "siteId": "SITE_A", "code": "C11", "article": "Beer", "capacite": 24, "quantiteActuelle": 3},
            {"id": 10, "siteId": "SITE_A", "_deleted": True},  # tombstone
        ],
    }
    store.update_state(payload, sess)
    casiers = store._state["casiers"]
    ph = count_phantoms(casiers)
    ids = sorted(str(c.get("id")) for c in casiers)
    if ph != 0:
        failures.append(f"casiers: {ph} casier fantôme _deleted persisté -> {casiers}")
    if ids != ["11"]:
        failures.append(f"casiers: état final inattendu, ids={ids} (attendu ['11'])")

    # 3) Mode delta (_putDelta) : la suppression doit toujours fonctionner.
    store = make_store()
    payload = {
        "_putDelta": {"charges": True},
        "charges": [{"id": 1, "siteId": "SITE_A", "_deleted": True}],
    }
    store.update_state(payload, sess)
    charges = store._state["charges"]
    ph = count_phantoms(charges)
    ids = sorted(str(c.get("id")) for c in charges)
    if ph != 0:
        failures.append(f"charges (delta): {ph} fantôme(s) -> {charges}")
    if ids != ["2"]:
        failures.append(f"charges (delta): suppression non appliquée, ids={ids} (attendu ['2'])")

    if failures:
        print("FAIL")
        for f in failures:
            print(" -", f)
        raise SystemExit(1)
    print("OK — aucun tombstone fantôme persisté pour superadmin global (charges + casiers, full & delta)")


if __name__ == "__main__":
    run()
