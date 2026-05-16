#!/usr/bin/env python3
"""Diagnostic planning : compte les créneaux en base et teste un PUT."""
from __future__ import annotations

import json
import sys
from collections import Counter
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

import server  # noqa: E402


def main() -> None:
    store = server.store
    ws = store._state.get("workShifts") or []
    print("=== Planning debug ===")
    print("Storage:", server.STORAGE_MODE)
    print("workShifts in memory:", len(ws))
    if ws:
        print("  users:", dict(Counter(str(r.get("username", "")) for r in ws)))
        print("  sites:", dict(Counter(str(r.get("siteId", "")) for r in ws)))
        dates = sorted({str(r.get("date", ""))[:10] for r in ws})
        print("  days:", len(dates), dates[0] if dates else "-", "->", dates[-1] if dates else "-")
    else:
        print("  (vide — aucun créneau persisté)")

    data_path = ROOT / "data.json"
    if data_path.is_file():
        raw = json.loads(data_path.read_text(encoding="utf-8"))
        print("data.json workShifts:", len(raw.get("workShifts") or []))

    users = store._state.get("auth", {}).get("users", [])
    print("\nStaff (serveuse/manager):")
    for u in users:
        if str(u.get("role", "")).lower() in ("serveuse", "manager"):
            print(f"  - {u.get('username')} ({u.get('role')}) sites={u.get('allowedSiteIds')}")


def test_put_validation() -> None:
    """Simule la validation serveur sur un créneau fictif (sans écrire)."""
    store = server.store
    users = store._state.get("auth", {}).get("users", [])
    sites = [str(s.get("id", "")) for s in store._state.get("sites", [])]
    session = {
        "username": "lauraine",
        "role": "manager",
        "allowedSiteIds": ["maquis-3", "NO-STRESS"],
    }
    allowed = set(session["allowedSiteIds"])
    row = {
        "id": 99999,
        "siteId": "maquis-3",
        "username": "marthe",
        "date": "2026-05-25",
        "startTime": "18:00",
        "endTime": "02:00",
    }
    try:
        server.validate_work_shift_row(row, session, users, sites, allowed)
        print("\nValidation OK pour marthe @ maquis-3")
    except ValueError as e:
        print("\nValidation ECHEC:", e)


if __name__ == "__main__":
    main()
    test_put_validation()
