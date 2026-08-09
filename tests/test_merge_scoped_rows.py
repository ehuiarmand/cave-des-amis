"""Tests unitaires — fusion par id (merge_scoped_rows) et lignes orphelines.

Exécution : python3 -m unittest tests.test_merge_scoped_rows -v
(depuis la racine du dépôt).

Régression couverte : le stock est désormais toujours fusionné par id côté
serveur (commit b9243bc). Sans traitement des lignes « orphelines » (siteId
absent, données d'anciennes migrations), un superadmin global ne pouvait plus
modifier ni supprimer ces lignes — ses écritures étaient silencieusement
ignorées, réintroduisant le bug « réception/vente qui n'impacte pas le stock ».
"""
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from server import merge_scoped_rows  # noqa: E402


ALL_SITES = ["maquis-1", "maquis-2"]


class GlobalSuperadminOrphanRows(unittest.TestCase):
    """Périmètre couvrant tous les maquis (superadmin global)."""

    def test_orphan_row_update_is_applied(self):
        current = [{"id": 1, "siteId": None, "article": "CASTEL 50", "reserve": 10}]
        incoming = [{"id": 1, "siteId": None, "article": "CASTEL 50", "reserve": 34}]
        merged = merge_scoped_rows(current, incoming, set(ALL_SITES), ALL_SITES)
        by_id = {r["id"]: r for r in merged}
        self.assertEqual(by_id[1]["reserve"], 34, "La mise à jour d'une ligne orpheline doit être appliquée.")

    def test_orphan_row_deletion_via_tombstone(self):
        current = [
            {"id": 1, "siteId": None, "article": "CASTEL 50"},
            {"id": 2, "siteId": "maquis-1", "article": "BEAUFORT"},
        ]
        incoming = [
            {"id": 1, "siteId": None, "_deleted": True},
            {"id": 2, "siteId": "maquis-1", "article": "BEAUFORT"},
        ]
        merged = merge_scoped_rows(current, incoming, set(ALL_SITES), ALL_SITES)
        ids = {r["id"] for r in merged}
        self.assertNotIn(1, ids, "Le tombstone d'une ligne orpheline doit supprimer la ligne.")
        self.assertIn(2, ids)

    def test_orphan_row_absent_from_delta_is_kept(self):
        # Delta partiel : la ligne orpheline non renvoyée reste présente (pas de perte).
        current = [
            {"id": 1, "siteId": None, "article": "CASTEL 50", "reserve": 10},
            {"id": 2, "siteId": "maquis-1", "article": "BEAUFORT", "reserve": 5},
        ]
        incoming = [{"id": 2, "siteId": "maquis-1", "article": "BEAUFORT", "reserve": 8}]
        merged = merge_scoped_rows(current, incoming, set(ALL_SITES), ALL_SITES)
        by_id = {r["id"]: r for r in merged}
        self.assertIn(1, by_id, "Une ligne orpheline absente du delta ne doit pas disparaître.")
        self.assertEqual(by_id[1]["reserve"], 10)
        self.assertEqual(by_id[2]["reserve"], 8)


class ScopedSessionOrphanRows(unittest.TestCase):
    """Périmètre restreint (superadmin scopé / gérant sur un sous-ensemble)."""

    def test_orphan_row_untouched_by_partial_scoped_session(self):
        # Parc de 3 maquis, session limitée à 2 d'entre eux : la ligne orpheline
        # reste ambiguë (siteId indéterminable) et ne doit donc pas être modifiée
        # ni supprimée — comportement inchangé par le correctif.
        three_sites = ["maquis-1", "maquis-2", "maquis-3"]
        current = [{"id": 1, "siteId": None, "article": "CASTEL 50", "reserve": 10}]
        incoming = [{"id": 1, "siteId": None, "_deleted": True}]
        merged = merge_scoped_rows(current, incoming, {"maquis-1", "maquis-2"}, three_sites)
        ids = {r["id"] for r in merged}
        self.assertIn(1, ids, "Une session scopée partielle ne doit pas toucher une ligne orpheline ambiguë.")

    def test_single_site_orphan_resolves_to_that_site(self):
        # Déploiement mono-site : la ligne orpheline appartient forcément à l'unique maquis.
        current = [{"id": 1, "siteId": None, "article": "CASTEL 50", "reserve": 10}]
        incoming = [{"id": 1, "siteId": None, "article": "CASTEL 50", "reserve": 20}]
        merged = merge_scoped_rows(current, incoming, {"maquis-1"}, ["maquis-1"])
        by_id = {r["id"]: r for r in merged}
        self.assertEqual(by_id[1]["reserve"], 20)


class NormalRowsRegression(unittest.TestCase):
    """Les lignes avec siteId valide continuent de fonctionner (non-régression)."""

    def test_upsert_and_delete_scoped_rows(self):
        current = [
            {"id": 1, "siteId": "maquis-1", "article": "A", "reserve": 1},
            {"id": 2, "siteId": "maquis-2", "article": "B", "reserve": 2},
        ]
        incoming = [
            {"id": 1, "siteId": "maquis-1", "article": "A", "reserve": 9},
            {"id": 3, "siteId": "maquis-1", "_deleted": True},
        ]
        merged = merge_scoped_rows(current, incoming, {"maquis-1"}, ALL_SITES)
        by_id = {r["id"]: r for r in merged}
        self.assertEqual(by_id[1]["reserve"], 9)
        # La ligne d'un autre maquis (hors périmètre) reste intacte.
        self.assertEqual(by_id[2]["reserve"], 2)


if __name__ == "__main__":
    unittest.main()
