"""Regression : le decalage des dates comptables (superadmin) ne doit jamais effacer
les ventes hors fenetre chaude.

Depuis l'historique hot/cold, le client ne recoit au login que la fenetre chaude
(HISTORY_HOT_DAYS). Un PUT /api/state global superadmin qui renvoie ce sous-ensemble
de `ventes` SANS `_putDelta` passe par merge_ventes_scoped (remplacement total du
perimetre) et supprime definitivement les ventes plus anciennes en mode JSON.
Le correctif envoie `ventes` en delta (`_putDelta: {ventes: true}`) -> merge_scoped_rows
(upsert) qui conserve les lignes absentes du payload.
"""
from __future__ import annotations

import os
import sys
import tempfile
import unittest
from pathlib import Path

os.environ.setdefault("MAQUIS_MANAGER_STORAGE", "memory")
os.environ.setdefault("MAQUIS_MANAGER_SKIP_AUTO_CLOTURE", "1")

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

import server  # noqa: E402

SUPERADMIN = {"username": "admin", "role": "superadmin", "globalSuperadmin": True}


def _make_store() -> "server.DataStore":
    store = server.DataStore(Path(tempfile.mkdtemp()) / "data.json")
    store._state = {
        "sites": [{"id": "maquis-1", "nom": "Maquis Un"}],
        "auth": {"users": []},
        "activeSiteId": "maquis-1",
        "ventes": [
            {"id": 1, "siteId": "maquis-1", "date": "2020-01-01", "article": "Vieille", "prix": 1000, "qty": 1},
            {"id": 2, "siteId": "maquis-1", "date": "2026-11-01", "article": "Recente", "prix": 2000, "qty": 1},
        ],
        "nextId": {},
        "_meta": {"rev": 1, "updatedAt": ""},
    }
    return store


def _vente_ids(store: "server.DataStore") -> set[int]:
    return {int(v["id"]) for v in store._state.get("ventes", [])}


class JournalShiftVentesTests(unittest.TestCase):
    def test_delta_put_preserves_out_of_window_ventes(self):
        """Correctif : le client ne renvoie que la vente chaude (id=2), en delta."""
        store = _make_store()
        store.update_state(
            {
                "_putDelta": {"ventes": True},
                "ventes": [{"id": 2, "siteId": "maquis-1", "date": "2026-11-02", "article": "Recente", "prix": 2000, "qty": 1}],
            },
            SUPERADMIN,
        )
        self.assertEqual(_vente_ids(store), {1, 2}, "la vente ancienne (id=1) doit survivre")
        recente = next(v for v in store._state["ventes"] if v["id"] == 2)
        self.assertEqual(recente["date"], "2026-11-02", "la date decalee doit etre persistee")

    def test_full_put_without_delta_drops_history(self):
        """Documente le danger : sans _putDelta, un payload partiel efface l'historique."""
        store = _make_store()
        store.update_state(
            {"ventes": [{"id": 2, "siteId": "maquis-1", "date": "2026-11-02", "article": "Recente", "prix": 2000, "qty": 1}]},
            SUPERADMIN,
        )
        self.assertEqual(_vente_ids(store), {2}, "sans delta, merge_ventes_scoped supprime id=1")


if __name__ == "__main__":
    unittest.main()
