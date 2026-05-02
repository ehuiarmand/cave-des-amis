from __future__ import annotations

import base64
import gzip
import hashlib
import hmac
import json
import os
import sqlite3
import secrets
import socket
import struct
import threading
import time
from http import HTTPStatus
from http.cookies import SimpleCookie
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs, urlparse


BASE_DIR = Path(__file__).resolve().parent
DATA_FILE = BASE_DIR / "data.json"
BACKUP_DIR = BASE_DIR / "backups"
AUDIT_LOG_FILE = BASE_DIR / "audit.log.jsonl"
SQLITE_FILE = BASE_DIR / "app.sqlite3"
SESSION_TTL_SECONDS = 60 * 60 * 8
SESSION_COOKIE = "tdb_bar_session"
PASSWORD_ALGO = "pbkdf2_sha256"
PASSWORD_ITERATIONS = 260_000

STORAGE_MODE = (os.environ.get("TDB_BAR_STORAGE", "json") or "json").strip().lower()

# ---------------------------------------------------------------------------
# TOTP (RFC 6238) — no third-party deps, Python stdlib only
# ---------------------------------------------------------------------------

def generate_totp_secret() -> str:
    """Return a 20-byte random secret encoded as base32 (no padding)."""
    return base64.b32encode(secrets.token_bytes(20)).decode().rstrip("=")


def _totp_at(secret_b32: str, counter: int) -> str:
    padded = secret_b32.upper()
    pad = (8 - len(padded) % 8) % 8
    key = base64.b32decode(padded + "=" * pad)
    msg = struct.pack(">Q", counter)
    digest = hmac.new(key, msg, hashlib.sha1).digest()
    offset = digest[-1] & 0x0F
    code = struct.unpack(">I", digest[offset:offset + 4])[0] & 0x7FFFFFFF
    return str(code % 1_000_000).zfill(6)


def verify_totp(secret_b32: str, user_code: str) -> bool:
    """Accept ±1 time step (30 s each) to handle clock drift."""
    t = int(time.time()) // 30
    return any(_totp_at(secret_b32, t + delta) == user_code.strip() for delta in (-1, 0, 1))


# ---------------------------------------------------------------------------
# Pre-auth tokens (5-minute TTL, consumed once)
# ---------------------------------------------------------------------------

_pre_auth_tokens: dict[str, dict[str, Any]] = {}
_pre_auth_lock = threading.Lock()


def create_pre_auth_token(username: str) -> str:
    token = secrets.token_urlsafe(32)
    with _pre_auth_lock:
        _pre_auth_tokens[token] = {"username": username, "expiresAt": int(time.time()) + 300}
    return token


def consume_pre_auth_token(token: str) -> str | None:
    with _pre_auth_lock:
        data = _pre_auth_tokens.pop(token, None)
    if data and data["expiresAt"] > time.time():
        return data["username"]
    return None


_audit_lock = threading.Lock()


def audit_log(event: str, details: dict[str, Any]) -> None:
    try:
        row = {
            "ts": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            "event": event,
            "details": details,
        }
        with _audit_lock:
            # Opening with "a" creates the file if missing.
            with AUDIT_LOG_FILE.open("a", encoding="utf-8") as f:
                f.write(json.dumps(row, ensure_ascii=False) + "\n")
    except OSError:
        return


# Naive in-memory rate limiter for /api/login (per IP + username)
_login_attempts: dict[str, dict[str, Any]] = {}
_login_attempts_lock = threading.Lock()


def _rl_key(ip: str, username: str) -> str:
    return f"{ip}::{username}".lower()


def login_rate_limit_check(ip: str, username: str) -> tuple[bool, int]:
    """Return (allowed, retry_after_seconds)."""
    now = time.time()
    key = _rl_key(ip, username)
    with _login_attempts_lock:
        entry = _login_attempts.get(key) or {"fails": 0, "blocked_until": 0}
        if entry["blocked_until"] > now:
            return False, int(entry["blocked_until"] - now) + 1
        return True, 0


def login_rate_limit_fail(ip: str, username: str) -> None:
    now = time.time()
    key = _rl_key(ip, username)
    with _login_attempts_lock:
        entry = _login_attempts.get(key) or {"fails": 0, "blocked_until": 0}
        entry["fails"] = int(entry.get("fails") or 0) + 1
        # Exponential backoff with cap (roughly: 0,0,2,4,8,16,...)
        if entry["fails"] >= 3:
            backoff = min(300, 2 ** min(8, entry["fails"] - 2))
            entry["blocked_until"] = now + backoff
        _login_attempts[key] = entry


def login_rate_limit_success(ip: str, username: str) -> None:
    key = _rl_key(ip, username)
    with _login_attempts_lock:
        _login_attempts.pop(key, None)


DEFAULT_STATE: dict[str, Any] = {
    "auth": {
        "username": "admin",
        "passwordHash": "",
    },
    "params": {
        "nom": "Mon Bar Chez Moi",
        "ville": "Douala",
        "pays": "Cameroun",
        "gerant": "",
        "objectifCA": 500000,
        "seuilStock": 5,
    },
    "ventes": [
        {"id": 1, "date": "2026-04-21", "article": "Castel Beer 65cl", "cat": "Bières", "prix": 700, "qty": 10, "remise": 0, "paiement": "Espèces"},
        {"id": 2, "date": "2026-04-22", "article": "Coca-Cola 33cl", "cat": "Sodas & Jus", "prix": 350, "qty": 8, "remise": 0, "paiement": "Orange Money"},
        {"id": 3, "date": "2026-04-22", "article": "Eau Minérale 1.5L", "cat": "Eaux", "prix": 200, "qty": 5, "remise": 200, "paiement": "Espèces"},
        {"id": 4, "date": "2026-04-23", "article": "Heineken 33cl", "cat": "Bières", "prix": 600, "qty": 15, "remise": 0, "paiement": "MTN MoMo"},
        {"id": 5, "date": "2026-04-23", "article": "Jus d'Ananas 50cl", "cat": "Sodas & Jus", "prix": 300, "qty": 6, "remise": 0, "paiement": "Wave"},
        {"id": 6, "date": "2026-04-24", "article": "Whisky J&B 5cl", "cat": "Vins & Spiritueux", "prix": 1500, "qty": 3, "remise": 0, "paiement": "Espèces"},
        {"id": 7, "date": "2026-04-24", "article": "Cacahuètes sachet", "cat": "Snacks", "prix": 150, "qty": 12, "remise": 300, "paiement": "Espèces"},
        {"id": 8, "date": "2026-04-25", "article": "Fanta Orange 33cl", "cat": "Sodas & Jus", "prix": 300, "qty": 9, "remise": 0, "paiement": "Wave"},
        {"id": 9, "date": "2026-04-26", "article": "Vin Rouge 15cl", "cat": "Vins & Spiritueux", "prix": 800, "qty": 2, "remise": 0, "paiement": "Espèces"},
        {"id": 10, "date": "2026-04-26", "article": "33 Export", "cat": "Bières", "prix": 600, "qty": 8, "remise": 0, "paiement": "MTN MoMo"},
    ],
    "stock": [
        {"id": 1, "article": "Castel Beer 65cl", "cat": "Bières", "init": 100, "entrees": 50, "seuilMin": 5, "prixAchat": 700, "prixVente": 800},
        {"id": 2, "article": "Heineken 33cl", "cat": "Bières", "init": 60, "entrees": 20, "seuilMin": 5, "prixAchat": 600, "prixVente": 700},
        {"id": 3, "article": "Coca-Cola 33cl", "cat": "Sodas & Jus", "init": 80, "entrees": 30, "seuilMin": 5, "prixAchat": 200, "prixVente": 350},
        {"id": 4, "article": "Fanta Orange 33cl", "cat": "Sodas & Jus", "init": 60, "entrees": 20, "seuilMin": 5, "prixAchat": 180, "prixVente": 300},
        {"id": 5, "article": "Eau Minérale 1.5L", "cat": "Eaux", "init": 120, "entrees": 48, "seuilMin": 5, "prixAchat": 150, "prixVente": 200},
        {"id": 6, "article": "Whisky J&B 70cl", "cat": "Vins & Spiritueux", "init": 12, "entrees": 0, "seuilMin": 3, "prixAchat": 8000, "prixVente": 9500},
        {"id": 7, "article": "Vin Rouge 75cl", "cat": "Vins & Spiritueux", "init": 24, "entrees": 6, "seuilMin": 3, "prixAchat": 3500, "prixVente": 4500},
        {"id": 8, "article": "Cacahuètes sachet", "cat": "Snacks", "init": 200, "entrees": 100, "seuilMin": 10, "prixAchat": 80, "prixVente": 150},
    ],
    "commandes": [],
    "stockChecks": [],
    "dayBooks": [],
    "purchaseOrders": [],
    "creditRecoveries": [],
    "categories": ["Bières", "Sodas & Jus", "Eaux", "Vins & Spiritueux", "Cocktails", "Snacks", "Autres"],
    "charges": [
        {"id": 1, "date": "2026-04-21", "lib": "Loyer mensuel", "cat": "Loyer", "montant": 150000, "paiement": "Espèces"},
        {"id": 2, "date": "2026-04-21", "lib": "Salaire barman", "cat": "Salaires", "montant": 80000, "paiement": "Orange Money"},
        {"id": 3, "date": "2026-04-22", "lib": "Facture ENEO/SENELEC", "cat": "Électricité", "montant": 35000, "paiement": "Orange Money"},
        {"id": 4, "date": "2026-04-23", "lib": "Achat boissons", "cat": "Achats boissons", "montant": 52500, "paiement": "Espèces"},
        {"id": 5, "date": "2026-04-25", "lib": "Entretien & nettoyage", "cat": "Entretien", "montant": 8000, "paiement": "Wave"},
    ],
    "nextId": {
        "vente": 100,
        "stock": 100,
        "commande": 100,
        "ligneCommande": 1000,
        "charge": 100,
        "creditRecovery": 100,
        "auditEntry": 0,
    },
}


def hash_password(password: str) -> str:
    salt = secrets.token_hex(16)
    digest = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt.encode("ascii"), PASSWORD_ITERATIONS)
    return f"{PASSWORD_ALGO}${PASSWORD_ITERATIONS}${salt}${digest.hex()}"


def verify_password(password: str, stored_hash: str) -> bool:
    parts = str(stored_hash or "").split("$")
    if len(parts) == 4 and parts[0] == PASSWORD_ALGO:
        _, raw_iterations, salt, digest = parts
        try:
            iterations = int(raw_iterations)
        except ValueError:
            return False
        candidate = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt.encode("ascii"), iterations).hex()
        return hmac.compare_digest(candidate, digest)
    legacy_sha256 = hashlib.sha256(password.encode("utf-8")).hexdigest()
    return hmac.compare_digest(legacy_sha256, str(stored_hash or ""))


def password_needs_upgrade(stored_hash: str) -> bool:
    return not str(stored_hash or "").startswith(f"{PASSWORD_ALGO}${PASSWORD_ITERATIONS}$")


def make_site(
    site_id: str,
    nom: str,
    ville: str,
    pays: str,
    gerant: str,
    objectif_ca: int,
    seuil_stock: int,
    prefixe_facture: str = "FAC",
) -> dict[str, Any]:
    return {
        "id": site_id,
        "nom": nom,
        "ville": ville,
        "pays": pays,
        "gerant": gerant,
        "objectifCA": objectif_ca,
        "seuilStock": seuil_stock,
        "prefixeFacture": prefixe_facture,
    }


def build_default_state() -> dict[str, Any]:
    legacy = json.loads(json.dumps(DEFAULT_STATE))
    return {
        "auth": {
            "users": [
                {"username": "manager", "passwordHash": hash_password("manager123"), "role": "manager", "allowedSiteIds": ["maquis-1", "maquis-2"]},
                {"username": "serveuse", "passwordHash": hash_password("serveuse123"), "role": "serveuse", "allowedSiteIds": ["maquis-1"]},
            ],
        },
        "sites": [
            make_site("maquis-1", "Mon Bar Chez Moi", "Douala", "Cameroun", "", 500000, 5, "MBCM"),
            make_site("maquis-2", "Maquis Plateau", "Abidjan", "Côte d'Ivoire", "", 650000, 6, "MPLT"),
        ],
        "activeSiteId": "maquis-1",
        "ventes": [
            {**item, "siteId": item.get("siteId", "maquis-1")} for item in legacy["ventes"]
        ],
        "stock": [
            {**item, "siteId": item.get("siteId", "maquis-1")} for item in legacy["stock"]
        ],
        "commandes": [],
        "stockChecks": [],
        "dayBooks": [],
        "purchaseOrders": [],
        "creditRecoveries": [],
        "categories": legacy.get("categories", DEFAULT_STATE["categories"]),
        "charges": [
            {**item, "siteId": item.get("siteId", "maquis-1")} for item in legacy["charges"]
        ],
        "staffAuditLog": [],
        "nextId": {
            **legacy["nextId"],
            "site": 3,
            "invoice": 1,
            "auditEntry": legacy.get("nextId", {}).get("auditEntry", 0),
        },
    }


def migrate_state(payload: dict[str, Any]) -> dict[str, Any]:
    default = build_default_state()

    # Step 1 — migrate old single-site format to multi-site
    if "sites" not in payload or "activeSiteId" not in payload:
        params = payload.get("params", DEFAULT_STATE.get("params", {}))
        site_id = "maquis-1"
        old_auth = payload.get("auth", {})
        users = [
            {"username": old_auth.get("username", "manager"), "passwordHash": old_auth.get("passwordHash", hash_password("manager123")), "role": "manager", "allowedSiteIds": [site_id]},
            {"username": "serveuse", "passwordHash": hash_password("serveuse123"), "role": "serveuse", "allowedSiteIds": [site_id]},
        ]
        return {
            "auth": {"users": users},
            "sites": [make_site(site_id, params.get("nom", "Mon Bar Chez Moi"), params.get("ville", "Douala"), params.get("pays", "Cameroun"), params.get("gerant", ""), params.get("objectifCA", 500000), params.get("seuilStock", 5), "MBCM")],
            "activeSiteId": site_id,
            "ventes": [{**item, "siteId": item.get("siteId", site_id)} for item in payload.get("ventes", default["ventes"])],
            "stock": [{**item, "siteId": item.get("siteId", site_id)} for item in payload.get("stock", default["stock"])],
            "commandes": [{**item, "siteId": item.get("siteId", site_id)} for item in payload.get("commandes", [])],
            "stockChecks": [{**item, "siteId": item.get("siteId", site_id)} for item in payload.get("stockChecks", [])],
            "creditRecoveries": [{**item, "siteId": item.get("siteId", site_id)} for item in payload.get("creditRecoveries", [])],
            "categories": payload.get("categories", default["categories"]),
            "charges": [{**item, "siteId": item.get("siteId", site_id)} for item in payload.get("charges", default["charges"])],
            "staffAuditLog": payload.get("staffAuditLog", []),
            "nextId": {**default["nextId"], **payload.get("nextId", {})},
        }

    # Step 2 — migrate old managerUsername/serveuseUsername auth format to users list
    auth = payload.get("auth", {})
    if "users" not in auth:
        all_site_ids = [s["id"] for s in payload.get("sites", [])]
        serveuse_site_ids = auth.get("serveuseSiteIds", all_site_ids[:1])
        users = [
            {"username": auth.get("managerUsername", "manager"), "passwordHash": auth.get("managerPasswordHash", hash_password("manager123")), "role": "manager", "allowedSiteIds": all_site_ids},
            {"username": auth.get("serveuseUsername", "serveuse"), "passwordHash": auth.get("serveusePasswordHash", hash_password("serveuse123")), "role": "serveuse", "allowedSiteIds": serveuse_site_ids},
        ]
        payload["auth"] = {"users": users}

    return payload


def normalize_auth_users(payload: dict[str, Any]) -> None:
    sites = payload.get("sites", [])
    site_ids = [site.get("id") for site in sites if site.get("id")]
    users = payload.get("auth", {}).get("users", [])
    for user in users:
        if str(user.get("username", "")).strip() == "admin":
            user["role"] = "admin"
            if site_ids:
                user["allowedSiteIds"] = site_ids


def sale_formats(item: dict[str, Any]) -> list[dict[str, int]]:
    formats: list[dict[str, int]] = []
    for raw in item.get("formatsVente") or []:
        qty = int(raw.get("quantite") or raw.get("qty") or raw.get("packSize") or 1)
        prix_int = int(raw.get("prixInterieur") or raw.get("prixInt") or raw.get("prixVenteInt") or 0)
        prix_ext = int(raw.get("prixExterieur") or raw.get("prixExt") or raw.get("prixVenteExt") or prix_int)
        if qty > 0 and prix_int > 0:
            formats.append({"quantite": qty, "prixInterieur": prix_int, "prixExterieur": prix_ext or prix_int})
    if not formats:
        qty = int(item.get("packSize") or 1)
        prix_int = int(item.get("prixVenteInt") or item.get("prixKitInt") or item.get("prixBouteille") or item.get("prixVente") or item.get("prixAchat") or 0)
        prix_ext = int(item.get("prixVenteExt") or item.get("prixKitExt") or item.get("prixBouteille") or item.get("prixVente") or prix_int)
        if prix_int > 0:
            formats.append({"quantite": max(1, qty), "prixInterieur": prix_int, "prixExterieur": prix_ext or prix_int})
    return sorted(formats, key=lambda value: value["quantite"])


def price_for_format(format_data: dict[str, int], location: str) -> int:
    if str(location).startswith("Ext"):
        return int(format_data.get("prixExterieur") or 0)
    return int(format_data.get("prixInterieur") or 0)


def stock_legacy_total(item: dict[str, Any]) -> int:
    return max(0, int(item.get("init") or 0) + int(item.get("entrees") or 0) - int(item.get("sorties") or 0))


def stock_frigo(item: dict[str, Any]) -> int:
    return max(0, int(item.get("frigo") if item.get("frigo") is not None else stock_legacy_total(item)))


def stock_reserve(item: dict[str, Any]) -> int:
    return max(0, int(item.get("reserve") if item.get("reserve") is not None else stock_legacy_total(item) - stock_frigo(item)))


def stock_total(item: dict[str, Any]) -> int:
    # Stock actuel = frigo + réserve quand ces champs existent (stock physique réel)
    if "frigo" in item or "reserve" in item:
        return max(0, stock_frigo(item) + stock_reserve(item))
    return stock_legacy_total(item)


def stock_available(item: dict[str, Any]) -> int:
    return stock_total(item)


def reserved_bottles_for_site(site_id: str, commandes: list[dict[str, Any]]) -> dict[str, int]:
    reserved: dict[str, int] = {}
    for order in commandes or []:
        if order.get("siteId") != site_id:
            continue
        status = str(order.get("status") or "")
        if status in ("Paye", "PayÃ©", "Payé", "Annule", "AnnulÃ©", "Annulé"):
            continue
        for line in order.get("lignes", []) or []:
            key = str(line.get("article", "")).strip().lower()
            if not key:
                continue
            pack_size = int(line.get("formatQuantite") or line.get("packSize") or 1)
            qty = int(line.get("qty") or 0)
            if qty <= 0:
                continue
            reserved[key] = reserved.get(key, 0) + (qty * max(1, pack_size))
    return reserved


def reserved_bottles_for_site_excluding_order(site_id: str, commandes: list[dict[str, Any]], exclude_order_id: int | None) -> dict[str, int]:
    reserved: dict[str, int] = {}
    for order in commandes or []:
        if exclude_order_id is not None and order.get("id") == exclude_order_id:
            continue
        if order.get("siteId") != site_id:
            continue
        status = str(order.get("status") or "")
        if status in ("Paye", "PayÃ©", "Payé", "Annule", "AnnulÃ©", "Annulé"):
            continue
        for line in order.get("lignes", []) or []:
            key = str(line.get("article", "")).strip().lower()
            if not key:
                continue
            pack_size = int(line.get("formatQuantite") or line.get("packSize") or 1)
            qty = int(line.get("qty") or 0)
            if qty <= 0:
                continue
            reserved[key] = reserved.get(key, 0) + (qty * max(1, pack_size))
    return reserved


def stock_total_by_article(site_id: str, stock_rows: list[dict[str, Any]]) -> dict[str, int]:
    totals: dict[str, int] = {}
    for item in stock_rows:
        if item.get("siteId") != site_id:
            continue
        article_key = str(item.get("article", "")).strip().lower()
        if not article_key:
            continue
        totals[article_key] = totals.get(article_key, 0) + stock_available(item)
    return totals


class SessionManager:
    def __init__(self, ttl_seconds: int) -> None:
        self.ttl_seconds = ttl_seconds
        self._sessions: dict[str, dict[str, Any]] = {}
        self._lock = threading.Lock()

    def create(self, username: str, role: str, allowed_site_ids: list[str]) -> str:
        token = secrets.token_urlsafe(32)
        expires_at = int(time.time()) + self.ttl_seconds
        with self._lock:
            self._sessions[token] = {
                "username": username,
                "role": role,
                "allowedSiteIds": allowed_site_ids,
                "expiresAt": expires_at,
            }
        return token

    def get(self, token: str | None) -> dict[str, Any] | None:
        if not token:
            return None
        with self._lock:
            session = self._sessions.get(token)
            if not session:
                return None
            if session["expiresAt"] < time.time():
                self._sessions.pop(token, None)
                return None
            session["expiresAt"] = int(time.time()) + self.ttl_seconds
            return dict(session)

    def clear(self, token: str | None) -> None:
        if not token:
            return
        with self._lock:
            self._sessions.pop(token, None)


class DataStore:
    def __init__(self, path: Path) -> None:
        self.path = path
        self._lock = threading.RLock()
        # Meta defaults (must exist before any _write() during _load()).
        self._rev = 0
        self._updated_at = ""
        self._sqlite_path = SQLITE_FILE
        self._sqlite_enabled = STORAGE_MODE == "sqlite"
        self._state = self._load()
        self._last_etag = self._compute_etag()
        self._rev = int(self._state.get("_meta", {}).get("rev") or self._rev or 1)
        self._updated_at = str(self._state.get("_meta", {}).get("updatedAt") or self._updated_at or "")

    def _sqlite_connect(self) -> sqlite3.Connection:
        conn = sqlite3.connect(str(self._sqlite_path))
        conn.execute("PRAGMA journal_mode=WAL;")
        conn.execute("PRAGMA synchronous=NORMAL;")
        conn.execute("PRAGMA temp_store=MEMORY;")
        conn.execute(
            "CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT NOT NULL)"
        )
        return conn

    def _sqlite_get(self, key: str) -> str | None:
        conn = self._sqlite_connect()
        try:
            row = conn.execute("SELECT v FROM kv WHERE k = ?", (key,)).fetchone()
            return row[0] if row else None
        finally:
            conn.close()

    def _sqlite_set(self, key: str, value: str) -> None:
        conn = self._sqlite_connect()
        try:
            conn.execute("INSERT INTO kv(k, v) VALUES(?, ?) ON CONFLICT(k) DO UPDATE SET v=excluded.v", (key, value))
            conn.commit()
        finally:
            conn.close()

    def _compute_etag(self) -> str:
        if self._sqlite_enabled:
            # Based on logical revision.
            return f'W/"rev-{int(self._rev or 0)}"'
        try:
            stat = self.path.stat()
            # Weak ETag is enough for cache revalidation, cheap to compute.
            return f'W/"{int(stat.st_mtime)}-{stat.st_size}"'
        except OSError:
            return 'W/"0-0"'

    def _load(self) -> dict[str, Any]:
        if self._sqlite_enabled:
            raw = self._sqlite_get("state")
            if raw:
                try:
                    payload = json.loads(raw)
                except json.JSONDecodeError:
                    payload = build_default_state()
            else:
                payload = build_default_state()
                # Persist initial state (will set _meta)
                self._write(payload)
                return payload

            payload = migrate_state(payload)
            merged = build_default_state()
            merged.update({k: v for k, v in payload.items() if k in merged})
            merged["auth"]["users"] = payload.get("auth", {}).get("users", merged["auth"]["users"])
            merged["nextId"].update(payload.get("nextId", {}))
            merged["sites"] = payload.get("sites", merged["sites"])
            merged["activeSiteId"] = payload.get("activeSiteId", merged["activeSiteId"])
            merged["ventes"] = payload.get("ventes", merged["ventes"])
            merged["stock"] = payload.get("stock", merged["stock"])
            merged["commandes"] = payload.get("commandes", merged.get("commandes", []))
            merged["stockChecks"] = payload.get("stockChecks", merged.get("stockChecks", []))
            merged["categories"] = payload.get("categories", merged.get("categories", DEFAULT_STATE["categories"]))
            merged["charges"] = payload.get("charges", merged["charges"])
            for index, site in enumerate(merged["sites"], start=1):
                site.setdefault("prefixeFacture", f"SITE{index}")
            normalize_auth_users(merged)
            merged["_meta"] = payload.get("_meta") or {"rev": 1, "updatedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())}
            # Ensure DB has normalized payload
            self._write(merged)
            return merged

        if not self.path.exists():
            initial = build_default_state()
            self._write(initial)
            return initial
        try:
            payload = json.loads(self.path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            payload = build_default_state()
            self._write(payload)
            return payload

        payload = migrate_state(payload)
        merged = build_default_state()
        merged.update({k: v for k, v in payload.items() if k in merged})
        merged["auth"]["users"] = payload.get("auth", {}).get("users", merged["auth"]["users"])
        merged["nextId"].update(payload.get("nextId", {}))
        merged["sites"] = payload.get("sites", merged["sites"])
        merged["activeSiteId"] = payload.get("activeSiteId", merged["activeSiteId"])
        merged["ventes"] = payload.get("ventes", merged["ventes"])
        merged["stock"] = payload.get("stock", merged["stock"])
        merged["commandes"] = payload.get("commandes", merged.get("commandes", []))
        merged["stockChecks"] = payload.get("stockChecks", merged.get("stockChecks", []))
        merged["categories"] = payload.get("categories", merged.get("categories", DEFAULT_STATE["categories"]))
        merged["charges"] = payload.get("charges", merged["charges"])
        for index, site in enumerate(merged["sites"], start=1):
            site.setdefault("prefixeFacture", f"SITE{index}")
        normalize_auth_users(merged)
        merged["_meta"] = payload.get("_meta") or {"rev": 1, "updatedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())}
        self._write(merged)
        return merged

    def _write(self, payload: dict[str, Any]) -> None:
        BACKUP_DIR.mkdir(parents=True, exist_ok=True)
        # Update meta
        self._rev = int(self._rev or 0) + 1
        self._updated_at = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
        payload["_meta"] = {"rev": self._rev, "updatedAt": self._updated_at}

        body = json.dumps(payload, ensure_ascii=False, indent=2)

        if self._sqlite_enabled:
            self._sqlite_set("state", body)
            # Lightweight rolling backups (copy the DB file).
            try:
                stamp = time.strftime("%Y%m%d-%H%M%S")
                backup_path = BACKUP_DIR / f"app-{stamp}.sqlite3"
                if self._sqlite_path.exists():
                    backup_path.write_bytes(self._sqlite_path.read_bytes())
                backups = sorted(BACKUP_DIR.glob("app-*.sqlite3"), key=lambda p: p.name, reverse=True)
                for old in backups[10:]:
                    try:
                        old.unlink()
                    except OSError:
                        pass
            except OSError:
                pass
            self._last_etag = self._compute_etag()
            return

        tmp_path = self.path.with_suffix(self.path.suffix + ".tmp")
        # Atomic-ish write: write tmp then replace.
        tmp_path.write_text(body, encoding="utf-8")
        try:
            tmp_path.replace(self.path)
        finally:
            if tmp_path.exists():
                try:
                    tmp_path.unlink()
                except OSError:
                    pass

        # Lightweight rolling backups (keep last 10 snapshots).
        try:
            stamp = time.strftime("%Y%m%d-%H%M%S")
            backup_path = BACKUP_DIR / f"data-{stamp}.json"
            backup_path.write_text(body, encoding="utf-8")
            backups = sorted(BACKUP_DIR.glob("data-*.json"), key=lambda p: p.name, reverse=True)
            for old in backups[10:]:
                try:
                    old.unlink()
                except OSError:
                    pass
        except OSError:
            pass

        self._last_etag = self._compute_etag()

    def etag(self) -> str:
        with self._lock:
            return self._last_etag

    def meta(self) -> dict[str, Any]:
        with self._lock:
            return {"rev": int(self._rev or 0), "updatedAt": self._updated_at}

    def public_state(self) -> dict[str, Any]:
        with self._lock:
            return {
                "meta": {
                    **self.meta(),
                },
                "sites": json.loads(json.dumps(self._state["sites"])),
                "activeSiteId": self._state["activeSiteId"],
                "ventes": json.loads(json.dumps(self._state["ventes"])),
                "stock": json.loads(json.dumps(self._state["stock"])),
                "commandes": json.loads(json.dumps(self._state.get("commandes", []))),
                "stockChecks": json.loads(json.dumps(self._state.get("stockChecks", []))),
                "dayBooks": json.loads(json.dumps(self._state.get("dayBooks", []))),
                "purchaseOrders": json.loads(json.dumps(self._state.get("purchaseOrders", []))),
                "creditRecoveries": json.loads(json.dumps(self._state.get("creditRecoveries", []))),
                "categories": json.loads(json.dumps(self._state.get("categories", DEFAULT_STATE["categories"]))),
                "charges": json.loads(json.dumps(self._state["charges"])),
                "nextId": json.loads(json.dumps(self._state["nextId"])),
                "staffAuditLog": json.loads(json.dumps(self._state.get("staffAuditLog", []))),
                "auth": {
                    "users": [
                        {
                            "username": u["username"],
                            "role": u["role"],
                            "allowedSiteIds": u.get("allowedSiteIds", []),
                            "twoFactorEnabled": bool(u.get("twoFactorEnabled", False)),
                        }
                        for u in self._state["auth"]["users"]
                    ],
                },
            }

    def changes(self, *, since: str, site_id: str | None = None) -> dict[str, Any]:
        """Return incremental changes since an ISO timestamp (UTC)."""
        with self._lock:
            since_raw = str(since or "").strip()
            if not since_raw:
                since_raw = "1970-01-01T00:00:00Z"
            commandes = []
            for order in self._state.get("commandes", []) or []:
                if site_id and order.get("siteId") != site_id:
                    continue
                # Focus on QR sourced orders (most frequent changes).
                if order.get("source") != "qr":
                    continue
                updated = str(order.get("updatedAt") or order.get("createdAt") or "")
                if updated and updated > since_raw:
                    commandes.append(order)
            return {
                "meta": self.meta(),
                "since": since_raw,
                "changes": {
                    "commandes": json.loads(json.dumps(commandes)),
                },
            }

    def restore_from_json_file(self) -> dict[str, Any]:
        """Admin recovery: load DATA_FILE and overwrite current storage."""
        with self._lock:
            try:
                payload = json.loads(DATA_FILE.read_text(encoding="utf-8"))
            except (OSError, json.JSONDecodeError):
                raise ValueError("Impossible de lire data.json.")

            payload = migrate_state(payload)
            merged = build_default_state()
            merged.update({k: v for k, v in payload.items() if k in merged})
            merged["auth"]["users"] = payload.get("auth", {}).get("users", merged["auth"]["users"])
            merged["nextId"].update(payload.get("nextId", {}))
            merged["sites"] = payload.get("sites", merged["sites"])
            merged["activeSiteId"] = payload.get("activeSiteId", merged["activeSiteId"])
            merged["ventes"] = payload.get("ventes", merged["ventes"])
            merged["stock"] = payload.get("stock", merged["stock"])
            merged["commandes"] = payload.get("commandes", merged.get("commandes", []))
            merged["stockChecks"] = payload.get("stockChecks", merged.get("stockChecks", []))
            merged["dayBooks"] = payload.get("dayBooks", merged.get("dayBooks", []))
            merged["categories"] = payload.get("categories", merged.get("categories", DEFAULT_STATE["categories"]))
            merged["charges"] = payload.get("charges", merged["charges"])
            for index, site in enumerate(merged["sites"], start=1):
                site.setdefault("prefixeFacture", f"SITE{index}")
            normalize_auth_users(merged)
            self._state = merged
            self._write(self._state)
            return self.public_state()

    def public_menu(self, site_id: str, location: str = "Intérieur") -> dict[str, Any] | None:
        with self._lock:
            site = next((item for item in self._state["sites"] if item.get("id") == site_id), None)
            if not site:
                return None
            reserved = reserved_bottles_for_site(site_id, self._state.get("commandes", []) or [])
            stock_by_article = stock_total_by_article(site_id, self._state.get("stock", []) or [])
            available_by_article = {
                k: max(0, stock_by_article.get(k, 0) - reserved.get(k, 0))
                for k in stock_by_article.keys()
            }

            # De-duplicate menu items by key (article::packSize). This avoids duplicates when
            # the stock contains the same article multiple times.
            by_key: dict[str, dict[str, Any]] = {}
            for item in self._state["stock"]:
                if item.get("siteId") != site_id:
                    continue
                article_key = str(item.get("article", "")).strip().lower()
                if not article_key:
                    continue
                for format_data in sale_formats(item):
                    prix = price_for_format(format_data, location)
                    if prix <= 0:
                        continue
                    pack_size = max(1, int(format_data["quantite"]))
                    # Only show items that can be served now (at least one unit/kit available).
                    if available_by_article.get(article_key, 0) < pack_size:
                        continue
                    key = f"{item.get('article', '')}::{pack_size}"
                    candidate = {
                        "key": key,
                        "article": item.get("article", ""),
                        "cat": item.get("cat", "Autres"),
                        "prix": prix,
                        "packSize": pack_size,
                        "formatQuantite": pack_size,
                        # Bottles disponibles pour cet article (apres reservations commandes ouvertes).
                        "availableBottles": int(available_by_article.get(article_key, 0)),
                    }
                    existing = by_key.get(key)
                    # If duplicates exist, keep the highest price (safer than undercharging).
                    if existing is None or float(candidate.get("prix") or 0) > float(existing.get("prix") or 0):
                        by_key[key] = candidate

            menu = list(by_key.values())
            menu.sort(key=lambda item: (item["cat"], item["article"], int(item.get("packSize") or 1)))
            return {"site": json.loads(json.dumps(site)), "menu": menu, "location": location}

    def create_public_order(
        self,
        *,
        site_id: str,
        client: str,
        table_label: str,
        note: str,
        location: str = "Intérieur",
        items: list[dict[str, Any]],
    ) -> dict[str, Any]:
        with self._lock:
            site = next((item for item in self._state["sites"] if item.get("id") == site_id), None)
            if not site:
                raise ValueError("Maquis introuvable.")

            stock_rows = [item for item in self._state.get("stock", []) if item.get("siteId") == site_id]
            stock_items = {
                str(item.get("article", "")).strip().lower(): item
                for item in stock_rows
                if str(item.get("article", "")).strip()
            }
            stock_totals = stock_total_by_article(site_id, stock_rows)
            reserved_totals = reserved_bottles_for_site(site_id, self._state.get("commandes", []) or [])
            lignes = []
            requested: dict[str, int] = {}
            for raw_item in items:
                article = str(raw_item.get("article", "")).strip()
                qty = int(raw_item.get("qty") or 0)
                requested_format = int(raw_item.get("formatQuantite") or raw_item.get("packSize") or 0)
                if not article or qty <= 0:
                    continue
                stock_item = stock_items.get(article.lower())
                if not stock_item:
                    continue
                formats = sale_formats(stock_item)
                selected_format = next((fmt for fmt in formats if fmt["quantite"] == requested_format), None) or (formats[0] if formats else None)
                if not selected_format:
                    continue
                bottles = qty * int(selected_format["quantite"])
                key = article.lower()
                total_stock = stock_totals.get(key, 0)
                available = max(0, total_stock - reserved_totals.get(key, 0) - requested.get(key, 0))
                if available < bottles:
                    raise ValueError(f"Stock insuffisant pour {stock_item.get('article', article)}. Disponible: {available}.")
                requested[key] = requested.get(key, 0) + bottles
                prix = price_for_format(selected_format, location)
                if prix <= 0:
                    continue
                lignes.append({
                    "id": self._state["nextId"]["ligneCommande"],
                    "date": time.strftime("%Y-%m-%d"),
                    "article": stock_item.get("article", article),
                    "cat": stock_item.get("cat", "Autres"),
                    "location": location,
                    "formatQuantite": int(selected_format["quantite"]),
                    "prix": prix,
                    "qty": qty,
                    "remise": 0,
                    "paiement": "A regler",
                    "note": note.strip(),
                })
                self._state["nextId"]["ligneCommande"] += 1

            if not lignes:
                raise ValueError("Aucun article valide dans la commande.")

            label = table_label.strip() or "Comptoir"
            client_label = client.strip() or label
            existing_order = next((
                item for item in self._state.get("commandes", [])
                if item.get("siteId") == site_id
                and item.get("source") == "qr"
                and item.get("table") == label
                and item.get("client") == client_label
                and item.get("status") not in ("Paye", "Payé", "Annule", "Annulé")
            ), None)
            if existing_order:
                # Réserve hors cette commande : sinon on soustrait deux fois les lignes déjà présentes.
                reserved_other = reserved_bottles_for_site_excluding_order(
                    site_id,
                    self._state.get("commandes", []) or [],
                    int(existing_order.get("id") or 0) or None,
                )
                # Ensure merged orders cannot exceed physical stock across duplicate rows / cumulative qty.
                merge_requested = dict(requested)
                for line in existing_order.get("lignes", []) or []:
                    k = str(line.get("article", "")).strip().lower()
                    if not k:
                        continue
                    pack_size = int(line.get("formatQuantite") or line.get("packSize") or 1)
                    merge_requested[k] = merge_requested.get(k, 0) + (int(line.get("qty") or 0) * max(1, pack_size))
                for k, bottles in merge_requested.items():
                    total_stock = stock_totals.get(k, 0)
                    available_merge = max(0, total_stock - reserved_other.get(k, 0))
                    if bottles > available_merge:
                        article_label = (stock_items.get(k) or {}).get("article") or k
                        raise ValueError(f"Stock insuffisant pour {article_label}. Disponible: {available_merge}.")
                existing_order.setdefault("lignes", []).extend(lignes)
                existing_order["date"] = time.strftime("%Y-%m-%d")
                existing_order["updatedAt"] = time.strftime("%Y-%m-%dT%H:%M:%S")
                if note.strip():
                    existing_order["note"] = f"{existing_order.get('note', '')} | {note.strip()}".strip(" |")
                self._write(self._state)
                return json.loads(json.dumps(existing_order))

            order_id = self._state["nextId"]["commande"]
            self._state["nextId"]["commande"] += 1
            order = {
                "id": order_id,
                "siteId": site_id,
                "client": client_label,
                "date": time.strftime("%Y-%m-%d"),
                "createdAt": time.strftime("%Y-%m-%dT%H:%M:%S"),
                "status": "En attente",
                "type": "sur-place",
                "server": "Client QR",
                "note": f"QR {label}" + (f" · {note.strip()}" if note.strip() else ""),
                "source": "qr",
                "table": label,
                "lignes": lignes,
            }
            self._state["commandes"].insert(0, order)
            self._write(self._state)
            return json.loads(json.dumps(order))

    def public_orders(self, site_id: str, table_label: str, client: str = "") -> dict[str, Any]:
        with self._lock:
            label = table_label.strip() or "Comptoir"
            client_label = client.strip()
            # Client must be identified to see any orders
            if not client_label:
                return {"orders": [], "totalDue": 0, "totalPaid": 0}

            open_orders = []
            for order in self._state.get("commandes", []):
                if order.get("siteId") != site_id:
                    continue
                if order.get("table") != label:
                    continue
                # Strict client match only — never show another client's orders
                if order.get("client") != client_label:
                    continue
                total = sum((float(line.get("prix") or 0) * float(line.get("qty") or 0) - float(line.get("remise") or 0)) for line in order.get("lignes", []))
                open_orders.append({
                    "id": order.get("id"),
                    "client": order.get("client", client_label),
                    "table": label,
                    "date": order.get("date", ""),
                    "status": order.get("status", "En attente"),
                    "paid": False,
                    "total": total,
                    "items": len(order.get("lignes", [])),
                    "lignes": [
                        {
                            "article": line.get("article", ""),
                            "cat": line.get("cat", ""),
                            "qty": line.get("qty", 0),
                            "prix": line.get("prix", 0),
                            "remise": line.get("remise", 0),
                            "formatQuantite": line.get("formatQuantite") or line.get("packSize") or 1,
                        }
                        for line in order.get("lignes", [])
                    ],
                })

            invoices: dict[str, dict[str, Any]] = {}
            for sale in self._state.get("ventes", []):
                if sale.get("siteId") != site_id:
                    continue
                sale_client = str(sale.get("client", ""))
                sale_table = str(sale.get("table", ""))
                # Strict match: table must match AND client must match
                if sale_table != label or sale_client != client_label:
                    continue
                key = sale.get("factureNumber") or f"VENTE-{sale.get('id')}"
                invoice = invoices.setdefault(key, {
                    "id": key,
                    "client": sale_client,
                    "table": label,
                    "date": sale.get("date", ""),
                    "status": "Reglee",
                    "paid": True,
                    "total": 0,
                    "items": 0,
                    "lignes": [],
                })
                invoice["total"] += float(sale.get("prix") or 0) * float(sale.get("qty") or 0) - float(sale.get("remise") or 0)
                invoice["items"] += 1
                invoice["lignes"].append({
                    "article": sale.get("article", ""),
                    "cat": sale.get("cat", ""),
                    "qty": sale.get("qty", 0),
                    "prix": sale.get("prix", 0),
                    "remise": sale.get("remise", 0),
                    "formatQuantite": sale.get("formatQuantite") or sale.get("packSize") or 1,
                })

            orders = open_orders + list(invoices.values())
            total_due = sum(item["total"] for item in open_orders)
            total_paid = sum(item["total"] for item in invoices.values())
            return {"orders": json.loads(json.dumps(orders)), "totalDue": total_due, "totalPaid": total_paid}

    def verify_credentials(self, username: str, password: str) -> dict[str, Any] | None:
        with self._lock:
            all_site_ids = [site["id"] for site in self._state["sites"]]
            for user in self._state["auth"]["users"]:
                if hmac.compare_digest(username, user["username"]) and verify_password(password, user.get("passwordHash", "")):
                    if password_needs_upgrade(user.get("passwordHash", "")):
                        user["passwordHash"] = hash_password(password)
                        self._write(self._state)
                    allowed = [sid for sid in user.get("allowedSiteIds", all_site_ids) if sid in all_site_ids] or all_site_ids[:1]
                    return {"username": user["username"], "role": user["role"], "allowedSiteIds": allowed}
        return None

    def update_state(self, payload: dict[str, Any]) -> dict[str, Any]:
        with self._lock:
            current = self._state
            current["sites"] = payload.get("sites", current["sites"])
            current["activeSiteId"] = payload.get("activeSiteId", current["activeSiteId"])
            current["ventes"] = payload.get("ventes", current["ventes"])
            current["stock"] = payload.get("stock", current["stock"])
            current["commandes"] = payload.get("commandes", current.get("commandes", []))
            current["stockChecks"] = payload.get("stockChecks", current.get("stockChecks", []))
            current["dayBooks"] = payload.get("dayBooks", current.get("dayBooks", []))
            current["purchaseOrders"] = payload.get("purchaseOrders", current.get("purchaseOrders", []))
            current["creditRecoveries"] = payload.get("creditRecoveries", current.get("creditRecoveries", []))
            current["categories"] = payload.get("categories", current.get("categories", DEFAULT_STATE["categories"]))
            current["charges"] = payload.get("charges", current["charges"])
            current["nextId"] = payload.get("nextId", current["nextId"])
            current["staffAuditLog"] = payload.get("staffAuditLog", current.get("staffAuditLog", []))

            site_ids = [site.get("id") for site in current["sites"] if site.get("id")]

            auth_payload = payload.get("auth", {})
            users_payload = auth_payload.get("users")
            if isinstance(users_payload, list):
                existing_by_name = {u["username"]: u for u in current["auth"]["users"]}
                new_users = []
                for user_data in users_payload:
                    username = str(user_data.get("username", "")).strip()
                    role = str(user_data.get("role", "serveuse"))
                    if username == "admin":
                        role = "admin"
                    if not username or role not in ("admin", "manager", "serveuse"):
                        continue
                    password = str(user_data.get("password", "")).strip()
                    if password:
                        password_hash = hash_password(password)
                    elif username in existing_by_name:
                        password_hash = existing_by_name[username]["passwordHash"]
                    else:
                        password_hash = hash_password("serveuse123")
                    raw = user_data.get("allowedSiteIds")
                    if raw is not None:
                        allowed = [sid for sid in raw if sid in site_ids] or site_ids[:1]
                    elif username in existing_by_name:
                        allowed = [sid for sid in existing_by_name[username].get("allowedSiteIds", []) if sid in site_ids] or site_ids[:1]
                    else:
                        allowed = site_ids[:1]
                    if username == "admin":
                        allowed = site_ids
                    existing = existing_by_name.get(username, {})
                    user_entry: dict[str, Any] = {
                        "username": username,
                        "passwordHash": password_hash,
                        "role": role,
                        "allowedSiteIds": allowed,
                        "twoFactorEnabled": existing.get("twoFactorEnabled", False),
                    }
                    if existing.get("twoFactorSecret"):
                        user_entry["twoFactorSecret"] = existing["twoFactorSecret"]
                    new_users.append(user_entry)
                if not new_users:
                    raise ValueError("Aucun utilisateur valide.")
                if not any(u["role"] in ("admin", "manager") for u in new_users):
                    raise ValueError("Au moins un administrateur ou gerant est obligatoire.")
                current["auth"]["users"] = new_users
            if current["activeSiteId"] not in site_ids and site_ids:
                current["activeSiteId"] = site_ids[0]

            self._write(current)
            return self.public_state()

    def reset(self) -> dict[str, Any]:
        with self._lock:
            self._state = build_default_state()
            self._write(self._state)
            return self.public_state()


store = DataStore(DATA_FILE)
sessions = SessionManager(SESSION_TTL_SECONDS)


class AppHandler(BaseHTTPRequestHandler):
    server_version = "TDBBarServer/1.0"

    def _send_security_headers(self) -> None:
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "no-referrer")
        self.send_header("X-Frame-Options", "DENY")
        self.send_header("Permissions-Policy", "geolocation=(), microphone=(), camera=()")

    def client_ip(self) -> str:
        # If behind cloudflared, try CF-Connecting-IP.
        ip = (self.headers.get("CF-Connecting-IP") or "").strip()
        if ip:
            return ip
        return (self.client_address[0] if self.client_address else "") or "unknown"

    def do_GET(self) -> None:
        parsed = urlparse(self.path)
        query = parse_qs(parsed.query)
        if parsed.path == "/api/public/menu":
            site_id = str((query.get("siteId") or [""])[0]).strip()
            location = str((query.get("location") or ["Intérieur"])[0]).strip()
            payload = store.public_menu(site_id, location)
            if payload is None:
                self.send_json(HTTPStatus.NOT_FOUND, {"error": "Maquis introuvable."})
                return
            self.send_json(HTTPStatus.OK, payload)
            return
        if parsed.path == "/api/public/orders":
            site_id = str((query.get("siteId") or [""])[0]).strip()
            table = str((query.get("table") or [""])[0]).strip()
            client = str((query.get("client") or [""])[0]).strip()
            self.send_json(HTTPStatus.OK, store.public_orders(site_id, table, client))
            return
        if parsed.path == "/api/session":
            session = self.require_session()
            if session is None:
                return
            self.send_json(
                HTTPStatus.OK,
                {
                    "authenticated": True,
                    "username": session["username"],
                    "role": session["role"],
                    "allowedSiteIds": session["allowedSiteIds"],
                },
            )
            return
        if parsed.path == "/api/changes":
            if self.require_session() is None:
                return
            since = str((query.get("since") or [""])[0]).strip()
            site_id = str((query.get("siteId") or [""])[0]).strip() or None
            self.send_json(HTTPStatus.OK, store.changes(since=since, site_id=site_id), cache_control="no-store")
            return
        if parsed.path == "/api/state":
            if self.require_session() is None:
                return
            etag = store.etag()
            if self.headers.get("If-None-Match") == etag:
                self.send_not_modified(etag)
                return
            self.send_json(HTTPStatus.OK, store.public_state(), etag=etag, cache_control="no-cache")
            return
        if parsed.path == "/api/public/order":
            self.send_error(HTTPStatus.METHOD_NOT_ALLOWED)
            return
        self.serve_static(parsed.path)

    def do_POST(self) -> None:
        parsed = urlparse(self.path)
        if parsed.path == "/api/admin/restore-from-json":
            session = self.require_session()
            if session is None:
                return
            if session.get("role") != "admin":
                self.send_json(HTTPStatus.FORBIDDEN, {"error": "Acces refuse."})
                return
            try:
                restored = store.restore_from_json_file()
            except ValueError as error:
                self.send_json(HTTPStatus.BAD_REQUEST, {"error": str(error)})
                return
            audit_log("restore_from_json", {"ip": self.client_ip(), "username": session.get("username", "")})
            self.send_json(HTTPStatus.OK, restored, cache_control="no-store")
            return
        if parsed.path == "/api/public/order":
            payload = self.read_json()
            try:
                order = store.create_public_order(
                    site_id=str(payload.get("siteId", "")).strip(),
                    client=str(payload.get("client", "")).strip(),
                    table_label=str(payload.get("table", "")).strip(),
                    note=str(payload.get("note", "")).strip(),
                    location=str(payload.get("location", "Intérieur")).strip(),
                    items=payload.get("items", []),
                )
            except ValueError as error:
                self.send_json(HTTPStatus.BAD_REQUEST, {"error": str(error)})
                return
            self.send_json(HTTPStatus.OK, {"ok": True, "order": order})
            return

        if parsed.path == "/api/login":
            payload = self.read_json()
            username = str(payload.get("username", "")).strip()
            password = str(payload.get("password", ""))
            ip = self.client_ip()
            allowed, retry_after = login_rate_limit_check(ip, username)
            if not allowed:
                audit_log("login_blocked", {"ip": ip, "username": username, "retryAfter": retry_after})
                self.send_json(
                    HTTPStatus.TOO_MANY_REQUESTS,
                    {"error": "Trop de tentatives. Reessayez plus tard.", "retryAfter": retry_after},
                    cache_control="no-store",
                )
                return
            user = store.verify_credentials(username, password)
            if user is None:
                login_rate_limit_fail(ip, username)
                audit_log("login_failed", {"ip": ip, "username": username})
                self.send_json(HTTPStatus.UNAUTHORIZED, {"error": "Identifiants invalides."})
                return
            login_rate_limit_success(ip, username)
            audit_log("login_success", {"ip": ip, "username": username})
            with store._lock:
                user_data = next((u for u in store._state["auth"]["users"] if u["username"] == username), None)
                has_2fa = bool(user_data and user_data.get("twoFactorEnabled") and user_data.get("twoFactorSecret"))
            if has_2fa:
                pre_auth = create_pre_auth_token(username)
                self.send_json(HTTPStatus.OK, {"needsTwoFactor": True, "preAuthToken": pre_auth})
                return
            token = sessions.create(user["username"], user["role"], user["allowedSiteIds"])
            self.send_json(
                HTTPStatus.OK,
                {"authenticated": True, "username": user["username"], "role": user["role"], "allowedSiteIds": user["allowedSiteIds"]},
                cookie=token,
            )
            return

        if parsed.path == "/api/2fa/verify":
            payload = self.read_json()
            pre_auth_token = str(payload.get("preAuthToken", "")).strip()
            code = str(payload.get("code", "")).strip()
            username = consume_pre_auth_token(pre_auth_token)
            if username is None:
                self.send_json(HTTPStatus.UNAUTHORIZED, {"error": "Token expire ou invalide."})
                return
            with store._lock:
                user_data = next((u for u in store._state["auth"]["users"] if u["username"] == username), None)
                if not user_data or not user_data.get("twoFactorEnabled") or not user_data.get("twoFactorSecret"):
                    self.send_json(HTTPStatus.UNAUTHORIZED, {"error": "2FA non configure."})
                    return
                if not verify_totp(user_data["twoFactorSecret"], code):
                    self.send_json(HTTPStatus.UNAUTHORIZED, {"error": "Code 2FA invalide."})
                    return
                all_site_ids = [s["id"] for s in store._state["sites"]]
                allowed = [sid for sid in user_data.get("allowedSiteIds", all_site_ids) if sid in all_site_ids] or all_site_ids[:1]
                role = user_data["role"]
            token = sessions.create(username, role, allowed)
            self.send_json(HTTPStatus.OK, {"authenticated": True, "username": username, "role": role, "allowedSiteIds": allowed}, cookie=token)
            return

        if parsed.path == "/api/2fa/setup":
            session = self.require_session()
            if session is None:
                return
            payload = self.read_json()
            target = str(payload.get("username", session["username"])).strip()
            if target != session["username"] and session["role"] != "manager":
                self.send_json(HTTPStatus.FORBIDDEN, {"error": "Acces refuse."})
                return
            secret = generate_totp_secret()
            with store._lock:
                for u in store._state["auth"]["users"]:
                    if u["username"] == target:
                        u["twoFactorSecretPending"] = secret
                        store._write(store._state)
                        break
                else:
                    self.send_json(HTTPStatus.NOT_FOUND, {"error": "Utilisateur introuvable."})
                    return
            otp_url = f"otpauth://totp/TDB%20Bar:{target}?secret={secret}&issuer=TDB%20Bar&algorithm=SHA1&digits=6&period=30"
            self.send_json(HTTPStatus.OK, {"secret": secret, "otpauthUrl": otp_url})
            return

        if parsed.path == "/api/2fa/enable":
            session = self.require_session()
            if session is None:
                return
            payload = self.read_json()
            target = str(payload.get("username", session["username"])).strip()
            code = str(payload.get("code", "")).strip()
            if target != session["username"] and session["role"] != "manager":
                self.send_json(HTTPStatus.FORBIDDEN, {"error": "Acces refuse."})
                return
            with store._lock:
                for u in store._state["auth"]["users"]:
                    if u["username"] == target:
                        pending = u.get("twoFactorSecretPending")
                        if not pending:
                            self.send_json(HTTPStatus.BAD_REQUEST, {"error": "Aucune configuration 2FA en attente. Lancez d'abord la configuration."})
                            return
                        if not verify_totp(pending, code):
                            self.send_json(HTTPStatus.UNAUTHORIZED, {"error": "Code invalide. Verifiez l'heure de votre appareil."})
                            return
                        u["twoFactorSecret"] = pending
                        u["twoFactorEnabled"] = True
                        u.pop("twoFactorSecretPending", None)
                        store._write(store._state)
                        self.send_json(HTTPStatus.OK, {"ok": True})
                        return
                self.send_json(HTTPStatus.NOT_FOUND, {"error": "Utilisateur introuvable."})
            return

        if parsed.path == "/api/2fa/disable":
            session = self.require_session()
            if session is None:
                return
            payload = self.read_json()
            target = str(payload.get("username", session["username"])).strip()
            if target != session["username"] and session["role"] != "manager":
                self.send_json(HTTPStatus.FORBIDDEN, {"error": "Acces refuse."})
                return
            with store._lock:
                for u in store._state["auth"]["users"]:
                    if u["username"] == target:
                        u.pop("twoFactorSecret", None)
                        u.pop("twoFactorSecretPending", None)
                        u["twoFactorEnabled"] = False
                        store._write(store._state)
                        self.send_json(HTTPStatus.OK, {"ok": True})
                        return
                self.send_json(HTTPStatus.NOT_FOUND, {"error": "Utilisateur introuvable."})
            return

        if parsed.path == "/api/logout":
            token = self.session_token()
            sessions.clear(token)
            self.send_json(HTTPStatus.OK, {"authenticated": False}, clear_cookie=True)
            return

        if parsed.path == "/api/reset":
            if self.require_session() is None:
                return
            payload = store.reset()
            self.send_json(HTTPStatus.OK, payload)
            return

        if parsed.path.startswith("/api/"):
            self.send_json(HTTPStatus.NOT_FOUND, {"error": "Route API introuvable. Verifiez que la derniere version du serveur est deployee."})
            return
        self.send_error(HTTPStatus.NOT_FOUND)

    def do_OPTIONS(self) -> None:
        self.send_response(HTTPStatus.NO_CONTENT)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, PUT, OPTIONS")
        self.end_headers()

    def do_PUT(self) -> None:
        parsed = urlparse(self.path)
        if parsed.path == "/api/state":
            if self.require_session() is None:
                return
            payload = self.read_json()
            try:
                updated = store.update_state(payload)
            except ValueError as error:
                self.send_json(HTTPStatus.BAD_REQUEST, {"error": str(error)})
                return
            self.send_json(HTTPStatus.OK, updated)
            return
        if parsed.path.startswith("/api/"):
            self.send_json(HTTPStatus.NOT_FOUND, {"error": "Route API introuvable. Verifiez que la derniere version du serveur est deployee."})
            return
        self.send_error(HTTPStatus.NOT_FOUND)

    def serve_static(self, raw_path: str) -> None:
        route = "/" if raw_path == "" else raw_path
        if route == "/":
            route = "/index.html"
        target = (BASE_DIR / route.lstrip("/")).resolve()
        if BASE_DIR not in target.parents and target != BASE_DIR / "index.html":
            self.send_error(HTTPStatus.FORBIDDEN)
            return
        if not target.exists() or not target.is_file():
            self.send_error(HTTPStatus.NOT_FOUND)
            return
        content_type = self.guess_content_type(target.suffix.lower())
        try:
            stat = target.stat()
            etag = f'W/"{int(stat.st_mtime)}-{stat.st_size}"'
        except OSError:
            etag = None

        if etag and self.headers.get("If-None-Match") == etag:
            self.send_response(HTTPStatus.NOT_MODIFIED)
            self._send_security_headers()
            self.send_header("ETag", etag)
            self.send_header("Cache-Control", "no-cache")
            self.end_headers()
            return

        body = target.read_bytes()
        cache_control = "no-store, no-cache, must-revalidate"
        suffix = target.suffix.lower()
        if suffix in (".js", ".css"):
            # Toujours revalider avec le serveur (déploiements + ?v= dans index.html).
            cache_control = "no-cache"
        elif suffix in (".svg", ".json"):
            cache_control = "public, max-age=3600"

        accept_encoding = self.headers.get("Accept-Encoding", "")
        use_gzip = "gzip" in accept_encoding.lower() and target.suffix.lower() in (".html", ".css", ".js", ".json", ".svg") and len(body) > 1024
        if use_gzip:
            body = gzip.compress(body, compresslevel=6)
        self.send_response(HTTPStatus.OK)
        self._send_security_headers()
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", cache_control)
        if etag:
            self.send_header("ETag", etag)
        if use_gzip:
            self.send_header("Content-Encoding", "gzip")
        self.end_headers()
        self.wfile.write(body)

    def require_session(self) -> dict[str, Any] | None:
        token = self.session_token()
        session = sessions.get(token)
        if session is None:
            self.send_json(HTTPStatus.UNAUTHORIZED, {"authenticated": False, "error": "Session invalide ou expiree."}, clear_cookie=True)
            return None
        return session

    def session_token(self) -> str | None:
        cookie_header = self.headers.get("Cookie")
        if not cookie_header:
            return None
        cookies = SimpleCookie()
        cookies.load(cookie_header)
        morsel = cookies.get(SESSION_COOKIE)
        return morsel.value if morsel else None

    def read_json(self) -> dict[str, Any]:
        length = int(self.headers.get("Content-Length", "0") or "0")
        raw = self.rfile.read(length) if length > 0 else b"{}"
        if not raw:
            return {}
        try:
            return json.loads(raw.decode("utf-8"))
        except json.JSONDecodeError:
            return {}

    def send_json(
        self,
        status: HTTPStatus,
        payload: dict[str, Any],
        *,
        cookie: str | None = None,
        clear_cookie: bool = False,
        etag: str | None = None,
        cache_control: str = "no-store",
    ) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        accept_encoding = self.headers.get("Accept-Encoding", "")
        use_gzip = "gzip" in accept_encoding.lower() and len(body) > 1024
        if use_gzip:
            body = gzip.compress(body, compresslevel=6)
        self.send_response(status)
        self._send_security_headers()
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", cache_control)
        if etag:
            self.send_header("ETag", etag)
        if use_gzip:
            self.send_header("Content-Encoding", "gzip")
        if cookie:
            self.send_header(
                "Set-Cookie",
                f"{SESSION_COOKIE}={cookie}; Path=/; HttpOnly; SameSite=Lax; Max-Age={SESSION_TTL_SECONDS}",
            )
        if clear_cookie:
            self.send_header(
                "Set-Cookie",
                f"{SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0",
            )
        self.end_headers()
        self.wfile.write(body)

    def send_not_modified(self, etag: str) -> None:
        self.send_response(HTTPStatus.NOT_MODIFIED)
        self._send_security_headers()
        self.send_header("ETag", etag)
        self.send_header("Cache-Control", "no-cache")
        self.end_headers()

    def guess_content_type(self, suffix: str) -> str:
        mapping = {
            ".html": "text/html; charset=utf-8",
            ".css": "text/css; charset=utf-8",
            ".js": "application/javascript; charset=utf-8",
            ".json": "application/json; charset=utf-8",
            ".svg": "image/svg+xml",
        }
        return mapping.get(suffix, "application/octet-stream")

    def log_message(self, format: str, *args: Any) -> None:
        return


def main() -> None:
    host = os.environ.get("TDB_BAR_HOST", "0.0.0.0")
    requested_port = int(os.environ.get("TDB_BAR_PORT", "8000"))
    candidate_ports = []
    for port in (requested_port, 8001, 8080, 8765):
        if port not in candidate_ports:
            candidate_ports.append(port)

    server = None
    bound_port = None
    last_error = None

    for port in candidate_ports:
        try:
            server = ThreadingHTTPServer((host, port), AppHandler)
            bound_port = port
            break
        except OSError as error:
            last_error = error
            continue

    if server is None or bound_port is None:
        message = "Impossible de demarrer le serveur. Aucun port disponible."
        if isinstance(last_error, OSError):
            message += f" Derniere erreur: {last_error}"
        raise OSError(message)

    print(f"TDB Bar server running on http://127.0.0.1:{bound_port}")
    print(f"Storage mode: {STORAGE_MODE}")
    try:
        hostname = socket.gethostname()
        lan_ip = socket.gethostbyname(hostname)
        if lan_ip and not lan_ip.startswith("127."):
            print(f"Reseau local: http://{lan_ip}:{bound_port}")
    except OSError:
        pass
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
