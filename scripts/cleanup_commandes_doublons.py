#!/usr/bin/env python3
"""
Nettoyage manuel des commandes en doublon ou déjà encaissées.

Usage (depuis la racine du dépôt) :
  python scripts/cleanup_commandes_doublons.py --list
  python scripts/cleanup_commandes_doublons.py --list --site maquis-1
  python scripts/cleanup_commandes_doublons.py --ids 357 358 --dry-run
  python scripts/cleanup_commandes_doublons.py --ids 357 --apply
  python scripts/cleanup_commandes_doublons.py --auto-finalized --apply
  python scripts/cleanup_commandes_doublons.py --auto-fingerprint --site maquis-1 --apply

Arrêtez le serveur (python server.py) avant --apply sur data.json, ou relancez-le après.
"""
from __future__ import annotations

import argparse
import json
import sys
from collections import defaultdict
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

import server  # noqa: E402


def order_day(order: dict[str, Any]) -> str:
    return str(order.get("date") or "")[:10]


def order_fingerprint(order: dict[str, Any]) -> str:
    client = str(order.get("client") or "").strip().lower()
    table = str(order.get("table") or order.get("client") or "").strip().lower()
    day = order_day(order)
    lines = sorted(
        f"{str(l.get('article', '')).strip()}|{int(l.get('qty') or 0)}|{float(l.get('prix') or 0)}"
        for l in (order.get("lignes") or [])
        if isinstance(l, dict)
    )
    return f"{day}|{client}|{table}|{';'.join(lines)}"


def order_total(order: dict[str, Any]) -> float:
    total = 0.0
    for line in order.get("lignes") or []:
        if not isinstance(line, dict):
            continue
        qty = float(line.get("qty") or 0)
        prix = float(line.get("prix") or 0)
        remise = float(line.get("remise") or 0)
        total += qty * prix - remise
    return total


def ventes_by_source_order(state: dict[str, Any]) -> dict[int, list[dict[str, Any]]]:
    out: dict[int, list[dict[str, Any]]] = defaultdict(list)
    for v in state.get("ventes") or []:
        if not isinstance(v, dict):
            continue
        sid = v.get("sourceOrderId")
        if sid is None or sid == "":
            continue
        try:
            out[int(sid)].append(v)
        except (TypeError, ValueError):
            continue
    return out


def format_order(order: dict[str, Any], ventes_map: dict[int, list]) -> str:
    oid = order.get("id")
    site = order.get("siteId", "?")
    client = order.get("client") or order.get("table") or "?"
    mode = order.get("saisieMode") or order.get("source") or "Commande"
    status = order.get("status", "?")
    created = str(order.get("createdAt") or order.get("date") or "")[:19]
    n_ventes = len(ventes_map.get(int(oid or 0), []))
    arts = ", ".join(
        f"{l.get('article')} x{l.get('qty')}"
        for l in (order.get("lignes") or [])[:4]
        if isinstance(l, dict)
    )
    extra = f" · {len(order.get('lignes') or [])} ligne(s)" if len(order.get("lignes") or []) > 4 else ""
    enc = f" · {n_ventes} vente(s) liée(s)" if n_ventes else ""
    return (
        f"  #{oid} | site={site} | {client} | {mode} | {status} | "
        f"{order_total(order):.0f} FCFA | {created}{enc}\n"
        f"    Articles: {arts or '(vide)'}{extra}"
    )


def filter_site(commandes: list[dict[str, Any]], site_id: str | None) -> list[dict[str, Any]]:
    if not site_id:
        return [c for c in commandes if isinstance(c, dict)]
    sid = site_id.strip()
    return [c for c in commandes if isinstance(c, dict) and str(c.get("siteId", "")) == sid]


def find_duplicate_ids(commandes: list[dict[str, Any]]) -> dict[int, list[dict[str, Any]]]:
    by_id: dict[int, list[dict[str, Any]]] = defaultdict(list)
    for o in commandes:
        try:
            by_id[int(o.get("id"))].append(o)
        except (TypeError, ValueError):
            continue
    return {k: v for k, v in by_id.items() if len(v) > 1}


def find_fingerprint_groups(commandes: list[dict[str, Any]]) -> dict[str, list[dict[str, Any]]]:
    groups: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for o in commandes:
        if not (o.get("lignes") or []):
            continue
        groups[order_fingerprint(o)].append(o)
    return {k: v for k, v in groups.items() if len(v) > 1}


def find_finalized_commandes(
    commandes: list[dict[str, Any]], ventes_map: dict[int, list],
) -> list[dict[str, Any]]:
    out = []
    for o in commandes:
        oid = int(o.get("id") or 0)
        if oid and oid in ventes_map:
            out.append(o)
    return out


def pick_keep_order(orders: list[dict[str, Any]], ventes_map: dict[int, list]) -> dict[str, Any]:
    """Garde la commande avec ventes liées, sinon la plus récente (createdAt)."""
    with_sales = [o for o in orders if ventes_map.get(int(o.get("id") or 0))]
    if len(with_sales) == 1:
        return with_sales[0]
    if len(with_sales) > 1:
        return max(with_sales, key=lambda o: str(o.get("createdAt") or ""))
    return max(orders, key=lambda o: str(o.get("createdAt") or ""))


def run_list(state: dict[str, Any], site_id: str | None) -> set[int]:
    commandes = filter_site(state.get("commandes") or [], site_id)
    ventes_map = ventes_by_source_order(state)
    print(f"=== Commandes ({len(commandes)}) site={site_id or 'tous'} ===\n")

    dup_ids = find_duplicate_ids(commandes)
    if dup_ids:
        print("⚠ Même numéro d'id plusieurs fois dans le fichier :")
        for oid, rows in sorted(dup_ids.items()):
            print(f"\n  ID #{oid} ({len(rows)} entrées) :")
            for o in rows:
                print(format_order(o, ventes_map))
    else:
        print("Aucun id dupliqué dans le tableau commandes.\n")

    finalized = find_finalized_commandes(commandes, ventes_map)
    if finalized:
        print(f"\n--- Déjà encaissées ({len(finalized)}) — candidates à suppression ---")
        for o in sorted(finalized, key=lambda x: int(x.get("id") or 0)):
            print(format_order(o, ventes_map))

    fp_groups = find_fingerprint_groups(commandes)
    if fp_groups:
        print(f"\n--- Doublons contenu ({len(fp_groups)} groupe(s)) — même jour/client/articles ---")
        for fp, rows in fp_groups.items():
            print(f"\n  Empreinte: {fp[:80]}…" if len(fp) > 80 else f"\n  Empreinte: {fp}")
            for o in sorted(rows, key=lambda x: int(x.get("id") or 0)):
                print(format_order(o, ventes_map))

    suggest_remove: set[int] = set()
    for rows in dup_ids.values():
        keep = pick_keep_order(rows, ventes_map)
        if len(rows) > 1:
            print(
                f"\n  → Pour id #{keep.get('id')}, garder l'entrée « {keep.get('client')} » "
                f"({keep.get('createdAt', '')[:19]}). Supprimer les autres copies du même id "
                f"via --auto-fingerprint --apply ou supprimez tout l'id avec --ids {keep.get('id')} --apply",
            )
    for rows in fp_groups.values():
        keep = pick_keep_order(rows, ventes_map)
        for o in rows:
            if o is not keep:
                suggest_remove.add(int(o.get("id")))
    for o in finalized:
        suggest_remove.add(int(o.get("id")))

    if suggest_remove:
        ids = sorted(suggest_remove)
        print(f"\n>>> Suggestion suppression ids: {' '.join(str(i) for i in ids)}")
        print(f"    python scripts/cleanup_commandes_doublons.py --ids {' '.join(str(i) for i in ids)} --apply")
    return suggest_remove


def dedupe_same_id_rows(
    commandes: list[Any], ventes_map: dict[int, list], site_id: str | None,
) -> tuple[list[Any], int]:
    """Si le même id apparaît plusieurs fois dans le JSON, ne garde qu'une entrée."""
    site_cmds: list[dict[str, Any]] = []
    other: list[Any] = []
    for c in commandes:
        if not isinstance(c, dict):
            continue
        if site_id and str(c.get("siteId", "")) != site_id.strip():
            other.append(c)
        else:
            site_cmds.append(c)
    by_id: dict[int, list[dict[str, Any]]] = defaultdict(list)
    for o in site_cmds:
        try:
            by_id[int(o.get("id"))].append(o)
        except (TypeError, ValueError):
            continue
    kept_site: list[Any] = []
    removed = 0
    for _oid, rows in by_id.items():
        if len(rows) == 1:
            kept_site.append(rows[0])
            continue
        keep = pick_keep_order(rows, ventes_map)
        kept_site.append(keep)
        removed += len(rows) - 1
    return other + kept_site, removed


def remove_orders(state: dict[str, Any], ids_to_remove: set[int], dry_run: bool) -> int:
    before = len(state.get("commandes") or [])
    kept = [
        o for o in (state.get("commandes") or [])
        if isinstance(o, dict) and int(o.get("id") or -1) not in ids_to_remove
    ]
    removed = before - len(kept)
    if dry_run:
        print(f"[dry-run] Retirerait {removed} commande(s) (ids: {sorted(ids_to_remove)})")
        return removed
    state["commandes"] = kept
    server.store._write(state)
    print(f"✓ {removed} commande(s) supprimée(s). Total commandes: {len(kept)}")
    return removed


def main() -> None:
    parser = argparse.ArgumentParser(description="Supprimer commandes en doublon ou déjà encaissées.")
    parser.add_argument("--list", action="store_true", help="Lister doublons et commandes encaissées")
    parser.add_argument("--site", type=str, default="", help="Filtrer par siteId (ex. maquis-1)")
    parser.add_argument("--ids", type=int, nargs="*", help="Ids de commandes à supprimer")
    parser.add_argument("--auto-finalized", action="store_true", help="Supprimer toutes les commandes déjà liées à des ventes")
    parser.add_argument(
        "--auto-fingerprint",
        action="store_true",
        help="Par groupe même contenu, ne garder qu'une commande (la plus récente ou celle avec ventes)",
    )
    parser.add_argument(
        "--dedupe-same-id",
        action="store_true",
        help="Même numéro #357 en double dans le fichier : ne garder qu'une ligne",
    )
    parser.add_argument("--apply", action="store_true", help="Écrire dans data.json / SQLite (sinon dry-run)")
    parser.add_argument("--dry-run", action="store_true", help="Simuler sans écrire (défaut sans --apply)")
    args = parser.parse_args()

    site_id = args.site.strip() or None
    dry_run = not args.apply or args.dry_run

    state = server.store._state
    commandes = filter_site(state.get("commandes") or [], site_id)
    ventes_map = ventes_by_source_order(state)

    if args.list or not (args.ids or args.auto_finalized or args.auto_fingerprint or args.dedupe_same_id):
        run_list(state, site_id)
        if not (args.ids or args.auto_finalized or args.auto_fingerprint or args.dedupe_same_id):
            print("\nOptions: --ids N … | --auto-finalized | --auto-fingerprint | --dedupe-same-id | --apply")
            return

    ids_to_remove: set[int] = set(args.ids or [])

    if args.auto_finalized:
        for o in find_finalized_commandes(commandes, ventes_map):
            ids_to_remove.add(int(o.get("id")))

    if args.auto_fingerprint:
        for rows in find_fingerprint_groups(commandes).values():
            keep = pick_keep_order(rows, ventes_map)
            for o in rows:
                if o is not keep:
                    ids_to_remove.add(int(o.get("id")))

    dedupe_removed = 0
    if args.dedupe_same_id:
        new_list, dedupe_removed = dedupe_same_id_rows(
            state.get("commandes") or [], ventes_map, site_id,
        )
        if dedupe_removed and not dry_run:
            state["commandes"] = new_list
        elif dedupe_removed:
            print(f"[dry-run] Dédupliquerait {dedupe_removed} entrée(s) avec le même id")

    if not ids_to_remove and not dedupe_removed:
        print("Rien à supprimer.")
        return

    if not ids_to_remove and dedupe_removed and not dry_run:
        server.store._write(state)
        print(f"✓ Déduplication même id : {dedupe_removed} entrée(s) retirée(s).")
        return

    print(f"\nSuppression prévue ({len(ids_to_remove)} id(s)): {sorted(ids_to_remove)}")
    for oid in sorted(ids_to_remove):
        matches = [o for o in commandes if int(o.get("id") or -1) == oid]
        for o in matches:
            print(format_order(o, ventes_map))

    if not args.apply:
        print("\nAjoutez --apply pour enregistrer (arrêtez le serveur si besoin).")
        dry_run = True

    if not dry_run:
        confirm = input("\nConfirmer la suppression ? (oui/non) : ").strip().lower()
        if confirm not in ("oui", "o", "yes", "y"):
            print("Annulé.")
            return

    remove_orders(state, ids_to_remove, dry_run=dry_run)
    if args.dedupe_same_id and not dry_run and ids_to_remove:
        new_list, extra = dedupe_same_id_rows(state.get("commandes") or [], ventes_map, site_id)
        if extra:
            state["commandes"] = new_list
            server.store._write(state)
            print(f"✓ Déduplication même id supplémentaire : {extra} entrée(s)")


if __name__ == "__main__":
    main()
