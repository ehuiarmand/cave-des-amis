#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Supprime les commandes actives deja encaissees (doublons apres echec reseau).

Par defaut : simulation (aucune ecriture).
  python scripts/cleanup_orphan_commandes.py
  python scripts/cleanup_orphan_commandes.py --apply
  python scripts/cleanup_orphan_commandes.py --site cave-des-amis --apply

Arretez server.py avant --apply.
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import sqlite3
import sys
import time
from pathlib import Path
from typing import Any

BASE_DIR = Path(__file__).resolve().parent.parent
DATA_FILE = BASE_DIR / "data.json"
SQLITE_FILE = BASE_DIR / "app.sqlite3"
BACKUP_DIR = BASE_DIR / "backups"


def sale_date_value(item: dict[str, Any]) -> str:
    return str(item.get("date") or "")[:10]


def order_payment_fingerprint(order: dict[str, Any]) -> str:
    client = str(order.get("client") or "").strip().lower()
    table = str(order.get("table") or order.get("client") or "").strip().lower()
    day = sale_date_value(order)
    lines = sorted(
        f"{str(l.get('article') or '').strip()}|{int(l.get('qty') or 0)}|{float(l.get('prix') or 0)}"
        for l in (order.get("lignes") or [])
    )
    return f"{day}|{client}|{table}|{';'.join(lines)}"


def paid_orders_from_sales(ventes: list[dict[str, Any]], site_id: str | None = None) -> list[dict[str, Any]]:
    paid_by_facture: dict[str, dict[str, Any]] = {}
    for v in ventes:
        if site_id and str(v.get("siteId") or "") != site_id:
            continue
        key = str(v.get("factureNumber") or f"V-{v.get('id')}")
        if key not in paid_by_facture:
            paid_by_facture[key] = {
                "factureNumber": v.get("factureNumber"),
                "date": v.get("date"),
                "client": v.get("client") or v.get("table"),
                "table": v.get("table") or v.get("client"),
                "siteId": v.get("siteId"),
                "lignes": [],
            }
        paid_by_facture[key]["lignes"].append(v)
    return list(paid_by_facture.values())


def load_state(data_path: Path | None = None) -> tuple[dict[str, Any], str]:
    """Retourne (state, mode) avec mode 'json' | 'sqlite' | 'file'."""
    if data_path:
        raw = data_path.read_text(encoding="utf-8")
        return json.loads(raw), "file"

    storage = (os.environ.get("MAQUIS_MANAGER_STORAGE") or os.environ.get("TDB_BAR_STORAGE") or "json").strip().lower()
    if storage == "sqlite" and SQLITE_FILE.exists():
        conn = sqlite3.connect(str(SQLITE_FILE))
        try:
            row = conn.execute("SELECT v FROM kv WHERE k = ?", ("state",)).fetchone()
            if not row:
                print("Erreur : SQLite sans cle 'state'.", file=sys.stderr)
                sys.exit(1)
            return json.loads(row[0]), "sqlite"
        finally:
            conn.close()

    path = data_path or DATA_FILE
    if not path.exists():
        print(f"Erreur : fichier introuvable {path}", file=sys.stderr)
        sys.exit(1)
    return json.loads(path.read_text(encoding="utf-8")), "json"


def save_state(state: dict[str, Any], mode: str, data_path: Path | None = None) -> None:
    rev = int((state.get("_meta") or {}).get("rev") or 0) + 1
    state["_meta"] = {
        "rev": rev,
        "updatedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
    }
    body = json.dumps(state, ensure_ascii=False, indent=2)

    if mode == "file":
        assert data_path
        data_path.write_text(body, encoding="utf-8")
        return

    if mode == "sqlite":
        conn = sqlite3.connect(str(SQLITE_FILE))
        try:
            conn.execute(
                "CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT NOT NULL)"
            )
            conn.execute(
                "INSERT INTO kv(k, v) VALUES(?, ?) ON CONFLICT(k) DO UPDATE SET v=excluded.v",
                ("state", body),
            )
            conn.commit()
        finally:
            conn.close()
        return

    tmp = DATA_FILE.with_suffix(".json.tmp")
    tmp.write_text(body, encoding="utf-8")
    tmp.replace(DATA_FILE)


def backup_before_apply(mode: str) -> Path:
    BACKUP_DIR.mkdir(parents=True, exist_ok=True)
    stamp = time.strftime("%Y%m%d-%H%M%S")
    if mode == "sqlite" and SQLITE_FILE.exists():
        dest = BACKUP_DIR / f"app-{stamp}-cleanup.sqlite3"
        shutil.copy2(SQLITE_FILE, dest)
    else:
        dest = BACKUP_DIR / f"data-{stamp}-cleanup.json"
        src = DATA_FILE if DATA_FILE.exists() else None
        if src:
            shutil.copy2(src, dest)
    return dest


def find_orphans(
    state: dict[str, Any],
    site_filter: str | None,
) -> tuple[list[tuple[dict[str, Any], str]], int]:
    """Retourne ([(commande, raison)], nombre de ventes a backfiller)."""
    ventes = state.get("ventes") or []
    commandes = state.get("commandes") or []

    finalized_ids: set[int] = set()
    for v in ventes:
        sid = v.get("sourceOrderId")
        if sid is not None and sid != "":
            finalized_ids.add(int(sid))

    paid_by_fp: dict[str, list[dict[str, Any]]] = {}
    for paid in paid_orders_from_sales(ventes, site_filter):
        if paid.get("lignes"):
            paid_by_fp.setdefault(order_payment_fingerprint(paid), []).append(paid)

    to_remove: list[tuple[dict[str, Any], str]] = []
    backfill_count = 0

    for order in commandes:
        if site_filter and str(order.get("siteId") or "") != site_filter:
            continue
        oid = int(order.get("id") or 0)
        reason = None
        if oid and oid in finalized_ids:
            reason = "ventes liees (sourceOrderId)"
        elif order.get("lignes"):
            fp = order_payment_fingerprint(order)
            if fp in paid_by_fp:
                reason = "meme contenu qu'une facture payee"
        if not reason:
            continue
        to_remove.append((order, reason))
        if oid and reason.startswith("meme contenu"):
            for paid in paid_by_fp.get(order_payment_fingerprint(order), []):
                for v in paid.get("lignes") or []:
                    if not v.get("sourceOrderId"):
                        backfill_count += 1

    return to_remove, backfill_count


def apply_cleanup(
    state: dict[str, Any],
    to_remove: list[tuple[dict[str, Any], str]],
    site_filter: str | None,
) -> None:
    """Backfill sourceOrderId puis supprime les commandes orphelines."""
    ventes = state.get("ventes") or []
    paid_by_fp: dict[str, list[dict[str, Any]]] = {}
    for paid in paid_orders_from_sales(ventes, site_filter):
        if paid.get("lignes"):
            paid_by_fp.setdefault(order_payment_fingerprint(paid), []).append(paid)

    remove_ids: set[int] = set()
    for order, reason in to_remove:
        oid = int(order.get("id") or 0)
        remove_ids.add(oid)
        if oid and reason.startswith("meme contenu"):
            for paid in paid_by_fp.get(order_payment_fingerprint(order), []):
                for v in paid.get("lignes") or []:
                    if not v.get("sourceOrderId"):
                        v["sourceOrderId"] = oid

    state["commandes"] = [
        c for c in (state.get("commandes") or [])
        if int(c.get("id") or 0) not in remove_ids
    ]


def order_label(order: dict[str, Any]) -> str:
    oid = order.get("id")
    client = order.get("client") or order.get("table") or "?"
    status = order.get("status") or "?"
    n = len(order.get("lignes") or [])
    return f"#{oid} · {client} · {status} · {n} ligne(s) · {sale_date_value(order)}"


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--apply", action="store_true", help="Ecrire les suppressions (sinon simulation)")
    parser.add_argument("--site", metavar="SITE_ID", help="Limiter a un maquis (ex. cave-des-amis)")
    parser.add_argument("--file", type=Path, metavar="PATH", help="Analyser un export JSON sans toucher la prod")
    args = parser.parse_args()

    state, mode = load_state(args.file)
    if args.file:
        mode = "file"

    to_remove, backfill_count = find_orphans(state, args.site)

    print(f"Stockage : {mode}" + (f" · fichier {args.file}" if args.file else ""))
    if args.site:
        print(f"Maquis   : {args.site}")
    print(f"Commandes actives : {len(state.get('commandes') or [])}")
    print(f"Orphelines detectees : {len(to_remove)}")
    print()

    if not to_remove:
        print("Rien a nettoyer.")
        return

    for order, reason in sorted(to_remove, key=lambda x: int(x[0].get("id") or 0)):
        print(f"  - {order_label(order)}  ({reason})")

    if backfill_count:
        print(f"\nBackfill sourceOrderId : {backfill_count} ligne(s) de vente (anciennes donnees).")

    if not args.apply:
        print("\n[Simulation] Relancez avec --apply pour supprimer (arretez server.py avant).")
        return

    if mode != "file":
        bp = backup_before_apply(mode)
        print(f"\nSauvegarde : {bp.name}")

    apply_cleanup(state, to_remove, args.site)
    save_state(state, mode, args.file)
    print(f"OK : {len(to_remove)} commande(s) supprimee(s).")
    if mode != "file":
        print("Redemarrez python server.py puis Ctrl+F5 dans le navigateur.")


if __name__ == "__main__":
    main()
