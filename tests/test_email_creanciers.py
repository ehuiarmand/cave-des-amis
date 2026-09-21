"""Tests — crédits clients dans le point e-mail quotidien."""
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


class TestCreditClientsEmail(unittest.TestCase):
    def test_outstanding_entries_dates_and_amounts(self):
        ventes = [
            {
                "siteId": "maquis-1",
                "debiteur": "M. KOFFI",
                "date": "2026-09-01",
                "prix": 10000,
                "qty": 1,
                "remise": 0,
                "paiement": "Crédit client",
            },
            {
                "siteId": "maquis-1",
                "debiteur": "M. KOFFI",
                "date": "2026-09-10",
                "prix": 5000,
                "qty": 1,
                "remise": 0,
                "paiementDetails": [{"method": "Crédit client", "amount": 5000}],
            },
            {
                "siteId": "maquis-1",
                "debiteur": "AMEDE",
                "date": "2026-09-12",
                "prix": 8000,
                "qty": 1,
                "remise": 0,
                "paiement": "Crédit client",
            },
            {
                "siteId": "maquis-2",
                "debiteur": "AUTRE",
                "date": "2026-09-12",
                "prix": 999,
                "qty": 1,
                "remise": 0,
                "paiement": "Crédit client",
            },
        ]
        recoveries = [
            {"siteId": "maquis-1", "debiteur": "M. KOFFI", "montant": 4000},
        ]
        entries = server._credit_outstanding_entries("maquis-1", ventes, recoveries)
        by_name = {name: (amount, opened) for name, amount, opened in entries}
        self.assertEqual(by_name["M. KOFFI"][0], 11000)  # 15000 - 4000
        self.assertEqual(by_name["M. KOFFI"][1], "01/09/2026")
        self.assertEqual(by_name["AMEDE"][0], 8000)
        self.assertEqual(by_name["AMEDE"][1], "12/09/2026")
        self.assertNotIn("AUTRE", by_name)
        # Tri décroissant par montant
        self.assertEqual(entries[0][0], "M. KOFFI")

    def test_report_lists_credit_clients_not_suppliers(self):
        body = server._format_daily_ventes_report(
            {"id": "maquis-1", "nom": "CAVE DES AMIS"},
            "2026-09-16",
            ventes=[
                {
                    "siteId": "maquis-1",
                    "debiteur": "KOFFI",
                    "date": "2026-09-05",
                    "prix": 28602,
                    "qty": 1,
                    "remise": 0,
                    "paiement": "Crédit client",
                },
            ],
            stock_checks=[],
            credit_recoveries=[],
        )
        self.assertIn("Crédits clients (reste à payer)", body)
        self.assertIn("Total dû : 28 602 FCFA", body)
        self.assertIn("• KOFFI · depuis 05/09/2026 · 28 602 FCFA", body)
        self.assertNotIn("Créanciers (dettes fournisseurs", body)
        self.assertNotIn("Dettes à régler", body)


if __name__ == "__main__":
    unittest.main()
