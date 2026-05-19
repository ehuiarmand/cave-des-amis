"""
Migration data.json → PostgreSQL
Usage :
    pip install psycopg2-binary
    python migrate_to_postgres.py --dsn "postgresql://user:pass@localhost/maquis_db"
    # ou avec variable d'environnement :
    PG_DSN="postgresql://user:pass@localhost/maquis_db" python migrate_to_postgres.py
"""
from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path

try:
    import psycopg2
    import psycopg2.extras
except ImportError:
    print("ERREUR : psycopg2 non installé. Exécutez : pip install psycopg2-binary")
    sys.exit(1)

BASE_DIR = Path(__file__).resolve().parent
DATA_FILE = BASE_DIR / "data.json"
SCHEMA_FILE = BASE_DIR / "schema.sql"

# Mapping clé JSON → (table, type_id)
# type_id : "int" = id entier ; "text" = id texte ; "date_site" = clé date+siteId
PG_TABLES: dict[str, tuple[str, str]] = {
    "ventes":           ("ventes",           "int"),
    "stock":            ("stock",            "int"),
    "commandes":        ("commandes",        "int"),
    "stockChecks":      ("stock_checks",     "date_site"),
    "stockEntrees":     ("stock_entrees",    "int"),
    "stockLosses":      ("stock_losses",     "int"),
    "dayBooks":         ("day_books",        "date_site"),
    "purchaseOrders":   ("purchase_orders",  "int"),
    "supplierPrices":   ("supplier_prices",  "int"),
    "casiers":          ("casiers",          "int"),
    "casierMouvements": ("casier_mouvements","int"),
    "creditRecoveries": ("credit_recoveries","int"),
    "consignes":        ("consignes",        "int"),
    "charges":          ("charges",          "int"),
    "staffAuditLog":    ("staff_audit_log",  "text"),
    "workShifts":       ("work_shifts",      "text"),
}

SKIP_SETTINGS = set(PG_TABLES.keys()) | {"auth", "sites", "categories", "_meta"}


def apply_schema(conn: "psycopg2.connection") -> None:
    if not SCHEMA_FILE.exists():
        print("Fichier schema.sql introuvable — tables créées inline.")
        return
    sql = SCHEMA_FILE.read_text(encoding="utf-8")
    with conn.cursor() as cur:
        cur.execute(sql)
    conn.commit()
    print("  Schéma appliqué.")


def migrate(dsn: str, data_file: Path) -> None:
    print(f"Chargement de {data_file} …")
    state: dict = json.loads(data_file.read_text(encoding="utf-8"))

    print(f"Connexion à PostgreSQL …")
    conn = psycopg2.connect(dsn)

    print("Application du schéma …")
    apply_schema(conn)

    with conn:
        with conn.cursor() as cur:
            # ── Paramètres scalaires ──────────────────────────────────────────
            print("  Migration app_settings …")
            for k, v in state.items():
                if k not in SKIP_SETTINGS:
                    cur.execute(
                        "INSERT INTO app_settings(key, value) VALUES(%s, %s) "
                        "ON CONFLICT(key) DO UPDATE SET value = EXCLUDED.value",
                        (k, json.dumps(v, ensure_ascii=False)),
                    )

            # ── Sites ─────────────────────────────────────────────────────────
            sites = state.get("sites", [])
            print(f"  Migration sites ({len(sites)}) …")
            for site in sites:
                sid = site.get("id", "")
                if not sid:
                    continue
                cur.execute(
                    "INSERT INTO sites(id, data) VALUES(%s, %s) "
                    "ON CONFLICT(id) DO UPDATE SET data = EXCLUDED.data",
                    (sid, json.dumps(site, ensure_ascii=False)),
                )

            # ── Utilisateurs ──────────────────────────────────────────────────
            users = state.get("auth", {}).get("users", [])
            print(f"  Migration users ({len(users)}) …")
            for user in users:
                username = str(user.get("username", "")).strip()
                if not username:
                    continue
                cur.execute(
                    "INSERT INTO users(username, data) VALUES(%s, %s) "
                    "ON CONFLICT(username) DO UPDATE SET data = EXCLUDED.data",
                    (username, json.dumps(user, ensure_ascii=False)),
                )

            # ── Listes ────────────────────────────────────────────────────────
            for key, (table, id_type) in PG_TABLES.items():
                items = state.get(key, [])
                print(f"  Migration {table} ({len(items)} lignes) …")
                if not items:
                    continue

                if id_type == "int":
                    rows = [
                        (item.get("id"), item.get("siteId"), json.dumps(item, ensure_ascii=False))
                        for item in items
                    ]
                    psycopg2.extras.execute_values(
                        cur,
                        f"INSERT INTO {table}(item_id, site_id, data) VALUES %s",
                        rows,
                    )
                elif id_type == "text":
                    rows = [
                        (str(item.get("id", "")), item.get("siteId"), json.dumps(item, ensure_ascii=False))
                        for item in items
                    ]
                    psycopg2.extras.execute_values(
                        cur,
                        f"INSERT INTO {table}(item_id, site_id, data) VALUES %s",
                        rows,
                    )
                elif id_type == "date_site":
                    rows = [
                        (
                            item.get("siteId"),
                            str(item.get("date", ""))[:10],
                            json.dumps(item, ensure_ascii=False),
                        )
                        for item in items
                    ]
                    psycopg2.extras.execute_values(
                        cur,
                        f"INSERT INTO {table}(site_id, date_col, data) VALUES %s",
                        rows,
                    )

    conn.close()
    print("\nMigration terminée avec succès.")
    print("Configurez maintenant MAQUIS_MANAGER_STORAGE=postgres et PG_DSN=… dans votre service.")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Migre data.json vers PostgreSQL")
    parser.add_argument("--dsn", default=os.environ.get("PG_DSN", ""), help="DSN PostgreSQL")
    parser.add_argument("--file", default=str(DATA_FILE), help="Chemin vers data.json")
    args = parser.parse_args()

    if not args.dsn:
        print("ERREUR : fournissez --dsn ou la variable PG_DSN.")
        print('Exemple : --dsn "postgresql://maquis:motdepasse@localhost/maquis_db"')
        sys.exit(1)

    migrate(args.dsn, Path(args.file))
