"""Régression encaissement : la commande encaissée doit disparaître côté serveur.

Contexte du bug (v388) : finalizeOrder envoyait un tombstone commande
`[{id, _deleted:true}]` avec `_putDelta.commandes=true`. Or persistStatePatch
réécrit `patch.commandes = state.commandes` (liste complète SANS la commande
encaissée) tout en conservant le flag `_putDelta.commandes`. Le serveur faisait
alors un upsert (merge_scoped_rows) qui NE supprime pas une ligne simplement
absente : la commande encaissée restait en base et réapparaissait comme
commande ouverte (et s'accumulait indéfiniment).

Ce test verrouille les deux sémantiques de fusion utilisées côté serveur.
Lancer : `python3 _test_encaissement_commandes.py`
"""

import server

SITES = ["S1"]
ALLOWED = {"S1"}


def _order(oid):
    return {"id": oid, "siteId": "S1", "client": f"C{oid}", "lignes": [{"article": "Biere", "qty": 1, "prix": 500}]}


def test_full_replacement_removes_encaissed_order():
    """merge_commandes_scoped (remplacement complet) : commande absente = retirée."""
    current = [_order(1), _order(2)]  # 2 = commande encaissée
    incoming = [_order(1)]  # state.commandes après encaissement (sans #2)
    merged = server.merge_commandes_scoped(current, incoming, ALLOWED, SITES, ventes=[])
    ids = sorted(int(o["id"]) for o in merged)
    assert ids == [1], f"attendu [1], obtenu {ids} — la commande encaissée n'a pas été retirée"


def test_delta_upsert_without_tombstone_keeps_order():
    """merge_scoped_rows (delta) : commande absente SANS tombstone = conservée (d'où le bug)."""
    current = [_order(1), _order(2)]
    incoming = [_order(1)]  # pas de tombstone pour #2
    merged = server.merge_scoped_rows(current, incoming, ALLOWED, SITES)
    ids = sorted(int(o["id"]) for o in merged)
    assert ids == [1, 2], f"attendu [1, 2] (upsert conserve #2), obtenu {ids}"


def test_delta_upsert_with_tombstone_removes_order():
    """merge_scoped_rows (delta) : tombstone explicite = suppression effective."""
    current = [_order(1), _order(2)]
    incoming = [_order(1), {"id": 2, "siteId": "S1", "_deleted": True}]
    merged = server.merge_scoped_rows(current, incoming, ALLOWED, SITES)
    ids = sorted(int(o["id"]) for o in merged)
    assert ids == [1], f"attendu [1] (tombstone supprime #2), obtenu {ids}"


if __name__ == "__main__":
    test_full_replacement_removes_encaissed_order()
    test_delta_upsert_without_tombstone_keeps_order()
    test_delta_upsert_with_tombstone_removes_order()
    print("OK : sémantiques de fusion commandes verrouillées (encaissement)")
