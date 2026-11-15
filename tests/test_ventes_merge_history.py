"""Tests — préservation de l'historique des ventes lors d'une sauvegarde partielle.

Depuis le bootstrap allégé (fenêtre chaude 90 j), le client ne détient plus tout
l'historique des ventes. Un PUT non-delta de `ventes` passe par `merge_ventes_scoped`
(remplacement total du périmètre) et supprimerait les ventes anciennes encore détenues
par le serveur. Le PUT delta (`_putDelta.ventes`) passe par `merge_scoped_rows` (upsert)
et les conserve. Ces tests verrouillent ce contrat.
"""
from __future__ import annotations

import os
import sys
import unittest
from pathlib import Path

os.environ.setdefault("MAQUIS_MANAGER_STORAGE", "memory")
os.environ.setdefault("MAQUIS_MANAGER_SKIP_AUTO_CLOTURE", "1")

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

import server  # noqa: E402


class TestVentesMergeHistory(unittest.TestCase):
    def setUp(self) -> None:
        self.site_ids = ["maquis-1"]
        self.allowed = {"maquis-1"}
        # État serveur : une vente ancienne (hors fenêtre chaude) + une récente.
        self.current = [
            {"id": 1, "siteId": "maquis-1", "date": "2026-01-10", "article": "BIERE", "prix": 1000, "qty": 1},
            {"id": 2, "siteId": "maquis-1", "date": "2026-11-10", "article": "SODA", "prix": 500, "qty": 1},
        ]
        # Charge utile « slim » du client : seulement la vente récente (fenêtre chaude),
        # avec une date décalée d'un jour (outil de décalage comptable superadmin).
        self.slim_incoming = [
            {"id": 2, "siteId": "maquis-1", "date": "2026-11-11", "article": "SODA", "prix": 500, "qty": 1},
        ]

    def test_full_replace_drops_old_history(self):
        """Le remplacement total (non-delta) supprime la vente ancienne — comportement dangereux."""
        merged = server.merge_ventes_scoped(self.current, self.slim_incoming, self.allowed, self.site_ids)
        ids = {v["id"] for v in merged}
        self.assertNotIn(1, ids, "merge_ventes_scoped devrait (par conception) remplacer tout le périmètre")
        self.assertIn(2, ids)

    def test_delta_upsert_preserves_old_history(self):
        """L'upsert delta conserve la vente ancienne absente de la charge utile."""
        merged = server.merge_scoped_rows(self.current, self.slim_incoming, self.allowed, self.site_ids)
        by_id = {v["id"]: v for v in merged}
        self.assertIn(1, by_id, "la vente ancienne hors fenêtre chaude doit être conservée")
        self.assertEqual(by_id[1]["date"], "2026-01-10", "la vente ancienne ne doit pas être modifiée")
        self.assertIn(2, by_id)
        self.assertEqual(by_id[2]["date"], "2026-11-11", "la vente récente doit refléter le décalage de date")


if __name__ == "__main__":
    unittest.main()
