from __future__ import annotations

import base64
import copy
import gzip
import hashlib
import hmac
import json
import os
import re
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
from urllib.error import HTTPError, URLError
from urllib.parse import parse_qs, quote, urlparse, urlencode
from urllib.request import Request, urlopen

try:
    from fpdf import FPDF as _FPDF  # type: ignore[import-untyped]
    _FPDF_AVAILABLE = True
except ImportError:
    _FPDF_AVAILABLE = False

try:
    import psycopg2              # type: ignore[import-untyped]
    import psycopg2.extras       # type: ignore[import-untyped]
    _PSYCOPG2_OK = True
except ImportError:
    _PSYCOPG2_OK = False


BASE_DIR = Path(__file__).resolve().parent
DEBUG_LOG_FILE = BASE_DIR / "debug-dee456.log"


def _dbg_session(msg: str, hypothesis_id: str, data: dict[str, Any]) -> None:
    # #region agent log
    try:
        line = json.dumps(
            {
                "sessionId": "dee456",
                "hypothesisId": hypothesis_id,
                "location": "server.py",
                "message": msg,
                "data": data,
                "timestamp": int(time.time() * 1000),
            },
            ensure_ascii=False,
        )
        with DEBUG_LOG_FILE.open("a", encoding="utf-8") as _df:
            _df.write(line + "\n")
    except OSError:
        pass
    # #endregion


DATA_FILE = BASE_DIR / "data.json"
BACKUP_DIR = BASE_DIR / "backups"
AUDIT_LOG_FILE = BASE_DIR / "audit.log.jsonl"
SQLITE_FILE = BASE_DIR / "app.sqlite3"
SESSION_TTL_SECONDS = 60 * 60 * 8
SESSION_COOKIE = "maquis_manager_session"
PASSWORD_ALGO = "pbkdf2_sha256"
PASSWORD_ITERATIONS = 260_000


def _env_first(*names: str, default: str = "") -> str:
    """Premiere variable d'environnement non vide parmi `names` (ordre de priorite)."""
    for name in names:
        raw = os.environ.get(name)
        if raw is not None and str(raw).strip() != "":
            return str(raw).strip()
    return default


def _env_int_first(default: int, *names: str) -> int:
    for name in names:
        raw = os.environ.get(name)
        if raw is None or str(raw).strip() == "":
            continue
        try:
            return int(str(raw).strip())
        except ValueError:
            continue
    return default


# Stockage : MAQUIS_MANAGER_* en priorite, ancien nom TDB_BAR_* encore accepte.
STORAGE_MODE = (_env_first("MAQUIS_MANAGER_STORAGE", "TDB_BAR_STORAGE", default="json") or "json").strip().lower()
# DSN PostgreSQL : postgresql://user:pass@host:5432/dbname
PG_DSN = _env_first("PG_DSN", "DATABASE_URL")
# Nombre de fichiers data-*.json ou app-*.sqlite3 conserves dans backups/ (3–100).
try:
    BACKUP_KEEP_COUNT = max(3, min(100, _env_int_first(30, "MAQUIS_MANAGER_BACKUP_KEEP", "TDB_BAR_BACKUP_KEEP")))
except ValueError:
    BACKUP_KEEP_COUNT = 30

SESSION_ABSOLUTE_SECONDS = _env_int_first(
    SESSION_TTL_SECONDS,
    "MAQUIS_MANAGER_SESSION_ABSOLUTE_SECONDS",
    "MAQUIS_MANAGER_SESSION_TTL",
    "TDB_BAR_SESSION_TTL_SECONDS",
)
SESSION_IDLE_SECONDS = _env_int_first(
    30 * 60,
    "MAQUIS_MANAGER_SESSION_IDLE_SECONDS",
    "TDB_BAR_SESSION_IDLE_SECONDS",
)
REQUIRE_2FA_FOR_PRIVILEGED = _env_first(
    "MAQUIS_MANAGER_REQUIRE_2FA_ADMINS",
    default="0",
).lower() in ("1", "true", "yes", "on")
STATE_PUT_LIST_KEYS = (
    "ventes", "stock", "commandes", "stockChecks", "stockEntrees", "stockLosses",
    "dayBooks", "purchaseOrders", "supplierPrices", "casiers", "casierMouvements",
    "creditRecoveries", "consignes", "charges", "staffAuditLog", "workShifts",
)
# Mapping clé JSON → (table PostgreSQL, type d'id)
# type : "int" = item.id entier, "text" = item.id texte, "date_site" = clé date+siteId
_PG_TABLES: dict[str, tuple[str, str]] = {
    "ventes":           ("ventes",           "int"),
    "stock":            ("stock",            "int"),
    "commandes":        ("commandes",        "int"),
    "stockChecks":      ("stock_checks",     "date_site"),
    "stockEntrees":     ("stock_entrees",    "int"),
    "stockLosses":      ("stock_losses",     "int"),
    "dayBooks":         ("day_books",        "date_site"),
    "purchaseOrders":   ("purchase_orders",  "int"),
    "supplierPrices":   ("supplier_prices",  "text"),
    "casiers":          ("casiers",          "int"),
    "casierMouvements": ("casier_mouvements","int"),
    "creditRecoveries": ("credit_recoveries","int"),
    "consignes":        ("consignes",        "int"),
    "charges":          ("charges",          "int"),
    "staffAuditLog":    ("staff_audit_log",  "text"),
    "workShifts":       ("work_shifts",      "text"),
}
_PG_SKIP_SETTINGS = set(STATE_PUT_LIST_KEYS) | {"auth", "sites", "categories", "_meta"}
MAX_STATE_LIST_ROWS = 50_000


def validate_state_put_payload(payload: Any) -> None:
    if not isinstance(payload, dict):
        raise ValueError("Payload invalide.")
    for key in STATE_PUT_LIST_KEYS:
        rows = payload.get(key)
        if isinstance(rows, list) and len(rows) > MAX_STATE_LIST_ROWS:
            raise ValueError(f"Trop de lignes dans « {key} » (max {MAX_STATE_LIST_ROWS}).")

    # Sanitisation silencieuse des bornes numériques.
    # On clamp (pas de rejet) pour ne jamais bloquer un save avec des données existantes.
    for v in (payload.get("ventes") or []):
        if not isinstance(v, dict):
            continue
        qty = v.get("qty")
        if qty is not None:
            try:
                clamped = max(0, float(qty))
                if clamped != qty:
                    audit_log("data_anomaly", {"type": "vente_qty_negative", "id": v.get("id"), "val": qty})
                    v["qty"] = clamped
            except (TypeError, ValueError):
                v["qty"] = 0
        prix = v.get("prix")
        if prix is not None:
            try:
                clamped = max(0, float(prix))
                if clamped != prix:
                    audit_log("data_anomaly", {"type": "vente_prix_negative", "id": v.get("id"), "val": prix})
                    v["prix"] = clamped
            except (TypeError, ValueError):
                v["prix"] = 0

    for c in (payload.get("charges") or []):
        if not isinstance(c, dict):
            continue
        montant = c.get("montant")
        if montant is not None:
            try:
                clamped = max(0, float(montant))
                if clamped != montant:
                    audit_log("data_anomaly", {"type": "charge_montant_negative", "id": c.get("id"), "val": montant})
                    c["montant"] = clamped
            except (TypeError, ValueError):
                c["montant"] = 0

    for s in (payload.get("stock") or []):
        if not isinstance(s, dict):
            continue
        for field in ("init", "entrees", "sorties", "frigo", "reserve"):
            val = s.get(field)
            if val is not None:
                try:
                    clamped = max(0, float(val))
                    if clamped != val:
                        audit_log("data_anomaly", {"type": f"stock_{field}_negative", "article": s.get("article"), "val": val})
                        s[field] = clamped
                except (TypeError, ValueError):
                    s[field] = 0

# Libellé « émetteur » dans les applis OTP (QR 2FA) : indépendant du nom du maquis dans les paramètres.
TOTP_APP_LABEL = (
    _env_first(
        "MAQUIS_MANAGER_TOTP_LABEL",
        "MAQUIS_MANAGER_APP_NAME",
        "TDB_BAR_TOTP_LABEL",
        default="Maquis Manager",
    ).strip()
    or "Maquis Manager"
)


def privileged_role_requires_2fa_policy(role: str) -> bool:
    r = str(role or "").strip().lower()
    return r in ("superadmin", "admin", "manager")


def session_missing_required_2fa(session: dict[str, Any], auth_users: list[dict[str, Any]]) -> bool:
    if not REQUIRE_2FA_FOR_PRIVILEGED:
        return False
    if not privileged_role_requires_2fa_policy(str(session.get("role", ""))):
        return False
    u = next((x for x in auth_users if x.get("username") == session.get("username")), None)
    if not u:
        return False
    return not (bool(u.get("twoFactorEnabled")) and bool(u.get("twoFactorSecret")))


def _today_iso_local() -> str:
    return time.strftime("%Y-%m-%d", time.localtime())


def _sanitize_pdj_work_date_map(raw: Any, valid_site_ids: list[str]) -> dict[str, str]:
    """Dates comptables forcées par maquis (yyyy-mm-dd, <= aujourd'hui, sites connus)."""
    if not isinstance(raw, dict):
        return {}
    allowed = {str(s).strip() for s in valid_site_ids if s}
    tmax = _today_iso_local()
    out: dict[str, str] = {}
    for k, v in raw.items():
        sid = str(k).strip()
        if sid not in allowed:
            continue
        if v is None:
            continue
        s = str(v).strip()[:10]
        if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", s) or s > tmax:
            continue
        out[sid] = s
    return out


def _merge_pdj_work_date_map_session(
    current_map: Any,
    incoming: Any,
    allowed_site_ids: set[str],
    all_site_ids: list[str],
) -> dict[str, str]:
    """Met a jour pdjWorkDateBySite : part du serveur (tous maquis valides), puis patch des sites autorises."""
    cur = _sanitize_pdj_work_date_map(
        current_map if isinstance(current_map, dict) else {},
        list(all_site_ids),
    )
    if not isinstance(incoming, dict):
        return cur
    tmax = _today_iso_local()
    for sid_raw, v in incoming.items():
        sid = str(sid_raw).strip()
        if sid not in allowed_site_ids:
            continue
        if v is None or (isinstance(v, str) and not str(v).strip()):
            cur.pop(sid, None)
            continue
        s = str(v).strip()[:10]
        if re.fullmatch(r"\d{4}-\d{2}-\d{2}", s) and s <= tmax:
            cur[sid] = s
    return cur


def session_timing_fields(sess: dict[str, Any]) -> dict[str, Any]:
    out: dict[str, Any] = {}
    for key in (
        "sessionCreatedAt",
        "sessionDeadlineUnix",
        "sessionAbsoluteSeconds",
        "sessionIdleSeconds",
        "csrfToken",
    ):
        if key in sess:
            out[key] = sess[key]
    return out


def cookie_secure_flag() -> bool:
    return _env_first("MAQUIS_MANAGER_COOKIE_SECURE", "TDB_BAR_COOKIE_SECURE", default="").lower() in (
        "1",
        "true",
        "yes",
    )


# ---------------------------------------------------------------------------
# Rate limiting endpoint public
# ---------------------------------------------------------------------------
_public_order_rl: dict[str, list[float]] = {}
_public_order_rl_lock = threading.Lock()
_PUBLIC_ORDER_MAX = 30   # requêtes max
_PUBLIC_ORDER_WINDOW = 60  # par fenêtre de 60 secondes


def public_order_rate_limit_check(ip: str) -> bool:
    """Retourne True si la requête est autorisée, False sinon."""
    now = time.time()
    with _public_order_rl_lock:
        hits = _public_order_rl.get(ip, [])
        hits = [t for t in hits if now - t < _PUBLIC_ORDER_WINDOW]
        if len(hits) >= _PUBLIC_ORDER_MAX:
            return False
        hits.append(now)
        _public_order_rl[ip] = hits
    return True


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

# ---------------------------------------------------------------------------
# WhatsApp OTP store (15-minute TTL, consommé une seule fois)
# ---------------------------------------------------------------------------

_wa_otp_store: dict[str, tuple[str, float]] = {}  # username → (hashed_otp, expires_ts)
_wa_otp_lock = threading.Lock()


def _wa_otp_generate(username: str) -> str:
    """Génère un OTP 6 chiffres, le stocke hashé, retourne le code en clair."""
    otp = str(secrets.randbelow(900000) + 100000)  # 100000–999999
    hashed = hashlib.sha256(otp.encode()).hexdigest()
    with _wa_otp_lock:
        _wa_otp_store[username] = (hashed, time.time() + 900)  # TTL 15 min
    return otp


def _wa_otp_verify(username: str, otp: str) -> bool:
    """Vérifie le code OTP, retourne True et supprime l'entrée si valide."""
    with _wa_otp_lock:
        entry = _wa_otp_store.get(username)
        if not entry:
            return False
        hashed, expires = entry
        if time.time() > expires:
            del _wa_otp_store[username]
            return False
        ok = secrets.compare_digest(hashed, hashlib.sha256(otp.encode()).hexdigest())
        if ok:
            del _wa_otp_store[username]
        return ok


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


# ---------------------------------------------------------------------------
# Dédup des PUT /api/state — anti-double-soumission (ex : retry réseau)
# Clé : X-Op-Id fourni par le client (UUID), TTL 5 minutes.
# ---------------------------------------------------------------------------

_state_put_dedup: dict[str, int] = {}   # opId → timestamp Unix
_state_put_dedup_lock = threading.Lock()


def _state_put_check_dedup(op_id: str) -> bool:
    """Retourne True si l'opId a déjà été traité dans la fenêtre de 5 min."""
    if not op_id:
        return False
    now = int(time.time())
    with _state_put_dedup_lock:
        expired = [k for k, t in _state_put_dedup.items() if now - t >= 300]
        for k in expired:
            del _state_put_dedup[k]
        if op_id in _state_put_dedup:
            return True
        _state_put_dedup[op_id] = now
        return False


# ---------------------------------------------------------------------------
# Reauth tokens — protège les opérations destructrices (reset, purge)
# TTL 3 minutes, lié à la session courante, consommé une seule fois.
# ---------------------------------------------------------------------------

_reauth_tokens: dict[str, dict[str, Any]] = {}
_reauth_lock = threading.Lock()


def create_reauth_token(username: str, session_token: str) -> str:
    tok = secrets.token_urlsafe(32)
    with _reauth_lock:
        _reauth_tokens[tok] = {
            "username": username,
            "sessionToken": session_token,
            "expiresAt": int(time.time()) + 180,  # 3 minutes
        }
    return tok


def consume_reauth_token(token: str, session_token: str) -> bool:
    with _reauth_lock:
        data = _reauth_tokens.pop(token, None)
    if not data:
        return False
    if data["expiresAt"] < time.time():
        return False
    try:
        return hmac.compare_digest(data["sessionToken"], session_token)
    except (TypeError, ValueError):
        return data["sessionToken"] == session_token


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
    "supplierPrices": [],
    "casiers": [],
    "casierMouvements": [],
    "creditRecoveries": [],
    "consignes": [],
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
        "stockEntree": 100,
        "stockLoss": 100,
        "auditEntry": 0,
        "casier": 1,
        "casierMouvement": 1,
        "consigne": 0,
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
    dual_zone_pricing: bool = True,
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
        "dualZonePricing": dual_zone_pricing,
        "stockAlertInclusiveSeuil": False,
        "reapproTargetMultiplier": 2,
    }


def site_uses_dual_zone_pricing(site: dict[str, Any] | None) -> bool:
    """False = tarif unique (prix catalogue intérieur partout). Defaut historique True."""
    if not site:
        return True
    return site.get("dualZonePricing") is not False


def _qr_order_total_fcfa(order: dict[str, Any]) -> float:
    return sum(float(line.get("prix") or 0) * float(line.get("qty") or 0) for line in order.get("lignes") or [])


def _qr_order_alert_message(site: dict[str, Any], order: dict[str, Any]) -> str:
    nom = str(site.get("nom") or "Maquis")
    tid = order.get("id")
    tbl = str(order.get("table") or "")
    cli = str(order.get("client") or "")
    nlines = len(order.get("lignes") or [])
    total_int = int(round(_qr_order_total_fcfa(order)))
    total_txt = f"{total_int:,}".replace(",", " ")
    return f"[QR] {nom} — Cmd #{tid} Table {tbl} Client {cli} — {nlines} ligne(s), {total_txt} FCFA"


def _normalize_international_phone(raw: str) -> str:
    s = "".join(str(raw).split())
    if not s:
        return ""
    if s.startswith("+") or not s.replace("+", "").isdigit():
        return s if s.startswith("+") else ""
    digits = "+" + s.replace("+", "")
    return digits


def _alert_phone_for_qr_orders(site: dict[str, Any]) -> str:
    a = _normalize_international_phone(str(site.get("smsQrAlert") or "").strip())
    b = _normalize_international_phone(os.environ.get("GESTION_CAVE_QR_ALERT_SMS_TO", "").strip())
    return a or b


def _post_qr_alert_webhook(url: str, site: dict[str, Any], order: dict[str, Any], body: str, alert_phone: str) -> None:
    payload = {
        "event": "qr_order",
        "siteId": site.get("id"),
        "siteName": site.get("nom"),
        "orderId": order.get("id"),
        "table": order.get("table"),
        "client": order.get("client"),
        "message": body,
        "alertPhone": alert_phone or None,
        "totalFcfa": _qr_order_total_fcfa(order),
    }
    data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    req = Request(url, data=data, method="POST", headers={"Content-Type": "application/json; charset=utf-8"})
    urlopen(req, timeout=18)  # nosec - URL from operator-controlled env


def _twilio_send_sms(to_e164: str, body: str) -> None:
    sid = os.environ.get("TWILIO_ACCOUNT_SID", "").strip()
    token = os.environ.get("TWILIO_AUTH_TOKEN", "").strip()
    frm = os.environ.get("TWILIO_FROM_NUMBER", "").strip()
    if not (sid and token and frm):
        return
    to_clean = _normalize_international_phone(to_e164.strip())
    if not to_clean:
        raise ValueError("Numero destinataire SMS invalide (utilisez le format international +225…).")
    auth_b64 = base64.b64encode(f"{sid}:{token}".encode("utf-8")).decode("ascii")
    encoded = urlencode({"To": to_clean, "From": frm, "Body": body[:1500]}).encode("utf-8")
    req = Request(
        f"https://api.twilio.com/2010-04-01/Accounts/{sid}/Messages.json",
        data=encoded,
        method="POST",
        headers={
            "Authorization": f"Basic {auth_b64}",
            "Content-Type": "application/x-www-form-urlencoded",
        },
    )
    urlopen(req, timeout=18)  # nosec — Twilio HTTPS


# --- WhatsApp Cloud API (Meta) ---

def _whatsapp_send(to_e164: str, body: str, *, force_text: bool = False) -> None:
    phone_id = os.environ.get("WHATSAPP_PHONE_NUMBER_ID", "").strip()
    token = os.environ.get("WHATSAPP_ACCESS_TOKEN", "").strip()
    if not phone_id:
        print("[WA] SKIPPED: WHATSAPP_PHONE_NUMBER_ID not defined", flush=True)
        audit_log("wa_not_configured", {"reason": "no_phone_id"})
        return False
    if not token:
        print("[WA] SKIPPED: WHATSAPP_ACCESS_TOKEN not defined", flush=True)
        audit_log("wa_not_configured", {"reason": "no_access_token"})
        return False
    to_clean = _normalize_international_phone(to_e164.strip())
    if not to_clean:
        raise ValueError("Numéro WhatsApp invalide (format international +225…).")
    template_name = os.environ.get("WHATSAPP_TEMPLATE_NAME", "").strip()
    if template_name and not force_text:
        lang = os.environ.get("WHATSAPP_TEMPLATE_LANG", "fr").strip() or "fr"
        wa_payload: dict[str, Any] = {
            "messaging_product": "whatsapp",
            "to": to_clean,
            "type": "template",
            "template": {
                "name": template_name,
                "language": {"code": lang},
                "components": [{"type": "body", "parameters": [{"type": "text", "text": body[:1024]}]}],
            },
        }
    else:
        wa_payload = {
            "messaging_product": "whatsapp",
            "to": to_clean,
            "type": "text",
            "text": {"body": body[:4096]},
        }
    data = json.dumps(wa_payload, ensure_ascii=False).encode("utf-8")
    req = Request(
        f"https://graph.facebook.com/v17.0/{phone_id}/messages",
        data=data,
        method="POST",
        headers={
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/json; charset=utf-8",
        },
    )
    try:
        resp = urlopen(req, timeout=18)  # nosec — Meta HTTPS
        status = getattr(resp, 'status', None) or getattr(resp, 'getcode', lambda: None)()
        print(f"[WA] OK envoye a {to_clean} (HTTP {status})", flush=True)
        audit_log("wa_sent", {"to": to_clean, "http_status": status})
        return True
    except HTTPError as e:
        body_err = e.read().decode("utf-8", errors="replace")
        print(f"[WA] ERREUR HTTP {e.code} pour {to_clean}: {body_err}", flush=True)
        audit_log("wa_send_error", {"to": to_clean, "http_code": e.code, "body": body_err})
        return False
    except URLError as e:
        print(f"[WA] ERREUR RESEAU pour {to_clean}: {e}", flush=True)
        audit_log("wa_send_error", {"to": to_clean, "error": str(e)})
        return False
    except OSError as e:
        print(f"[WA] ERREUR systeme pour {to_clean}: {e}", flush=True)
        audit_log("wa_send_error", {"to": to_clean, "error": str(e)})
        return False


def _wa_phones_for_site(site: dict[str, Any], event: str) -> list[str]:
    events_enabled = site.get("waEvents") or []
    if isinstance(events_enabled, list) and event not in events_enabled:
        return []
    raw = str(site.get("waNotifyPhones") or "").strip()
    if not raw:
        return []
    phones: list[str] = []
    for part in raw.replace(";", ",").split(","):
        p = _normalize_international_phone(part.strip())
        if p:
            phones.append(p)
    return phones


def _whatsapp_notify_event_async(site: dict[str, Any], event: str, message: str) -> None:
    phones = _wa_phones_for_site(site, event)
    if not phones:
        return
    site_id = site.get("id", "?")

    def run() -> None:
        for phone in phones:
            try:
                _whatsapp_send(phone, message)
            except (OSError, HTTPError, URLError, ValueError) as ex:
                audit_log("wa_notify_failed", {"error": str(ex), "siteId": site_id, "event": event, "to": phone})

    threading.Thread(target=run, daemon=True).start()


def _wa_stock_check_message(site: dict[str, Any], check: dict[str, Any], event: str) -> str:
    nom = str(site.get("nom") or site.get("name") or site.get("id") or "Maquis")
    date_str = str(check.get("date") or "")[:10]
    by = str(check.get("managerConfirmedBy") or check.get("closedBy") or "")
    ca = int(check.get("caEncaisse") or 0)
    nb = int(check.get("nbVentes") or 0)
    ca_str = f"{ca:,}".replace(",", " ")
    if event == "fin_service":
        return f"[PDJ] {nom} — Fin de service {date_str} (par {by})\nCA encaissé : {ca_str} FCFA · {nb} vente(s)"
    if event == "cloture_journee":
        return f"[PDJ] {nom} — Clôture du {date_str} (par {by})\nCA encaissé : {ca_str} FCFA · {nb} vente(s)"
    return f"[PDJ] {nom} — Événement {event} le {date_str}"


def _wa_phone_for_user(username: str, auth_users: list[dict[str, Any]]) -> str:
    un = str(username or "").strip().lower()
    for u in auth_users:
        if not isinstance(u, dict):
            continue
        if str(u.get("username", "")).strip().lower() == un:
            return _normalize_international_phone(str(u.get("waPhone") or "").strip())
    return ""


def _wa_phones_for_shift_serveuses(
    site_id: str, date_iso: str, auth_users: list[dict[str, Any]], work_shifts: list[dict[str, Any]]
) -> list[str]:
    """Numéros WhatsApp des utilisateurs planifiés sur ce maquis ce jour."""
    d = str(date_iso or "")[:10]
    phones: list[str] = []
    seen: set[str] = set()
    for shift in work_shifts:
        if not isinstance(shift, dict):
            continue
        if str(shift.get("siteId", "")).strip() != site_id:
            continue
        if str(shift.get("date", ""))[:10] != d:
            continue
        un = str(shift.get("username", "")).strip().lower()
        if not un or un in seen:
            continue
        seen.add(un)
        p = _wa_phone_for_user(un, auth_users)
        if p:
            phones.append(p)
    return phones


def _wa_phones_for_managers_of_site(site_id: str, auth_users: list[dict[str, Any]]) -> list[str]:
    """Numéros WhatsApp des gérants/admins ayant accès à ce maquis."""
    phones: list[str] = []
    for u in auth_users:
        if not isinstance(u, dict):
            continue
        if str(u.get("role", "")).strip().lower() not in ("manager", "admin", "superadmin"):
            continue
        if site_id not in (u.get("allowedSiteIds") or []):
            continue
        p = _normalize_international_phone(str(u.get("waPhone") or "").strip())
        if p:
            phones.append(p)
    return phones


def _wa_user_phones_for_event(
    event: str,
    site_id: str,
    auth_users: list[dict[str, Any]],
    work_shifts: list[dict[str, Any]],
    date_iso: str = "",
    submitted_by: str = "",
) -> list[str]:
    """
    Retourne les numéros WhatsApp des utilisateurs concernés par l'événement.
    - commande_qr  : serveuses en service + gérants du maquis
    - fin_service  : gérants du maquis
    - cloture_journee : gérants + serveuse qui a soumis (si submitted_by renseigné)
    - alerte_stock : gérants du maquis
    """
    phones: list[str] = []
    seen: set[str] = set()

    def add(p: str) -> None:
        if p and p not in seen:
            seen.add(p)
            phones.append(p)

    if event == "commande_qr":
        d = date_iso or time.strftime("%Y-%m-%d", time.gmtime())
        for p in _wa_phones_for_shift_serveuses(site_id, d, auth_users, work_shifts):
            add(p)
        for p in _wa_phones_for_managers_of_site(site_id, auth_users):
            add(p)
    elif event in ("fin_service", "alerte_stock"):
        for p in _wa_phones_for_managers_of_site(site_id, auth_users):
            add(p)
    elif event == "cloture_journee":
        for p in _wa_phones_for_managers_of_site(site_id, auth_users):
            add(p)
        if submitted_by:
            add(_wa_phone_for_user(submitted_by, auth_users))

    return phones


def _wa_upload_media(pdf_bytes: bytes, filename: str) -> str:
    """Upload un PDF vers l'API media WhatsApp Cloud. Retourne le media_id."""
    phone_id = os.environ.get("WHATSAPP_PHONE_NUMBER_ID", "").strip()
    token = os.environ.get("WHATSAPP_ACCESS_TOKEN", "").strip()
    if not (phone_id and token):
        raise ValueError("WHATSAPP_PHONE_NUMBER_ID ou WHATSAPP_ACCESS_TOKEN non configures.")
    boundary = f"----WaBoundary{secrets.token_hex(12)}"
    parts: list[bytes] = [
        f"--{boundary}\r\nContent-Disposition: form-data; name=\"messaging_product\"\r\n\r\nwhatsapp".encode(),
        f"--{boundary}\r\nContent-Disposition: form-data; name=\"type\"\r\n\r\napplication/pdf".encode(),
        (
            f"--{boundary}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"{filename}\"\r\n"
            f"Content-Type: application/pdf\r\n\r\n"
        ).encode() + pdf_bytes,
        f"--{boundary}--".encode(),
    ]
    body = b"\r\n".join(parts)
    req = Request(
        f"https://graph.facebook.com/v17.0/{phone_id}/media",
        data=body,
        method="POST",
        headers={
            "Authorization": f"Bearer {token}",
            "Content-Type": f"multipart/form-data; boundary={boundary}",
        },
    )
    with urlopen(req, timeout=60) as resp:  # nosec — Meta HTTPS
        result = json.loads(resp.read().decode("utf-8"))
    return str(result["id"])


def _wa_send_document(to_e164: str, media_id: str, caption: str, filename: str) -> None:
    phone_id = os.environ.get("WHATSAPP_PHONE_NUMBER_ID", "").strip()
    token = os.environ.get("WHATSAPP_ACCESS_TOKEN", "").strip()
    if not (phone_id and token):
        return
    to_clean = _normalize_international_phone(to_e164.strip())
    if not to_clean:
        return
    data = json.dumps({
        "messaging_product": "whatsapp",
        "to": to_clean,
        "type": "document",
        "document": {"id": media_id, "caption": caption[:1024], "filename": filename},
    }, ensure_ascii=False).encode("utf-8")
    req = Request(
        f"https://graph.facebook.com/v17.0/{phone_id}/messages",
        data=data,
        method="POST",
        headers={
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/json; charset=utf-8",
        },
    )
    urlopen(req, timeout=18)  # nosec — Meta HTTPS


def _safe_pdf_str(text: str, maxlen: int = 80) -> str:
    """Retourne une chaine compatible cp1252 (police PDF core) tronquee a maxlen."""
    out = text[:maxlen]
    return out.encode("cp1252", errors="replace").decode("cp1252")


def _generate_cloture_pdf(
    site: dict[str, Any],
    check: dict[str, Any],
    ventes: list[dict[str, Any]],
    stock_rows: list[dict[str, Any]],
) -> bytes:
    if not _FPDF_AVAILABLE:
        raise RuntimeError("fpdf2 non installe (pip install fpdf2).")

    site_id = str(site.get("id", ""))
    nom = _safe_pdf_str(str(site.get("nom") or site.get("name") or site_id))
    date_str = str(check.get("date") or "")[:10]
    try:
        y_p, m_p, d_p = date_str.split("-")
        date_fmt = f"{d_p}/{m_p}/{y_p}"
    except ValueError:
        date_fmt = date_str

    closed_by = _safe_pdf_str(str(check.get("managerConfirmedBy") or check.get("closedBy") or ""))
    role_raw = str(check.get("closedByRole") or "").lower()
    role_labels = {"serveuse": "Serveuse", "manager": "Gérant", "admin": "Admin", "superadmin": "Super Admin"}
    closed_by_role = role_labels.get(role_raw, role_raw)
    created_at = str(check.get("managerConfirmedAt") or check.get("createdAt") or "")
    heure = created_at[11:16] if len(created_at) > 15 else ""

    nb_ventes = int(check.get("nbVentes") or 0)
    ca_encaisse = int(check.get("caEncaisse") or 0)
    ca_creances = int(check.get("caCreances") or 0)
    totaux_jour: dict[str, Any] = check.get("totauxJour") or {}
    opening_cash = int(check.get("openingCashFcfa") or 0)
    closing_cash = int(check.get("closingCashFcfa") or 0)
    ecart_cash = int(check.get("cashEcartEspeces") or 0)
    no_sales_reason = _safe_pdf_str(str(check.get("noSalesReason") or ""))

    # Détail articles vendus ce jour
    site_ventes = [v for v in ventes if str(v.get("siteId", "")) == site_id and str(v.get("date", ""))[:10] == date_str]
    article_totals: dict[str, dict[str, int]] = {}
    for v in site_ventes:
        article = _safe_pdf_str(str(v.get("article") or "—"), 50)
        qty = max(1, int(v.get("qty") or 1))
        prix = int(v.get("prix") or 0)
        remise = int(v.get("remise") or 0)
        net = prix * qty - remise
        if article not in article_totals:
            article_totals[article] = {"qty": 0, "total": 0}
        article_totals[article]["qty"] += qty
        article_totals[article]["total"] += net

    # Alertes stock
    site_stock = [s for s in stock_rows if str(s.get("siteId", "")) == site_id]
    low_items: list[dict[str, Any]] = []
    for item in site_stock:
        total = stock_total(item)
        seuil = max(0, int(item.get("seuilMin") or 0))
        if total == 0 or (seuil > 0 and total <= seuil):
            low_items.append({
                "article": _safe_pdf_str(str(item.get("article") or ""), 45),
                "total": total,
                "seuil": seuil,
                "status": "Rupture" if total == 0 else "Bas",
            })

    def fmt_f(n: int) -> str:
        s = str(abs(n))
        groups: list[str] = []
        while len(s) > 3:
            groups.append(s[-3:])
            s = s[:-3]
        groups.append(s)
        formatted = " ".join(reversed(groups))
        return ("-" if n < 0 else "") + formatted + " FCFA"

    pdf = _FPDF()
    pdf.add_page()
    pdf.set_auto_page_break(auto=True, margin=15)
    pdf.set_margins(15, 15, 15)

    # En-tête
    pdf.set_font("Helvetica", "B", 16)
    pdf.cell(0, 10, "Rapport de Cloture de Journee", new_x="LMARGIN", new_y="NEXT", align="C")
    pdf.set_font("Helvetica", "", 11)
    pdf.cell(0, 7, f"Maquis : {nom}", new_x="LMARGIN", new_y="NEXT", align="C")
    pdf.cell(0, 7, f"Date : {date_fmt}   Heure : {heure}", new_x="LMARGIN", new_y="NEXT", align="C")
    pdf.cell(0, 7, f"Cloture par : {closed_by} ({closed_by_role})", new_x="LMARGIN", new_y="NEXT", align="C")
    pdf.ln(4)
    pdf.set_draw_color(180, 180, 180)
    pdf.line(15, pdf.get_y(), 195, pdf.get_y())
    pdf.ln(5)

    # Résumé des ventes
    pdf.set_font("Helvetica", "B", 13)
    pdf.cell(0, 9, "Resume des ventes", new_x="LMARGIN", new_y="NEXT")
    pdf.set_font("Helvetica", "", 11)
    if nb_ventes == 0 and no_sales_reason:
        pdf.set_text_color(200, 100, 0)
        pdf.multi_cell(0, 7, f"Journee sans vente - Cause : {no_sales_reason}")
        pdf.set_text_color(0, 0, 0)
    else:
        pdf.cell(100, 7, "Nombre de ventes :", border=0)
        pdf.cell(0, 7, str(nb_ventes), new_x="LMARGIN", new_y="NEXT")
        pdf.cell(100, 7, "CA total encaisse :", border=0)
        pdf.set_font("Helvetica", "B", 11)
        pdf.cell(0, 7, fmt_f(ca_encaisse), new_x="LMARGIN", new_y="NEXT")
        pdf.set_font("Helvetica", "", 11)
        if ca_creances:
            pdf.cell(100, 7, "Creances clients en cours :", border=0)
            pdf.cell(0, 7, fmt_f(ca_creances), new_x="LMARGIN", new_y="NEXT")
        if totaux_jour:
            pdf.ln(2)
            pdf.set_font("Helvetica", "B", 11)
            pdf.cell(0, 7, "Modes de paiement :", new_x="LMARGIN", new_y="NEXT")
            pdf.set_font("Helvetica", "", 11)
            for method, amount in totaux_jour.items():
                if amount:
                    m_label = _safe_pdf_str(str(method), 40)
                    pdf.cell(100, 6, f"  {m_label} :", border=0)
                    pdf.cell(0, 6, fmt_f(int(amount)), new_x="LMARGIN", new_y="NEXT")
    pdf.ln(4)

    # Caisse
    pdf.set_font("Helvetica", "B", 13)
    pdf.cell(0, 9, "Caisse", new_x="LMARGIN", new_y="NEXT")
    pdf.set_font("Helvetica", "", 11)
    pdf.cell(100, 7, "Caisse ouverture :", border=0)
    pdf.cell(0, 7, fmt_f(opening_cash), new_x="LMARGIN", new_y="NEXT")
    pdf.cell(100, 7, "Caisse comptee a la cloture :", border=0)
    pdf.cell(0, 7, fmt_f(closing_cash), new_x="LMARGIN", new_y="NEXT")
    pdf.cell(100, 7, "Ecart de caisse :", border=0)
    if ecart_cash < 0:
        pdf.set_text_color(200, 0, 0)
    elif ecart_cash > 0:
        pdf.set_text_color(0, 150, 0)
    pdf.cell(0, 7, fmt_f(ecart_cash), new_x="LMARGIN", new_y="NEXT")
    pdf.set_text_color(0, 0, 0)

    # Détail par article
    if article_totals:
        pdf.ln(4)
        pdf.set_font("Helvetica", "B", 13)
        pdf.cell(0, 9, "Detail par article", new_x="LMARGIN", new_y="NEXT")
        pdf.set_fill_color(220, 220, 220)
        pdf.set_font("Helvetica", "B", 10)
        pdf.cell(95, 7, "Article", border=1, fill=True)
        pdf.cell(30, 7, "Qte", border=1, fill=True, align="C")
        pdf.cell(55, 7, "Total FCFA", border=1, fill=True, align="R")
        pdf.ln()
        pdf.set_font("Helvetica", "", 10)
        for article, data in sorted(article_totals.items()):
            pdf.cell(95, 6, article, border=1)
            pdf.cell(30, 6, str(data["qty"]), border=1, align="C")
            pdf.cell(55, 6, fmt_f(data["total"]).replace(" FCFA", ""), border=1, align="R")
            pdf.ln()

    # Alertes stock
    if low_items:
        pdf.ln(4)
        pdf.set_font("Helvetica", "B", 13)
        pdf.set_text_color(180, 0, 0)
        pdf.cell(0, 9, "Alertes stock", new_x="LMARGIN", new_y="NEXT")
        pdf.set_text_color(0, 0, 0)
        pdf.set_fill_color(255, 220, 220)
        pdf.set_font("Helvetica", "B", 10)
        pdf.cell(95, 7, "Article", border=1, fill=True)
        pdf.cell(30, 7, "Stock", border=1, fill=True, align="C")
        pdf.cell(30, 7, "Seuil", border=1, fill=True, align="C")
        pdf.cell(25, 7, "Statut", border=1, fill=True, align="C")
        pdf.ln()
        pdf.set_font("Helvetica", "", 10)
        for s in low_items:
            pdf.cell(95, 6, s["article"], border=1)
            pdf.cell(30, 6, str(s["total"]), border=1, align="C")
            pdf.cell(30, 6, str(s["seuil"]) if s["seuil"] else "—", border=1, align="C")
            pdf.cell(25, 6, s["status"], border=1, align="C")
            pdf.ln()

    # Pied de page
    pdf.ln(8)
    pdf.set_font("Helvetica", "I", 9)
    pdf.set_text_color(150, 150, 150)
    now_str = time.strftime("%d/%m/%Y a %H:%M", time.gmtime()) + " UTC"
    pdf.cell(0, 5, f"Document genere automatiquement le {now_str}", new_x="LMARGIN", new_y="NEXT", align="C")

    return bytes(pdf.output())


def _format_cloture_text(site: dict[str, Any], check: dict[str, Any], ventes: list[dict[str, Any]], stock_rows: list[dict[str, Any]]) -> str:
    """Formate le rapport de clôture en texte pour WhatsApp."""
    nom = str(site.get("nom") or site.get("id") or "Maquis")
    date_str = str(check.get("date") or "")[:10]
    try:
        y_r, m_r, d_r = date_str.split("-")
        date_label = f"{d_r}/{m_r}/{y_r}"
    except ValueError:
        date_label = date_str
    closed_by = str(check.get("managerConfirmedBy") or check.get("closedBy") or "")
    ca = int(check.get("caEncaisse") or 0)
    nb_ventes = int(check.get("nbVentes") or 0)
    opening = int(check.get("openingCashFcfa") or 0)
    closing = int(check.get("closingCashFcfa") or 0)
    ecart = int(check.get("cashEcartEspeces") or 0)
    site_id = str(site.get("id", ""))
    ventes_jour = [v for v in ventes if isinstance(v, dict) and str(v.get("siteId", "")) == site_id and str(v.get("date", ""))[:10] == date_str]
    totaux: dict[str, int] = {}
    for v in ventes_jour:
        m = str(v.get("paiement") or "Autre")
        prix = int(v.get("prix") or 0)
        remise = int(v.get("remise") or 0)
        totaux[m] = totaux.get(m, 0) + max(0, prix - remise)
    paiements_lines = " | ".join(f"{m}: {t:,} FCFA".replace(",", " ") for m, t in sorted(totaux.items()))
    stock_alerts: list[str] = []
    for item in stock_rows:
        if not isinstance(item, dict) or str(item.get("siteId", "")) != site_id:
            continue
        seuil = int(item.get("seuilMin") or 0)
        total = int(item.get("init") or 0) + int(item.get("entrees") or 0) - int(item.get("sorties") or 0)
        if seuil > 0 and total <= seuil:
            stock_alerts.append(f"  - {item.get('article', '?')}: {total} (seuil {seuil})")
    lines = [
        f"*Rapport de cloture — {nom}*",
        f"Date : {date_label}",
        f"Clos par : {closed_by}",
        "",
        f"CA encaisse : *{ca:,} FCFA*".replace(",", " "),
        f"Nb ventes : {nb_ventes}",
    ]
    if paiements_lines:
        lines.append(f"Paiements : {paiements_lines}")
    lines += [
        "",
        f"Caisse ouverture : {opening:,} FCFA".replace(",", " "),
        f"Caisse denombree : {closing:,} FCFA".replace(",", " "),
        f"Ecart especes : {'+' if ecart >= 0 else ''}{ecart:,} FCFA".replace(",", " "),
    ]
    if stock_alerts:
        lines.append("")
        lines.append(f"Alertes stock ({len(stock_alerts)}) :")
        lines += stock_alerts[:5]
    return "\n".join(lines)


def _send_cloture_report_wa_async(
    site: dict[str, Any],
    check: dict[str, Any],
    auth_users: list[dict[str, Any]],
    ventes: list[dict[str, Any]],
    stock_rows: list[dict[str, Any]],
) -> None:
    """Envoie le rapport de clôture via WhatsApp (message texte, thread daemon)."""
    phone_id = os.environ.get("WHATSAPP_PHONE_NUMBER_ID", "").strip()
    token = os.environ.get("WHATSAPP_ACCESS_TOKEN", "").strip()
    if not phone_id:
        print("[WA RAPPORT] ERREUR : WHATSAPP_PHONE_NUMBER_ID non defini.", flush=True)
        return
    if not token:
        print("[WA RAPPORT] ERREUR : WHATSAPP_ACCESS_TOKEN non defini.", flush=True)
        return

    site_id = str(site.get("id", ""))
    submitted_by = str(check.get("closedBy") or "")
    phones: list[str] = []
    seen: set[str] = set()

    def add_p(p: str) -> None:
        if p and p not in seen:
            seen.add(p)
            phones.append(p)

    for p in _wa_phones_for_site(site, "cloture_journee"):
        add_p(p)
    for p in _wa_user_phones_for_event("cloture_journee", site_id, auth_users, [], submitted_by=submitted_by):
        add_p(p)

    if not phones:
        return

    _ventes = list(ventes)
    _stock = list(stock_rows)
    _site = dict(site)
    _check = dict(check)

    def run() -> None:
        print(f"[WA RAPPORT] Envoi rapport texte site={site_id} destinataires={phones}", flush=True)
        try:
            msg = _format_cloture_text(_site, _check, _ventes, _stock)
        except Exception as ex:
            print(f"[WA RAPPORT] ERREUR formatage: {ex}", flush=True)
            audit_log("wa_cloture_format_failed", {"error": str(ex), "siteId": site_id})
            return
        for phone in phones:
            try:
                _whatsapp_send(phone, msg)
                print(f"[WA RAPPORT] Rapport envoye a {phone}", flush=True)
            except (OSError, HTTPError, URLError, ValueError) as ex:
                print(f"[WA RAPPORT] ERREUR envoi a {phone}: {ex}", flush=True)
                audit_log("wa_cloture_rapport_failed", {"error": str(ex), "siteId": site_id, "to": phone})

    threading.Thread(target=run, daemon=True).start()


def _trigger_stockcheck_wa_notifications(
    new_checks: list[dict[str, Any]],
    old_snap: dict[str, dict[str, Any]],
    sites_by_id: dict[str, dict[str, Any]],
    auth_users: list[dict[str, Any]] | None = None,
    ventes: list[dict[str, Any]] | None = None,
    stock_rows: list[dict[str, Any]] | None = None,
) -> None:
    _auth = auth_users or []
    _ventes = ventes or []
    _stock = stock_rows or []
    print(f"[WA TRIGGER] Verification {len(new_checks)} stockChecks, snap={len(old_snap)} entrees", flush=True)
    for check in new_checks:
        if not isinstance(check, dict):
            continue
        cid = str(check.get("id", ""))
        if not cid:
            continue
        site_id = str(check.get("siteId", ""))
        site = sites_by_id.get(site_id)
        if not site:
            print(f"[WA TRIGGER] check {cid}: site '{site_id}' introuvable dans sites_by_id={list(sites_by_id.keys())}", flush=True)
            continue
        old = old_snap.get(cid)
        role = str(check.get("closedByRole") or "").strip().lower()
        msg_event = ""
        submitted_by = ""
        if old is None:
            if role == "serveuse":
                msg_event = "fin_service"
                submitted_by = str(check.get("closedBy") or "")
            elif role in ("manager", "admin", "superadmin"):
                msg_event = "cloture_journee"
            else:
                print(f"[WA TRIGGER] check {cid} NOUVEAU mais role='{role}' non reconnu → pas de notif", flush=True)
        else:
            # Gérant confirme la fin de service de la serveuse
            if not old.get("managerConfirmedAt") and check.get("managerConfirmedAt"):
                msg_event = "cloture_journee"
                submitted_by = str(check.get("closedBy") or "")
            else:
                print(f"[WA TRIGGER] check {cid} EXISTANT role={role} managerConfirmedAt={bool(check.get('managerConfirmedAt'))} → pas de changement detecte", flush=True)
        if not msg_event:
            continue
        print(f"[WA TRIGGER] check {cid} → event={msg_event} site={site_id}", flush=True)
        msg = _wa_stock_check_message(site, check, msg_event)
        # Site-level broadcast (message texte)
        _whatsapp_notify_event_async(site, msg_event, msg)
        # Par utilisateur (gérants + serveuse concernée selon l'événement)
        if _auth:
            user_phones = _wa_user_phones_for_event(msg_event, site_id, _auth, [], submitted_by=submitted_by)
            site_phones = set(_wa_phones_for_site(site, msg_event))
            for p in user_phones:
                if p not in site_phones:
                    try:
                        threading.Thread(target=_whatsapp_send, args=(p, msg), daemon=True).start()
                    except Exception:
                        pass
        # Rapport PDF de clôture
        if msg_event == "cloture_journee":
            _send_cloture_report_wa_async(site, check, _auth, _ventes, _stock)


def _trigger_stock_alert_wa_notifications(
    new_stock: list[dict[str, Any]],
    old_snap: dict[tuple[str, str], int],
    sites_by_id: dict[str, dict[str, Any]],
    auth_users: list[dict[str, Any]] | None = None,
) -> None:
    by_site: dict[str, list[str]] = {}
    for item in new_stock:
        if not isinstance(item, dict):
            continue
        site_id = str(item.get("siteId", ""))
        article = str(item.get("article") or "").strip()
        if not site_id or not article:
            continue
        key = (site_id, article.lower())
        new_total = stock_total(item)
        old_total = old_snap.get(key)
        seuil = max(0, int(item.get("seuilMin") or 0))
        was_ok = old_total is None or old_total > max(seuil, 0)
        now_low = seuil > 0 and new_total <= seuil
        was_not_zero = old_total is None or old_total > 0
        now_zero = new_total == 0
        if (now_low and was_ok) or (now_zero and was_not_zero):
            if site_id not in by_site:
                by_site[site_id] = []
            status = "rupture" if now_zero else f"bas (seuil : {seuil})"
            by_site[site_id].append(f"{article} — stock {new_total}, {status}")
    _auth = auth_users or []
    for site_id, alerts in by_site.items():
        site = sites_by_id.get(site_id)
        if not site:
            continue
        nom = str(site.get("nom") or site.get("name") or site_id)
        msg = f"[Stock] {nom} — Alerte niveau bas :\n" + "\n".join(f"• {a}" for a in alerts)
        _whatsapp_notify_event_async(site, "alerte_stock", msg)
        if _auth:
            site_phones = set(_wa_phones_for_site(site, "alerte_stock"))
            for p in _wa_user_phones_for_event("alerte_stock", site_id, _auth, []):
                if p not in site_phones:
                    try:
                        threading.Thread(target=_whatsapp_send, args=(p, msg), daemon=True).start()
                    except Exception:
                        pass


def notify_qr_order_created_async(
    site: dict[str, Any],
    order: dict[str, Any],
    auth_users: list[dict[str, Any]] | None = None,
    work_shifts: list[dict[str, Any]] | None = None,
) -> None:
    """Alertes SMS / webhook / WhatsApp après commande cliente (QR). Ne bloque pas l'HTTP : thread daemon."""
    _auth_users = auth_users or []
    _work_shifts = work_shifts or []

    def run() -> None:
        site_id = str(site.get("id", ""))
        alert_phone = _alert_phone_for_qr_orders(site)
        msg = _qr_order_alert_message(site, order)
        webhook_url = os.environ.get("GESTION_CAVE_QR_ALERT_WEBHOOK", "").strip()
        if webhook_url:
            try:
                _post_qr_alert_webhook(webhook_url, site, order, msg, alert_phone)
            except (OSError, HTTPError, URLError, ValueError) as ex:
                audit_log("qr_order_webhook_alert_failed", {"error": str(ex), "siteId": site_id, "orderId": order.get("id")})

        twilio_sid = os.environ.get("TWILIO_ACCOUNT_SID", "").strip()
        if twilio_sid and alert_phone:
            try:
                _twilio_send_sms(alert_phone, msg)
            except (OSError, HTTPError, URLError, ValueError) as ex:
                audit_log("qr_order_twilio_sms_failed", {"error": str(ex), "siteId": site_id, "orderId": order.get("id")})

        # WhatsApp — combine numéros site-level (waNotifyPhones) + par utilisateur (serveuses en service + gérants)
        _wa_seen: set[str] = set()
        _wa_targets: list[str] = []
        for p in _wa_phones_for_site(site, "commande_qr"):
            if p not in _wa_seen:
                _wa_seen.add(p)
                _wa_targets.append(p)
        for p in _wa_user_phones_for_event("commande_qr", site_id, _auth_users, _work_shifts):
            if p not in _wa_seen:
                _wa_seen.add(p)
                _wa_targets.append(p)
        for _wa_phone in _wa_targets:
            try:
                _whatsapp_send(_wa_phone, msg)
            except (OSError, HTTPError, URLError, ValueError) as ex:
                audit_log("wa_qr_order_failed", {"error": str(ex), "siteId": site_id, "orderId": order.get("id"), "to": _wa_phone})

    threading.Thread(target=run, daemon=True).start()


def build_default_state() -> dict[str, Any]:
    legacy = json.loads(json.dumps(DEFAULT_STATE))
    return {
        "auth": {
            "users": [
                {"username": "admin", "passwordHash": hash_password("admin123"), "role": "superadmin", "allowedSiteIds": ["maquis-1", "maquis-2"]},
                {"username": "tanoh", "passwordHash": hash_password("tanoh123"), "role": "superadmin", "allowedSiteIds": ["maquis-1", "maquis-2"]},
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
        "pdjWorkDateBySite": {},
        "purchaseOrders": [],
        "supplierPrices": [],
        "casiers": [],
        "casierMouvements": [],
        "creditRecoveries": [],
        "consignes": [],
        "categories": legacy.get("categories", DEFAULT_STATE["categories"]),
        "charges": [
            {**item, "siteId": item.get("siteId", "maquis-1")} for item in legacy["charges"]
        ],
        "staffAuditLog": [],
        "workShifts": [],
        "stockEntrees": [],
        "stockLosses": [],
        "nextId": {
            **legacy["nextId"],
            "site": 3,
            "invoice": 1,
            "purchaseOrder": legacy.get("nextId", {}).get("purchaseOrder", 100),
            "stockEntree": legacy.get("nextId", {}).get("stockEntree", 100),
            "stockLoss": legacy.get("nextId", {}).get("stockLoss", 100),
            "auditEntry": legacy.get("nextId", {}).get("auditEntry", 0),
            "casier": legacy.get("nextId", {}).get("casier", 1),
            "casierMouvement": legacy.get("nextId", {}).get("casierMouvement", 1),
            "consigne": legacy.get("nextId", {}).get("consigne", 0),
            "workShift": legacy.get("nextId", {}).get("workShift", 100),
        },
    }


def migrate_state(payload: dict[str, Any]) -> dict[str, Any]:
    default = build_default_state()
    meta = payload.setdefault("_meta", {})
    schema_version = int(meta.get("schemaVersion") or 1)
    if schema_version < 2:
        for user in payload.get("auth", {}).get("users", []):
            if str(user.get("role", "")) == "admin":
                user["role"] = "superadmin"
        if not any(str(u.get("role", "")) == "superadmin" for u in payload.get("auth", {}).get("users", [])):
            all_ids = [s["id"] for s in payload.get("sites", []) if s.get("id")]
            for user in payload.get("auth", {}).get("users", []):
                if str(user.get("role", "")) == "manager":
                    user["role"] = "superadmin"
                    if all_ids:
                        user["allowedSiteIds"] = list(all_ids)
                    break
        meta["schemaVersion"] = 2

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
            "consignes": [{**item, "siteId": item.get("siteId", site_id)} for item in payload.get("consignes", [])],
            "categories": payload.get("categories", default["categories"]),
            "charges": [{**item, "siteId": item.get("siteId", site_id)} for item in payload.get("charges", default["charges"])],
            "dayBooks": [{**item, "siteId": item.get("siteId", site_id)} for item in payload.get("dayBooks", [])],
            "purchaseOrders": [{**item, "siteId": item.get("siteId", site_id)} for item in payload.get("purchaseOrders", [])],
            "supplierPrices": [{**item, "siteId": item.get("siteId", site_id)} for item in payload.get("supplierPrices", [])],
            "casiers": [{**item, "siteId": item.get("siteId", site_id)} for item in payload.get("casiers", [])],
            "casierMouvements": [{**item, "siteId": item.get("siteId", site_id)} for item in payload.get("casierMouvements", [])],
            "staffAuditLog": payload.get("staffAuditLog", []),
            "stockEntrees": [{**item, "siteId": item.get("siteId", site_id)} for item in payload.get("stockEntrees", [])],
            "stockLosses": [{**item, "siteId": item.get("siteId", site_id)} for item in payload.get("stockLosses", [])],
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

    if not isinstance(payload.get("workShifts"), list):
        payload["workShifts"] = []
    nxt = payload.setdefault("nextId", {})
    if nxt.get("workShift") is None:
        nxt["workShift"] = 100

    return payload


VALID_USER_ROLES = ("superadmin", "admin", "manager", "serveuse")

# Listes filtrees par maquis (siteId). Les lignes sans siteId ne sont pas supprimees lors d'une purge (donnees ambiguës anciennes migrations).
_SITE_SCOPED_ROW_KEYS: tuple[str, ...] = (
    "ventes",
    "stock",
    "commandes",
    "stockChecks",
    "stockEntrees",
    "stockLosses",
    "dayBooks",
    "purchaseOrders",
    "supplierPrices",
    "casiers",
    "casierMouvements",
    "creditRecoveries",
    "consignes",
    "charges",
    "staffAuditLog",
    "workShifts",
)


def _valid_work_date(s: str) -> bool:
    return bool(re.fullmatch(r"\d{4}-\d{2}-\d{2}", str(s or "").strip()))


def _valid_work_time(s: str) -> bool:
    return bool(re.fullmatch(r"\d{2}:\d{2}", str(s or "").strip()))


def filter_work_shifts_for_session(
    rows: list[Any],
    session: dict[str, Any],
    site_ids: list[str],
    allowed: set[str],
) -> list[Any]:
    """Serveuse : uniquement ses créneaux. Gérant / admin : équipe des maquis autorisés."""
    role = str(session.get("role", "")).strip().lower()
    un_key = str(session.get("username", "")).strip().casefold()
    out: list[Any] = []
    for r in rows or []:
        if not isinstance(r, dict):
            continue
        es = row_effective_site_id(r, site_ids, allowed)
        if es is None or es not in allowed:
            continue
        if role == "serveuse":
            if str(r.get("username", "")).strip().casefold() != un_key:
                continue
        out.append(r)
    return json.loads(json.dumps(out))


def session_can_manage_team_schedule(session: dict[str, Any] | None) -> bool:
    if not session:
        return False
    role = str(session.get("role", "")).strip().lower()
    if role in ("superadmin", "admin", "manager"):
        return True
    return str(session.get("username", "")).strip().lower() in ("admin", "tanoh")


def validate_work_shift_row(
    row: dict[str, Any],
    session: dict[str, Any],
    auth_users: list[dict[str, Any]],
    site_ids: list[str],
    allowed: set[str],
) -> None:
    sid = str(row.get("siteId", "")).strip()
    if sid not in allowed or sid not in site_ids:
        raise ValueError(f"Maquis non autorise pour ce creneau (siteId={sid or '?'}).")
    un = str(row.get("username", "")).strip()
    if not un:
        raise ValueError("Utilisateur obligatoire pour le creneau.")
    user = next(
        (u for u in auth_users if str(u.get("username", "")).strip().casefold() == un.casefold()),
        None,
    )
    if not user:
        raise ValueError(f"Utilisateur inconnu pour le planning : « {un} ».")
    u_role = str(user.get("role", "")).strip().lower()
    if u_role not in ("serveuse", "manager"):
        raise ValueError(f"Seules les serveuses et gerantes peuvent etre planifiees (compte « {un} » : {u_role}).")
    u_sites = {str(x) for x in (user.get("allowedSiteIds") or []) if str(x) in site_ids}
    if sid not in u_sites:
        raise ValueError(f"« {un} » n'est pas affecté au maquis {sid}. Cochez ce maquis dans Paramètres → Accès.")
    sess_role = str(session.get("role", "")).strip().lower()
    if sess_role == "manager" and u_role not in ("serveuse", "manager"):
        raise ValueError("Modification non autorisee.")
    if not _valid_work_date(str(row.get("date", ""))):
        raise ValueError("Date invalide (AAAA-MM-JJ).")
    if not _valid_work_time(str(row.get("startTime", ""))) or not _valid_work_time(str(row.get("endTime", ""))):
        raise ValueError("Heures invalides (HH:MM).")


def merge_work_shifts_scoped(
    current: list[Any],
    incoming: list[Any],
    session: dict[str, Any],
    allowed: set[str],
    site_ids: list[str],
    auth_users: list[dict[str, Any]],
    *,
    snapshot: bool = False,
) -> list[Any]:
    if not session_can_manage_team_schedule(session):
        raise ValueError("Modification du planning non autorisee.")
    if not isinstance(incoming, list):
        raise ValueError("Liste de creneaux invalide.")
    # Identifie les IDs deja presents dans le perimetre courant (re-envoi sans modification).
    def _in_scope(r: Any) -> bool:
        if not isinstance(r, dict):
            return False
        es = row_effective_site_id(r, site_ids, allowed)
        return es is not None and es in allowed
    existing_ids = {str(r.get("id")) for r in (current or []) if isinstance(r, dict) and r.get("id") is not None and _in_scope(r)}
    for row in incoming:
        if isinstance(row, dict):
            row_id = str(row.get("id", ""))
            if row_id not in existing_ids:
                validate_work_shift_row(row, session, auth_users, site_ids, allowed)
            else:
                sid = str(row.get("siteId", "")).strip()
                if sid not in allowed or sid not in {str(x) for x in site_ids}:
                    raise ValueError("Maquis non autorise pour ce creneau.")
                if not str(row.get("username", "")).strip():
                    raise ValueError("Utilisateur obligatoire pour le creneau.")
    return merge_work_shifts_rows(current, incoming, allowed, site_ids, snapshot=snapshot)


def merge_work_shifts_rows(
    current: list[Any],
    incoming: list[Any],
    allowed: set[str],
    site_ids: list[str],
    *,
    snapshot: bool = False,
) -> list[dict[str, Any]]:
    """Fusion planning : upsert par defaut ; snapshot = remplacement dans le perimetre autorise."""
    if snapshot:
        current_list = [r for r in (current or []) if isinstance(r, dict) and r.get("id") is not None]
        incoming_list = [r for r in (incoming or []) if isinstance(r, dict) and r.get("id") is not None]

        def in_allowed_scope(row: dict[str, Any]) -> bool:
            es = row_effective_site_id(row, site_ids, allowed)
            return es is not None and es in allowed

        incoming_for_scope = [r for r in incoming_list if in_allowed_scope(r)]
        kept = [r for r in current_list if not in_allowed_scope(r)]
        kept.extend(incoming_for_scope)
        return kept
    by_id: dict[str, dict[str, Any]] = {}
    for r in current or []:
        if isinstance(r, dict) and r.get("id") is not None:
            by_id[str(r["id"])] = r
    for row in incoming or []:
        if isinstance(row, dict) and row.get("id") is not None:
            by_id[str(row["id"])] = row
    return list(by_id.values())


def _zero_stock_row_quantities(row: dict[str, Any]) -> None:
    """Conserve ligne catalogue stock ; positions et historique mouvemente a zero."""
    row["init"] = 0
    row["entrees"] = 0
    row["sorties"] = 0
    row["frigo"] = 0
    row["reserve"] = 0
    row.pop("lastReapproAt", None)
    row.pop("lastReapproBy", None)


def _safe_backup_filename(name_raw: str) -> str:
    name = Path(name_raw).name.strip()
    if not name or "/" in name or "\\" in name or ".." in name:
        raise ValueError("Nom de fichier invalide.")
    resolved_dir = BACKUP_DIR.resolve()
    target = (BACKUP_DIR / name).resolve()
    if target.parent != resolved_dir:
        raise ValueError("Chemin refuse.")
    return name


def load_backup_state_payload(backup_filename: str) -> dict[str, Any]:
    """Charge et migre un etat complet depuis backups/ (snapshot JSON ou copie SQLite)."""
    name = _safe_backup_filename(backup_filename)
    path = BACKUP_DIR / name
    if not path.is_file():
        raise ValueError("Fichier de sauvegarde introuvable.")
    if re.fullmatch(r"data-\d{8}-\d{6}(-manuel)?\.json", name) or name.endswith(".json"):
        return migrate_state(json.loads(path.read_text(encoding="utf-8")))
    if re.fullmatch(r"app-\d{8}-\d{6}(-manuel)?\.sqlite3", name):
        conn = sqlite3.connect(str(path))
        try:
            row = conn.execute("SELECT v FROM kv WHERE k = ?", ("state",)).fetchone()
        finally:
            conn.close()
        if not row or not row[0]:
            raise ValueError("Sauvegarde SQLite sans etat.")
        return migrate_state(json.loads(row[0]))
    raise ValueError("Formats acceptes : fichier .json ou app-AAAAMMJJ-HHMMSS.sqlite3 (ou -manuel).")


def compute_global_superadmin(
    username: str,
    role: str,
    allowed_site_ids: list[str] | None,
    all_site_ids: list[str] | None,
) -> bool:
    """Compte « racine » : admin / tanoh, ou superadmin couvrant tous les maquis connus."""
    un = str(username or "").strip().lower()
    if un in ("admin", "tanoh"):
        return True
    if str(role or "") != "superadmin":
        return False
    if not all_site_ids:
        return True
    a_set = {str(x) for x in all_site_ids if x is not None and str(x)}
    if not a_set:
        return True
    u_set = {str(x) for x in (allowed_site_ids or []) if str(x) in a_set}
    return a_set.issubset(u_set)


def session_is_superadmin(session: dict[str, Any] | None, *, all_site_ids: list[str] | None = None) -> bool:
    """Superadmin global : acces multi-maquis complet (sauvegardes, liste des sites, PUT etat non scope)."""
    if session is None:
        return True
    if session.get("globalSuperadmin") is True:
        return True
    if session.get("globalSuperadmin") is False:
        return False
    if all_site_ids is not None:
        return compute_global_superadmin(
            str(session.get("username", "")),
            str(session.get("role", "")),
            list(session.get("allowedSiteIds") or []),
            all_site_ids,
        )
    un = str(session.get("username", "")).strip().lower()
    if un in ("admin", "tanoh"):
        return True
    return str(session.get("role", "")) == "superadmin"


def session_allowed_sites(session: dict[str, Any], site_ids: list[str]) -> set[str]:
    sid_set = set(site_ids)
    return {str(s) for s in (session.get("allowedSiteIds") or []) if str(s) in sid_set}


def session_can_manage_maquis_backups(
    session: dict[str, Any] | None,
    *,
    all_site_ids: list[str] | None = None,
) -> bool:
    """Superadmin global ou admin / superadmin scopé sur au moins un maquis."""
    if not session:
        return False
    un = str(session.get("username", "")).strip().lower()
    if un in ("admin", "tanoh"):
        return True
    if session_is_superadmin(session, all_site_ids=all_site_ids):
        return True
    role = str(session.get("role", "")).strip().lower()
    if role not in ("superadmin", "admin", "manager"):
        return False
    if all_site_ids is not None:
        return bool(session_allowed_sites(session, all_site_ids))
    return bool(session.get("allowedSiteIds"))


def resolve_backup_session(session: dict[str, Any], store: "StateStore") -> dict[str, Any]:
    """Réaligne rôle et maquis autorisés depuis auth.users (cookie de session parfois obsolète)."""
    out = dict(session)
    un = str(session.get("username", "")).strip()
    if not un:
        return out
    with store._lock:
        all_ids = [str(s["id"]) for s in store._state.get("sites", []) if s.get("id")]
        un_key = un.casefold()
        user = next(
            (
                u
                for u in store._state.get("auth", {}).get("users", [])
                if str(u.get("username", "")).strip().casefold() == un_key
            ),
            None,
        )
    if not user:
        return out
    role = str(user.get("role", out.get("role", "")))
    if un.lower() == "admin":
        role = "superadmin"
        allowed = list(all_ids)
    elif role == "superadmin":
        allowed = [
            str(sid)
            for sid in user.get("allowedSiteIds", all_ids)
            if str(sid) in all_ids
        ] or (all_ids[:1] if all_ids else [])
    else:
        allowed = [
            str(sid)
            for sid in user.get("allowedSiteIds", all_ids)
            if str(sid) in all_ids
        ] or (all_ids[:1] if all_ids else [])
    out["role"] = role
    out["allowedSiteIds"] = allowed
    out["globalSuperadmin"] = compute_global_superadmin(un, role, allowed, all_ids)
    return out


def session_site_id_allowed_for_backup(
    session: dict[str, Any],
    site_id: str,
    all_site_ids: list[str],
) -> bool:
    sid = str(site_id or "").strip()
    if not sid or sid not in {str(x) for x in all_site_ids if x}:
        return False
    un = str(session.get("username", "")).strip().lower()
    if un in ("admin", "tanoh"):
        return True
    if session_is_superadmin(session, all_site_ids=all_site_ids):
        return True
    return sid in session_allowed_sites(session, all_site_ids)


def site_backup_filename_matches_site(filename: str, site_id: str) -> bool:
    """True si le fichier site-…-{id}-….json correspond au maquis donné."""
    name = str(filename or "").lower()
    if not name.startswith("site-"):
        return False
    safe_sid = re.sub(r"[^a-zA-Z0-9_-]", "_", str(site_id or "").strip())
    if not safe_sid:
        return False
    return f"-{safe_sid}-" in name


def row_effective_site_id(row: dict[str, Any], site_ids: list[str], allowed: set[str]) -> str | None:
    site_set = {str(x) for x in site_ids}
    raw = row.get("siteId")
    sid_s = str(raw) if raw is not None and raw != "" else ""
    if sid_s in site_set:
        return sid_s
    if (raw is None or raw == "") and len(allowed) == 1:
        return next(iter(allowed))
    return None


def _order_status_finalized(status: Any) -> bool:
    s = str(status or "").strip().lower()
    return s in ("paye", "payé", "annule", "annulé")


def _order_payment_fingerprint(order: dict[str, Any]) -> str:
    client = str(order.get("client") or "").strip().lower()
    table = str(order.get("table") or order.get("client") or "").strip().lower()
    day = str(order.get("date") or "")[:10]
    lines = sorted(
        f"{str(l.get('article', '')).strip()}|{int(l.get('qty') or 0)}|{float(l.get('prix') or 0)}"
        for l in (order.get("lignes") or [])
        if isinstance(l, dict)
    )
    return f"{day}|{client}|{table}|{';'.join(lines)}"


def _order_create_fingerprint(order: dict[str, Any]) -> str:
    crid = str(order.get("clientRequestId") or "").strip()
    if crid:
        return f"crid|{crid}"
    mode = str(order.get("saisieMode") or order.get("source") or "").strip().lower()
    srv = str(order.get("server") or order.get("serveur") or "").strip().lower()
    return f"{_order_payment_fingerprint(order)}|{mode}|{srv}"


def _stock_check_manager_confirmed(check: dict[str, Any]) -> bool:
    if check.get("managerConfirmedAt"):
        return True
    role = str(check.get("closedByRole") or "").strip().lower()
    if not role:
        return True
    return role != "serveuse"


def sanitize_stock_checks_for_session(
    incoming: list[Any],
    session: dict[str, Any],
) -> list[Any]:
    """Serveuse : clôture sans validation gérante ; pas de confirmation usurpée."""
    role = str(session.get("role", "")).strip().lower()
    un = str(session.get("username", "")).strip()
    out: list[Any] = []
    for row in incoming or []:
        if not isinstance(row, dict):
            continue
        sc = json.loads(json.dumps(row))
        if role == "serveuse":
            sc["closedBy"] = un
            sc["closedByRole"] = "serveuse"
            sc.pop("managerConfirmedAt", None)
            sc.pop("managerConfirmedBy", None)
        elif role in ("manager", "admin", "superadmin") and sc.get("date"):
            if not sc.get("managerConfirmedAt") and _stock_check_manager_confirmed(sc):
                sc["managerConfirmedAt"] = sc.get("createdAt") or time.strftime(
                    "%Y-%m-%dT%H:%M:%SZ", time.gmtime()
                )
                sc["managerConfirmedBy"] = sc.get("managerConfirmedBy") or un
        out.append(sc)
    return out


def validate_serveuse_pdj_payload(session: dict[str, Any], payload: dict[str, Any]) -> None:
    role = str(session.get("role", "")).strip().lower()
    if role != "serveuse":
        return
    if "pdjWorkDateBySite" in payload:
        payload.pop("pdjWorkDateBySite", None)  # ignorer silencieusement pour les serveuses
    if "dayBooks" in payload:
        # Retirer silencieusement les dayBooks avec openingCashRecorded pour les serveuses
        # (le gérant a déjà enregistré l'ouverture ; la serveuse ne peut pas la modifier)
        filtered = [b for b in (payload.get("dayBooks") or []) if not (isinstance(b, dict) and b.get("openingCashRecorded") is True)]
        if filtered:
            payload["dayBooks"] = filtered
        else:
            payload.pop("dayBooks", None)


def dedupe_commandes_list(
    commandes: list[Any],
    ventes: list[Any] | None = None,
) -> list[dict[str, Any]]:
    """Supprime doublons id ou empreinte sur commandes actives (reseau / double PUT)."""
    rows = [r for r in (commandes or []) if isinstance(r, dict) and r.get("id") is not None]
    if not rows:
        return []

    finalized_ids: set[int] = set()
    for v in ventes or []:
        if not isinstance(v, dict):
            continue
        sid = v.get("sourceOrderId")
        if sid is None or sid == "":
            continue
        try:
            finalized_ids.add(int(sid))
        except (TypeError, ValueError):
            continue

    by_id: dict[int, dict[str, Any]] = {}
    for o in rows:
        try:
            oid = int(o["id"])
        except (TypeError, ValueError):
            continue
        prev = by_id.get(oid)
        if not prev or str(o.get("createdAt") or o.get("date") or "") >= str(
            prev.get("createdAt") or prev.get("date") or ""
        ):
            by_id[oid] = o
    list_unique = list(by_id.values())

    def is_active(o: dict[str, Any]) -> bool:
        try:
            oid = int(o.get("id"))
        except (TypeError, ValueError):
            return False
        if oid in finalized_ids:
            return False
        if _order_status_finalized(o.get("status")):
            return False
        return True

    fp_seen: dict[str, int] = {}
    drop: set[int] = set()
    for o in sorted(
        list_unique,
        key=lambda x: str(x.get("createdAt") or x.get("date") or ""),
        reverse=True,
    ):
        if not is_active(o):
            continue
        fp = _order_create_fingerprint(o)
        try:
            oid = int(o["id"])
        except (TypeError, ValueError):
            continue
        if fp in fp_seen:
            drop.add(oid)
        else:
            fp_seen[fp] = oid

    return [o for o in list_unique if int(o["id"]) not in drop]


def merge_commandes_scoped(
    current: list[Any],
    incoming: list[Any],
    allowed: set[str],
    site_ids: list[str],
    ventes: list[Any] | None = None,
) -> list[dict[str, Any]]:
    """Remplace les commandes du perimetre autorise : absentes du payload = retirees (encaissement)."""
    current_list = [r for r in (current or []) if isinstance(r, dict) and r.get("id") is not None]
    incoming_list = [r for r in (incoming or []) if isinstance(r, dict) and r.get("id") is not None]

    def in_allowed_scope(row: dict[str, Any]) -> bool:
        es = row_effective_site_id(row, site_ids, allowed)
        return es is not None and es in allowed

    incoming_for_scope = [r for r in incoming_list if in_allowed_scope(r)]
    kept = [r for r in current_list if not in_allowed_scope(r)]
    kept.extend(incoming_for_scope)
    return dedupe_commandes_list(kept, ventes)


def merge_scoped_rows(
    current: list[dict[str, Any]],
    incoming: list[Any],
    allowed: set[str],
    site_ids: list[str],
) -> list[dict[str, Any]]:
    current_list = [r for r in (current or []) if isinstance(r, dict) and r.get("id") is not None]
    incoming_list = [r for r in (incoming or []) if isinstance(r, dict) and r.get("id") is not None]

    def row_id_norm(row: dict[str, Any]) -> str:
        return str(row.get("id"))

    def in_allowed_scope(row: dict[str, Any]) -> bool:
        es = row_effective_site_id(row, site_ids, allowed)
        return es is not None and es in allowed

    incoming_for_scope = [r for r in incoming_list if in_allowed_scope(r)]
    incoming_ids = {row_id_norm(r) for r in incoming_for_scope}
    kept: list[dict[str, Any]] = []
    for r in current_list:
        if not in_allowed_scope(r):
            kept.append(r)
            continue
        if row_id_norm(r) in incoming_ids:
            continue
        kept.append(r)
    kept.extend(incoming_for_scope)
    return kept


def merge_next_id_dict(current: dict[str, Any], incoming: dict[str, Any] | None) -> dict[str, Any]:
    out = dict(current or {})
    for key, raw in (incoming or {}).items():
        try:
            out[key] = max(int(out.get(key) or 0), int(raw or 0))
        except (TypeError, ValueError):
            if raw is not None:
                out[key] = raw
    return out


def user_visible_in_public_state(u: dict[str, Any], session: dict[str, Any], all_site_ids: list[str]) -> bool:
    if session_is_superadmin(session, all_site_ids=all_site_ids):
        return True
    if str(u.get("username", "")) == str(session.get("username", "")):
        return True
    all_set = {str(x) for x in all_site_ids}
    if str(u.get("role", "")) == "superadmin":
        u_sites = {str(s) for s in (u.get("allowedSiteIds") or []) if str(s) in all_set}
        if all_set and u_sites >= all_set:
            return session_is_superadmin(session, all_site_ids=all_site_ids)
        sess_sites = {str(s) for s in (session.get("allowedSiteIds") or []) if str(s) in all_set}
        return bool(u_sites & sess_sites)
    user_sites = {str(s) for s in (u.get("allowedSiteIds") or [])}
    sess_sites = {str(s) for s in (session.get("allowedSiteIds") or [])}
    return bool(user_sites & sess_sites)


def merge_auth_users_scoped(
    session: dict[str, Any],
    current_users: list[dict[str, Any]],
    payload_users: list[Any],
    site_ids: list[str],
) -> list[dict[str, Any]]:
    site_set = set(site_ids)
    allowed = session_allowed_sites(session, site_ids)
    if not allowed:
        raise ValueError("Aucun maquis autorise pour cette session.")
    s_user = str(session.get("username", ""))
    s_role = str(session.get("role", ""))

    payload_by: dict[str, dict[str, Any]] = {}
    for raw in payload_users or []:
        if not isinstance(raw, dict):
            continue
        un = str(raw.get("username", "")).strip()
        if un:
            payload_by[un] = raw

    merged: dict[str, dict[str, Any]] = {u["username"]: json.loads(json.dumps(u)) for u in current_users}

    def clamp_sites(raw: Any) -> list[str]:
        xs = [str(x) for x in (raw or []) if str(x) in site_set]
        return xs if xs else sorted(allowed)[:1]

    def may_manage_target(exist: dict[str, Any]) -> bool:
        if str(exist.get("username", "")) == s_user:
            return True
        t_role = str(exist.get("role", ""))
        t_sites = {str(x) for x in (exist.get("allowedSiteIds") or []) if str(x) in site_set}
        if s_role == "admin":
            # L'admin de maquis ne peut gérer que les gérants et serveuses de ses maquis
            if t_role in ("admin", "superadmin"):
                return False
            return bool(t_sites) and t_sites <= allowed
        if s_role == "manager":
            return t_role == "serveuse" and bool(t_sites & allowed)
        if s_role == "superadmin":
            tun = str(exist.get("username", "")).strip().lower()
            if tun in ("admin", "tanoh"):
                return False
            return bool(t_sites & allowed) if t_sites else bool(allowed)
        return False

    for un, pu in payload_by.items():
        exist = merged.get(un)
        new_role = str(pu.get("role", exist.get("role", "serveuse") if exist else "serveuse"))
        if un.strip().lower() == "admin":
            new_role = "superadmin"
        if new_role not in VALID_USER_ROLES:
            continue

        if exist is None:
            if s_role == "admin":
                # Un administrateur de maquis ne peut créer que des gérants et serveuses
                if new_role not in ("manager", "serveuse"):
                    continue
            elif s_role == "manager":
                if new_role != "serveuse":
                    continue
            elif s_role == "superadmin":
                if new_role not in ("superadmin", "admin", "manager", "serveuse"):
                    continue
            else:
                continue
            nu_allowed = clamp_sites(pu.get("allowedSiteIds"))
            if set(nu_allowed) - allowed:
                continue
            pwd = str(pu.get("password", "")).strip()
            nhash = hash_password(pwd) if pwd else hash_password("serveuse123")
            dn_new = str(pu.get("displayName", "") or "").strip()[:120]
            wa_new = _normalize_international_phone(str(pu.get("waPhone") or "").strip())
            new_entry: dict[str, Any] = {
                "username": un,
                "passwordHash": nhash,
                "role": new_role,
                "allowedSiteIds": nu_allowed,
                "twoFactorEnabled": False,
                "wa2faEnabled": bool(pu.get("wa2faEnabled", False)),
                "displayName": dn_new,
            }
            if wa_new:
                new_entry["waPhone"] = wa_new
            merged[un] = new_entry
            continue

        if not may_manage_target(exist):
            continue

        if str(exist.get("username", "")) == s_user:
            if new_role == "superadmin" and str(exist.get("role", "")) != "superadmin" and s_role != "superadmin":
                new_role = str(exist.get("role", ""))
            if s_role != "superadmin" and new_role == "superadmin":
                new_role = str(exist.get("role", ""))
            if s_role == "admin" and new_role not in ("admin", "manager", "serveuse"):
                new_role = str(exist.get("role", ""))
            if s_role == "manager" and new_role not in ("manager", "serveuse"):
                new_role = str(exist.get("role", ""))

        if s_role == "admin" and str(exist.get("username", "")) != s_user:
            # Un admin de maquis ne peut gérer que des gérants et serveuses (pas créer/promouvoir superadmin)
            if new_role not in ("manager", "serveuse"):
                new_role = str(exist.get("role", ""))

        scoped_super = s_role == "superadmin" and not session_is_superadmin(session, all_site_ids=site_ids)
        if scoped_super and str(exist.get("username", "")) != s_user:
            if new_role not in ("superadmin", "admin", "manager", "serveuse"):
                new_role = str(exist.get("role", ""))

        nu_allowed = clamp_sites(pu.get("allowedSiteIds", exist.get("allowedSiteIds")))
        nu_allowed = [x for x in nu_allowed if str(x) in allowed] or sorted(allowed)[:1]

        if s_role == "serveuse":
            new_role = str(exist.get("role", "serveuse"))
            nu_allowed = [str(x) for x in (exist.get("allowedSiteIds") or []) if str(x) in site_set]
            if not nu_allowed:
                nu_allowed = sorted(allowed)[:1]

        pwd = str(pu.get("password", "")).strip()
        password_hash = hash_password(pwd) if pwd else exist["passwordHash"]
        dn = str(pu.get("displayName", exist.get("displayName", "")) or "").strip()[:120]
        wa_upd = _normalize_international_phone(str(pu.get("waPhone", exist.get("waPhone", "")) or "").strip())
        entry: dict[str, Any] = {
            "username": un,
            "passwordHash": password_hash,
            "role": new_role,
            "allowedSiteIds": nu_allowed,
            "twoFactorEnabled": bool(exist.get("twoFactorEnabled", False)),
            "wa2faEnabled": bool(pu.get("wa2faEnabled", exist.get("wa2faEnabled", False))),
            "displayName": dn,
        }
        if wa_upd:
            entry["waPhone"] = wa_upd
        if exist.get("twoFactorSecret"):
            entry["twoFactorSecret"] = exist["twoFactorSecret"]
        if exist.get("twoFactorSecretPending"):
            entry["twoFactorSecretPending"] = exist["twoFactorSecretPending"]
        merged[un] = entry

    result = list(merged.values())
    if not any(str(u.get("role", "")) in ("superadmin", "admin", "manager") for u in result):
        raise ValueError("Au moins un super administrateur, administrateur de maquis ou gerant est obligatoire.")
    return result


def session_state_etag(base_etag: str, session: dict[str, Any], *, all_site_ids: list[str] | None = None) -> str:
    if session_is_superadmin(session, all_site_ids=all_site_ids):
        return base_etag
    raw = f"{session.get('username', '')}|{session.get('role', '')}|{','.join(sorted(str(x) for x in (session.get('allowedSiteIds') or [])))}"
    return f"{base_etag}:{hashlib.sha256(raw.encode('utf-8')).hexdigest()[:14]}"


def session_may_configure_2fa_for_other(
    session: dict[str, Any],
    target_username: str,
    auth_users: list[dict[str, Any]],
    *,
    all_site_ids: list[str] | None = None,
) -> bool:
    if session_is_superadmin(session, all_site_ids=all_site_ids):
        return True
    if str(session.get("username", "")) == str(target_username):
        return True
    tu = next((u for u in auth_users if u.get("username") == target_username), None)
    if session.get("role") == "manager":
        if not tu:
            return False
        tr = str(tu.get("role", "")).strip().lower()
        if tr not in ("serveuse", "serveur"):
            return False
        ts = {str(x) for x in (tu.get("allowedSiteIds") or [])}
        ss = {str(x) for x in (session.get("allowedSiteIds") or [])}
        return bool(ts and ss and ts <= ss)
    if not tu:
        return False
    ts = {str(x) for x in (tu.get("allowedSiteIds") or [])}
    ss = {str(x) for x in (session.get("allowedSiteIds") or [])}
    if not ts or not ss:
        return False
    if str(tu.get("role", "")) == "admin":
        return False
    if str(tu.get("role", "")) == "superadmin":
        tun = str(tu.get("username", "")).strip().lower()
        if tun in ("admin", "tanoh"):
            return False
        return ts <= ss
    if str(session.get("role", "")) == "admin":
        return ts <= ss
    if str(session.get("role", "")) == "superadmin":
        tun = str(tu.get("username", "")).strip().lower()
        if tun in ("admin", "tanoh"):
            return False
        return ts <= ss
    return False


def normalize_auth_users(payload: dict[str, Any]) -> None:
    sites = payload.get("sites", [])
    site_ids = [site.get("id") for site in sites if site.get("id")]
    auth = payload.setdefault("auth", {})
    users = auth.setdefault("users", [])
    for user in users:
        if str(user.get("username", "")).strip().lower() == "admin":
            user["role"] = "superadmin"
            if site_ids:
                user["allowedSiteIds"] = list(site_ids)
    by_lower = {str(u.get("username", "")).strip().lower(): u for u in users}
    if "tanoh" not in by_lower and site_ids:
        users.append(
            {
                "username": "tanoh",
                "passwordHash": hash_password("tanoh123"),
                "role": "superadmin",
                "allowedSiteIds": list(site_ids),
                "twoFactorEnabled": False,
            }
        )
    elif "tanoh" in by_lower:
        tu = by_lower["tanoh"]
        tu["role"] = "superadmin"
        if site_ids:
            tu["allowedSiteIds"] = list(site_ids)


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
    """Sessions avec limite absolue et fenetre d'inactivite (idle)."""

    def __init__(self, *, absolute_seconds: int, idle_seconds: int) -> None:
        self.absolute_seconds = max(300, int(absolute_seconds or SESSION_TTL_SECONDS))
        self.idle_seconds = max(0, int(idle_seconds or 0))
        self._sessions: dict[str, dict[str, Any]] = {}
        self._lock = threading.Lock()

    def create(
        self,
        username: str,
        role: str,
        allowed_site_ids: list[str],
        *,
        global_superadmin: bool = False,
        all_site_ids: list[str] | None = None,
    ) -> str:
        token = secrets.token_urlsafe(32)
        now = int(time.time())
        gs = bool(global_superadmin)
        if not gs and all_site_ids is not None:
            gs = compute_global_superadmin(username, role, list(allowed_site_ids or []), all_site_ids)
        with self._lock:
            self._sessions[token] = {
                "username": username,
                "role": role,
                "allowedSiteIds": list(allowed_site_ids or []),
                "globalSuperadmin": gs,
                "createdAt": now,
                "lastActivityAt": now,
                "csrfToken": secrets.token_urlsafe(24),
            }
        return token

    def _session_public_view(self, sess: dict[str, Any]) -> dict[str, Any]:
        now = int(time.time())
        created = int(sess.get("createdAt") or now)
        last = int(sess.get("lastActivityAt") or now)
        abs_end = created + self.absolute_seconds
        if self.idle_seconds:
            idle_end = last + self.idle_seconds
            deadline = min(abs_end, idle_end)
        else:
            deadline = abs_end
        return {
            "username": sess["username"],
            "role": sess["role"],
            "allowedSiteIds": list(sess.get("allowedSiteIds") or []),
            "globalSuperadmin": bool(sess.get("globalSuperadmin")),
            "csrfToken": str(sess.get("csrfToken") or ""),
            "sessionCreatedAt": created,
            "sessionDeadlineUnix": deadline,
            "sessionAbsoluteSeconds": self.absolute_seconds,
            "sessionIdleSeconds": self.idle_seconds,
        }

    def sync_from_auth_user(self, token: str | None, store: "DataStore") -> None:
        """Réaligne le cookie de session sur auth.users (rôle / maquis autorisés)."""
        if not token:
            return
        with self._lock:
            raw = self._sessions.get(token)
        if not raw:
            return
        bs = resolve_backup_session(raw, store)
        with self._lock:
            raw = self._sessions.get(token)
            if not raw:
                return
            raw["role"] = bs.get("role", raw.get("role"))
            raw["allowedSiteIds"] = list(bs.get("allowedSiteIds") or [])
            raw["globalSuperadmin"] = bool(bs.get("globalSuperadmin"))

    def get(self, token: str | None) -> dict[str, Any] | None:
        if not token:
            return None
        now = int(time.time())
        with self._lock:
            session = self._sessions.get(token)
            if not session:
                return None
            created = int(session.get("createdAt") or now)
            last = int(session.get("lastActivityAt") or now)
            if now >= created + self.absolute_seconds:
                self._sessions.pop(token, None)
                audit_log("session_expired_absolute", {"username": str(session.get("username", ""))})
                return None
            if self.idle_seconds and now - last >= self.idle_seconds:
                self._sessions.pop(token, None)
                audit_log("session_expired_idle", {"username": str(session.get("username", ""))})
                return None
            session["lastActivityAt"] = now
            if not str(session.get("csrfToken") or "").strip():
                session["csrfToken"] = secrets.token_urlsafe(24)
            return self._session_public_view(session)

    def clear(self, token: str | None) -> None:
        if not token:
            return
        with self._lock:
            self._sessions.pop(token, None)

    def invalidate_all_for_username(self, username: str) -> None:
        un = str(username or "").strip().lower()
        if not un:
            return
        with self._lock:
            for tok in list(self._sessions.keys()):
                sess = self._sessions.get(tok)
                if not sess:
                    continue
                if str(sess.get("username", "")).strip().lower() == un:
                    self._sessions.pop(tok, None)
            audit_log("sessions_invalidated", {"username": un, "reason": "explicit"})


class DataStore:
    def __init__(self, path: Path) -> None:
        self.path = path
        self._lock = threading.RLock()
        # Meta defaults (must exist before any _write() during _load()).
        self._rev = 0
        self._updated_at = ""
        self._sqlite_path = SQLITE_FILE
        self._sqlite_enabled = STORAGE_MODE == "sqlite"
        self._pg_enabled = STORAGE_MODE == "postgres"
        # True si PostgreSQL était inaccessible au démarrage → bloque toute écriture
        self._pg_startup_failed = False
        self._state = self._load()
        self._last_etag = self._compute_etag()
        self._rev = int(self._state.get("_meta", {}).get("rev") or self._rev or 1)
        self._updated_at = str(self._state.get("_meta", {}).get("updatedAt") or self._updated_at or "")

    def all_site_ids(self) -> list[str]:
        with self._lock:
            return [str(s.get("id")) for s in self._state.get("sites", []) if s.get("id")]

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

    # ── PostgreSQL ────────────────────────────────────────────────────────────

    def _pg_connect(self):  # type: ignore[return]
        if not _PSYCOPG2_OK:
            raise RuntimeError("psycopg2 non installé. Exécutez : pip install psycopg2-binary")
        if not PG_DSN:
            raise RuntimeError("Variable PG_DSN ou DATABASE_URL requise pour le mode postgres.")
        return psycopg2.connect(PG_DSN)

    def _pg_ensure_tables(self, conn: Any) -> None:
        schema_file = BASE_DIR / "schema.sql"
        if schema_file.exists():
            sql = schema_file.read_text(encoding="utf-8")
        else:
            # Schéma minimal inline si schema.sql absent
            sql = """
CREATE TABLE IF NOT EXISTS app_settings (key TEXT PRIMARY KEY, value JSONB NOT NULL);
CREATE TABLE IF NOT EXISTS sites (id TEXT PRIMARY KEY, data JSONB NOT NULL);
CREATE TABLE IF NOT EXISTS users (username TEXT PRIMARY KEY, data JSONB NOT NULL);
CREATE TABLE IF NOT EXISTS ventes (row_id BIGSERIAL PRIMARY KEY, item_id INTEGER, site_id TEXT, data JSONB NOT NULL);
CREATE TABLE IF NOT EXISTS stock (row_id BIGSERIAL PRIMARY KEY, item_id INTEGER, site_id TEXT, data JSONB NOT NULL);
CREATE TABLE IF NOT EXISTS commandes (row_id BIGSERIAL PRIMARY KEY, item_id INTEGER, site_id TEXT, data JSONB NOT NULL);
CREATE TABLE IF NOT EXISTS stock_checks (row_id BIGSERIAL PRIMARY KEY, site_id TEXT, date_col TEXT, data JSONB NOT NULL);
CREATE TABLE IF NOT EXISTS stock_entrees (row_id BIGSERIAL PRIMARY KEY, item_id INTEGER, site_id TEXT, data JSONB NOT NULL);
CREATE TABLE IF NOT EXISTS stock_losses (row_id BIGSERIAL PRIMARY KEY, item_id INTEGER, site_id TEXT, data JSONB NOT NULL);
CREATE TABLE IF NOT EXISTS day_books (row_id BIGSERIAL PRIMARY KEY, site_id TEXT, date_col TEXT, data JSONB NOT NULL);
CREATE TABLE IF NOT EXISTS purchase_orders (row_id BIGSERIAL PRIMARY KEY, item_id INTEGER, site_id TEXT, data JSONB NOT NULL);
CREATE TABLE IF NOT EXISTS supplier_prices (row_id BIGSERIAL PRIMARY KEY, item_id INTEGER, site_id TEXT, data JSONB NOT NULL);
CREATE TABLE IF NOT EXISTS casiers (row_id BIGSERIAL PRIMARY KEY, item_id INTEGER, site_id TEXT, data JSONB NOT NULL);
CREATE TABLE IF NOT EXISTS casier_mouvements (row_id BIGSERIAL PRIMARY KEY, item_id INTEGER, site_id TEXT, data JSONB NOT NULL);
CREATE TABLE IF NOT EXISTS credit_recoveries (row_id BIGSERIAL PRIMARY KEY, item_id INTEGER, site_id TEXT, data JSONB NOT NULL);
CREATE TABLE IF NOT EXISTS consignes (row_id BIGSERIAL PRIMARY KEY, item_id INTEGER, site_id TEXT, data JSONB NOT NULL);
CREATE TABLE IF NOT EXISTS charges (row_id BIGSERIAL PRIMARY KEY, item_id INTEGER, site_id TEXT, data JSONB NOT NULL);
CREATE TABLE IF NOT EXISTS staff_audit_log (row_id BIGSERIAL PRIMARY KEY, item_id TEXT, site_id TEXT, data JSONB NOT NULL);
CREATE TABLE IF NOT EXISTS work_shifts (row_id BIGSERIAL PRIMARY KEY, item_id TEXT, site_id TEXT, data JSONB NOT NULL);
"""
        with conn.cursor() as cur:
            cur.execute(sql)
        conn.commit()

    def _pg_load(self) -> dict[str, Any]:
        conn = self._pg_connect()
        try:
            self._pg_ensure_tables(conn)
            state: dict[str, Any] = {}
            with conn.cursor() as cur:
                # Paramètres scalaires
                cur.execute("SELECT key, value FROM app_settings")
                for key, value in cur.fetchall():
                    state[key] = value  # psycopg2 désérialise JSONB automatiquement

                # Sites
                cur.execute("SELECT data FROM sites ORDER BY id")
                state["sites"] = [row[0] for row in cur.fetchall()]

                # Utilisateurs
                cur.execute("SELECT data FROM users ORDER BY username")
                state["auth"] = {"users": [row[0] for row in cur.fetchall()]}

                # Listes
                for key, (table, _) in _PG_TABLES.items():
                    cur.execute(f"SELECT data FROM {table} ORDER BY row_id")
                    state[key] = [row[0] for row in cur.fetchall()]

            return state
        finally:
            conn.close()

    def _pg_write(self, payload: dict[str, Any], changed_keys: set | None = None) -> None:
        if self._pg_startup_failed:
            raise RuntimeError(
                "[postgres] ÉCRITURE BLOQUÉE : PostgreSQL était inaccessible au démarrage. "
                "Redémarrez le service une fois PostgreSQL disponible pour éviter toute perte de données."
            )
        conn = self._pg_connect()
        try:
            self._pg_ensure_tables(conn)
            with conn:  # transaction automatique
                with conn.cursor() as cur:
                    # --- Paramètres scalaires ---
                    for k, v in payload.items():
                        if k not in _PG_SKIP_SETTINGS:
                            cur.execute(
                                "INSERT INTO app_settings(key, value) VALUES(%s, %s) "
                                "ON CONFLICT(key) DO UPDATE SET value = EXCLUDED.value",
                                (k, json.dumps(v, ensure_ascii=False)),
                            )

                    # --- Sites ---
                    cur.execute("SELECT id FROM sites")
                    existing_site_ids = {row[0] for row in cur.fetchall()}
                    new_site_ids: set[str] = set()
                    for site in payload.get("sites", []):
                        sid = str(site.get("id", "")).strip()
                        if not sid:
                            continue
                        new_site_ids.add(sid)
                        cur.execute(
                            "INSERT INTO sites(id, data) VALUES(%s, %s) "
                            "ON CONFLICT(id) DO UPDATE SET data = EXCLUDED.data",
                            (sid, json.dumps(site, ensure_ascii=False)),
                        )
                    for sid in existing_site_ids - new_site_ids:
                        cur.execute("DELETE FROM sites WHERE id = %s", (sid,))

                    # --- Utilisateurs ---
                    cur.execute("SELECT username FROM users")
                    existing_users = {row[0] for row in cur.fetchall()}
                    new_users: set[str] = set()
                    for user in payload.get("auth", {}).get("users", []):
                        uname = str(user.get("username", "")).strip()
                        if not uname:
                            continue
                        new_users.add(uname)
                        cur.execute(
                            "INSERT INTO users(username, data) VALUES(%s, %s) "
                            "ON CONFLICT(username) DO UPDATE SET data = EXCLUDED.data",
                            (uname, json.dumps(user, ensure_ascii=False)),
                        )
                    for uname in existing_users - new_users:
                        cur.execute("DELETE FROM users WHERE username = %s", (uname,))

                    # --- Listes : DELETE + INSERT dans la transaction ---
                    # changed_keys fourni = patch partiel : ne traiter que les tables modifiées.
                    for key, (table, id_type) in _PG_TABLES.items():
                        if changed_keys is not None and key not in changed_keys:
                            continue
                        items = payload.get(key, [])
                        cur.execute(f"DELETE FROM {table}")
                        if not items:
                            continue
                        if id_type == "int":
                            seen_int: set = set()
                            rows = []
                            for item in items:
                                k = (item.get("id"), item.get("siteId"))
                                if k in seen_int:
                                    print(f"[postgres] doublon {table} ignoré: id={k[0]} siteId={k[1]}", flush=True)
                                    continue
                                seen_int.add(k)
                                rows.append((item.get("id"), item.get("siteId"), json.dumps(item, ensure_ascii=False)))
                            psycopg2.extras.execute_values(
                                cur,
                                f"INSERT INTO {table}(item_id, site_id, data) VALUES %s",
                                rows,
                            )
                        elif id_type == "text":
                            seen_txt: set = set()
                            rows = []
                            for item in items:
                                k = (str(item.get("id", "")), item.get("siteId"))
                                if k in seen_txt:
                                    print(f"[postgres] doublon {table} ignoré: id={k[0]} siteId={k[1]}", flush=True)
                                    continue
                                seen_txt.add(k)
                                rows.append((str(item.get("id", "")), item.get("siteId"), json.dumps(item, ensure_ascii=False)))
                            psycopg2.extras.execute_values(
                                cur,
                                f"INSERT INTO {table}(item_id, site_id, data) VALUES %s",
                                rows,
                            )
                        elif id_type == "date_site":
                            seen_ds: set = set()
                            rows = []
                            for item in items:
                                k = (item.get("siteId"), str(item.get("date", ""))[:10])
                                if k in seen_ds:
                                    print(f"[postgres] doublon {table} ignoré: siteId={k[0]} date={k[1]}", flush=True)
                                    continue
                                seen_ds.add(k)
                                rows.append((
                                    item.get("siteId"),
                                    str(item.get("date", ""))[:10],
                                    json.dumps(item, ensure_ascii=False),
                                ))
                            psycopg2.extras.execute_values(
                                cur,
                                f"INSERT INTO {table}(site_id, date_col, data) VALUES %s",
                                rows,
                            )
        finally:
            conn.close()

    def _compute_etag(self) -> str:
        if self._sqlite_enabled or self._pg_enabled:
            # Based on logical revision.
            return f'W/"rev-{int(self._rev or 0)}"'
        try:
            stat = self.path.stat()
            # Weak ETag is enough for cache revalidation, cheap to compute.
            return f'W/"{int(stat.st_mtime)}-{stat.st_size}"'
        except OSError:
            return 'W/"0-0"'

    @staticmethod
    def _merge_payload(payload: dict) -> dict:
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
        merged["dayBooks"] = payload.get("dayBooks", merged.get("dayBooks", []))
        merged["purchaseOrders"] = payload.get("purchaseOrders", merged.get("purchaseOrders", []))
        merged["supplierPrices"] = payload.get("supplierPrices", merged.get("supplierPrices", []))
        merged["casiers"] = payload.get("casiers", merged.get("casiers", []))
        merged["casierMouvements"] = payload.get("casierMouvements", merged.get("casierMouvements", []))
        merged["creditRecoveries"] = payload.get("creditRecoveries", merged.get("creditRecoveries", []))
        merged["consignes"] = payload.get("consignes", merged.get("consignes", []))
        merged["staffAuditLog"] = payload.get("staffAuditLog", merged.get("staffAuditLog", []))
        merged["workShifts"] = payload.get("workShifts", merged.get("workShifts", []))
        merged["stockEntrees"] = payload.get("stockEntrees", merged.get("stockEntrees", []))
        merged["stockLosses"] = payload.get("stockLosses", merged.get("stockLosses", []))
        merged["pdjWorkDateBySite"] = payload.get("pdjWorkDateBySite", merged.get("pdjWorkDateBySite", {}))
        for index, site in enumerate(merged["sites"], start=1):
            site.setdefault("prefixeFacture", f"SITE{index}")
            site.setdefault("dualZonePricing", True)
        normalize_auth_users(merged)
        merged["_meta"] = payload.get("_meta") or {"rev": 1, "updatedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())}
        return merged

    def _load(self) -> dict[str, Any]:
        if self._pg_enabled:
            pg_load_ok = True
            try:
                payload = self._pg_load()
            except Exception as exc:
                print(f"[postgres] Échec du chargement ({exc}), état par défaut.", flush=True)
                print("[postgres] PROTECTION : aucune écriture ne sera faite sur PostgreSQL jusqu'au redémarrage.", flush=True)
                payload = {}
                pg_load_ok = False
                self._pg_startup_failed = True
            if payload.get("sites"):
                _payload_before = json.dumps(payload, sort_keys=True, default=str)
                payload = migrate_state(payload)
                _was_migrated = json.dumps(payload, sort_keys=True, default=str) != _payload_before
                merged = self._merge_payload(payload)
                if _was_migrated:
                    print("[startup] Migration détectée → écriture PostgreSQL.", flush=True)
                    self._write(merged)
                return merged
            else:
                initial = build_default_state()
                if pg_load_ok:
                    # Première utilisation : PostgreSQL vide → initialiser normalement
                    self._write(initial)
                # Si pg_load_ok est False, on NE RIEN ÉCRIT en PostgreSQL
                return initial

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
            merged = self._merge_payload(payload)
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
        merged = self._merge_payload(payload)
        self._write(merged)
        return merged

    def _write(self, payload: dict[str, Any], changed_keys: set | None = None) -> None:
        BACKUP_DIR.mkdir(parents=True, exist_ok=True)
        # Update meta
        self._rev = int(self._rev or 0) + 1
        self._updated_at = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
        payload["_meta"] = {"rev": self._rev, "updatedAt": self._updated_at}

        body = json.dumps(payload, ensure_ascii=False, indent=2)

        if self._pg_enabled:
            try:
                self._pg_write(payload, changed_keys=changed_keys)
            except Exception as _pg_exc:
                import traceback as _tb
                print(f"[postgres] ERREUR ECRITURE: {type(_pg_exc).__name__}: {_pg_exc}", flush=True)
                _tb.print_exc()
                raise
            # Sauvegarde JSON automatique (rollback possible)
            try:
                stamp = time.strftime("%Y%m%d-%H%M%S")
                backup_path = BACKUP_DIR / f"data-{stamp}.json"
                backup_path.write_text(body, encoding="utf-8")
                backups = sorted(BACKUP_DIR.glob("data-*.json"), key=lambda p: p.name, reverse=True)
                for old in backups[BACKUP_KEEP_COUNT:]:
                    try:
                        old.unlink()
                    except OSError:
                        pass
            except OSError:
                pass
            self._last_etag = self._compute_etag()
            return

        if self._sqlite_enabled:
            self._sqlite_set("state", body)
            # Lightweight rolling backups (copy the DB file).
            try:
                stamp = time.strftime("%Y%m%d-%H%M%S")
                backup_path = BACKUP_DIR / f"app-{stamp}.sqlite3"
                if self._sqlite_path.exists():
                    backup_path.write_bytes(self._sqlite_path.read_bytes())
                backups = sorted(BACKUP_DIR.glob("app-*.sqlite3"), key=lambda p: p.name, reverse=True)
                for old in backups[BACKUP_KEEP_COUNT:]:
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
            for old in backups[BACKUP_KEEP_COUNT:]:
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
            s = self._state
            return {
                "meta": {**self.meta()},
                "sites": copy.deepcopy(s["sites"]),
                "activeSiteId": s["activeSiteId"],
                "ventes": copy.deepcopy(s["ventes"]),
                "stock": copy.deepcopy(s["stock"]),
                "commandes": copy.deepcopy(s.get("commandes", [])),
                "stockChecks": copy.deepcopy(s.get("stockChecks", [])),
                "stockEntrees": copy.deepcopy(s.get("stockEntrees", [])),
                "stockLosses": copy.deepcopy(s.get("stockLosses", [])),
                "dayBooks": copy.deepcopy(s.get("dayBooks", [])),
                "pdjWorkDateBySite": copy.deepcopy(s.get("pdjWorkDateBySite", {})),
                "purchaseOrders": copy.deepcopy(s.get("purchaseOrders", [])),
                "supplierPrices": copy.deepcopy(s.get("supplierPrices", [])),
                "casiers": copy.deepcopy(s.get("casiers", [])),
                "casierMouvements": copy.deepcopy(s.get("casierMouvements", [])),
                "creditRecoveries": copy.deepcopy(s.get("creditRecoveries", [])),
                "consignes": copy.deepcopy(s.get("consignes", [])),
                "categories": copy.deepcopy(s.get("categories", DEFAULT_STATE["categories"])),
                "charges": copy.deepcopy(s["charges"]),
                "nextId": copy.deepcopy(s["nextId"]),
                "staffAuditLog": copy.deepcopy(s.get("staffAuditLog", [])),
                "workShifts": copy.deepcopy(s.get("workShifts", [])),
                "auth": {
                    "users": [
                        {
                            "username": u["username"],
                            "role": u["role"],
                            "allowedSiteIds": u.get("allowedSiteIds", []),
                            "twoFactorEnabled": bool(u.get("twoFactorEnabled", False)),
                            "displayName": str(u.get("displayName", "") or "").strip()[:120],
                            "waPhone": str(u.get("waPhone") or "").strip(),
                            "wa2faEnabled": bool(u.get("wa2faEnabled", False)),
                        }
                        for u in s["auth"]["users"]
                    ],
                },
            }

    def public_state_for_session(self, session: dict[str, Any]) -> dict[str, Any]:
        with self._lock:
            full = self.public_state()
            site_ids = [str(s["id"]) for s in self._state["sites"] if s.get("id")]
            if session_is_superadmin(session, all_site_ids=site_ids):
                payload = dict(full)
                payload["adminBackups"] = json.loads(json.dumps(self.list_backups()))
                return payload
            allowed = session_allowed_sites(session, site_ids)
            if not allowed and site_ids:
                allowed = {site_ids[0]}
            sites = [s for s in self._state["sites"] if str(s.get("id", "")) in allowed]

            def filter_site_rows(rows: list[Any]) -> list[Any]:
                out = []
                for r in rows or []:
                    if not isinstance(r, dict):
                        continue
                    es = row_effective_site_id(r, site_ids, allowed)
                    if es is not None and es in allowed:
                        out.append(r)
                return json.loads(json.dumps(out))

            aid = str(self._state.get("activeSiteId") or "")
            if aid not in allowed and sites:
                aid = str(sites[0].get("id", ""))
            users_out = [
                {
                    "username": u["username"],
                    "role": u["role"],
                    "allowedSiteIds": u.get("allowedSiteIds", []),
                    "twoFactorEnabled": bool(u.get("twoFactorEnabled", False)),
                    "displayName": str(u.get("displayName", "") or "").strip()[:120],
                    "waPhone": str(u.get("waPhone") or "").strip(),
                    "wa2faEnabled": bool(u.get("wa2faEnabled", False)),
                }
                for u in self._state["auth"]["users"]
                if user_visible_in_public_state(u, session, site_ids)
            ]
            allowed_set = set(allowed)
            pdj_full = self._state.get("pdjWorkDateBySite", {}) or {}
            pdj_filtered = {k: v for k, v in pdj_full.items() if str(k) in allowed_set}

            payload = {
                "meta": full["meta"],
                "sites": json.loads(json.dumps(sites)),
                "activeSiteId": aid,
                "ventes": filter_site_rows(self._state.get("ventes", [])),
                "stock": filter_site_rows(self._state.get("stock", [])),
                "commandes": filter_site_rows(self._state.get("commandes", [])),
                "stockChecks": filter_site_rows(self._state.get("stockChecks", [])),
                "stockEntrees": filter_site_rows(self._state.get("stockEntrees", [])),
                "stockLosses": filter_site_rows(self._state.get("stockLosses", [])),
                "dayBooks": filter_site_rows(self._state.get("dayBooks", [])),
                "pdjWorkDateBySite": json.loads(json.dumps(pdj_filtered)),
                "purchaseOrders": filter_site_rows(self._state.get("purchaseOrders", [])),
                "supplierPrices": filter_site_rows(self._state.get("supplierPrices", [])),
                "casiers": filter_site_rows(self._state.get("casiers", [])),
                "casierMouvements": filter_site_rows(self._state.get("casierMouvements", [])),
                "creditRecoveries": filter_site_rows(self._state.get("creditRecoveries", [])),
                "consignes": filter_site_rows(self._state.get("consignes", [])),
                "categories": full["categories"],
                "charges": filter_site_rows(self._state.get("charges", [])),
                "nextId": full["nextId"],
                "staffAuditLog": filter_site_rows(self._state.get("staffAuditLog", [])),
                "workShifts": filter_work_shifts_for_session(
                    self._state.get("workShifts", []),
                    session,
                    site_ids,
                    allowed,
                ),
                "auth": {"users": users_out},
            }
            bs = resolve_backup_session(session, self)
            if session_can_manage_maquis_backups(bs, all_site_ids=site_ids):
                if session_is_superadmin(bs, all_site_ids=site_ids):
                    payload["adminBackups"] = json.loads(json.dumps(self.list_backups()))
                else:
                    payload["adminBackups"] = json.loads(json.dumps(self.list_backups_for_session(bs)))
            return payload

    def changes(
        self,
        *,
        since: str,
        site_id: str | None = None,
        session: dict[str, Any] | None = None,
        limit: int = 500,
        offset: int = 0,
    ) -> dict[str, Any]:
        """Return incremental changes since an ISO timestamp (UTC)."""
        limit = max(1, min(int(limit), 2000))
        offset = max(0, int(offset))
        with self._lock:
            since_raw = str(since or "").strip()
            if not since_raw:
                since_raw = "1970-01-01T00:00:00Z"
            site_ids_all = [str(s["id"]) for s in self._state.get("sites", []) if s.get("id")]
            allowed_sites: set[str] | None = None
            if session is not None and not session_is_superadmin(session, all_site_ids=site_ids_all):
                allowed_sites = session_allowed_sites(session, site_ids_all)
                if not allowed_sites and site_ids_all:
                    allowed_sites = {site_ids_all[0]}
            commandes_all = []
            for order in self._state.get("commandes", []) or []:
                osid = str(order.get("siteId") or "")
                if allowed_sites is not None and osid not in allowed_sites:
                    continue
                if site_id and osid != site_id:
                    continue
                # Focus on QR sourced orders (most frequent changes).
                if order.get("source") != "qr":
                    continue
                updated = str(order.get("updatedAt") or order.get("createdAt") or "")
                if updated and updated > since_raw:
                    commandes_all.append(order)
            total = len(commandes_all)
            commandes = commandes_all[offset: offset + limit]
            pdj_out: dict[str, str] = {}
            if session is not None:
                site_ids = [str(s["id"]) for s in self._state.get("sites", []) if s.get("id")]
                pdj_full = self._state.get("pdjWorkDateBySite", {}) or {}
                if session_is_superadmin(session, all_site_ids=site_ids):
                    pdj_out = json.loads(json.dumps(_sanitize_pdj_work_date_map(pdj_full, site_ids)))
                else:
                    allowed = session_allowed_sites(session, site_ids)
                    if not allowed and site_ids:
                        allowed = {site_ids[0]}
                    allowed_set = set(allowed)
                    raw_sub = {str(k): v for k, v in pdj_full.items() if str(k) in allowed_set}
                    pdj_out = json.loads(json.dumps(_sanitize_pdj_work_date_map(raw_sub, list(allowed_set))))
            # #region agent log
            if session is not None:
                _dbg_session(
                    "changes_pdj",
                    "A",
                    {
                        "username": str(session.get("username", "")),
                        "role": str(session.get("role", "")),
                        "siteId_param": site_id,
                        "pdj_out": pdj_out,
                        "pdj_full_raw": dict(pdj_full) if session is not None else {},
                    },
                )
            # #endregion
            return {
                "meta": self.meta(),
                "since": since_raw,
                "pdjWorkDateBySite": json.loads(json.dumps(pdj_out)),
                "pagination": {"total": total, "limit": limit, "offset": offset},
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
            merged["purchaseOrders"] = payload.get("purchaseOrders", merged.get("purchaseOrders", []))
            merged["supplierPrices"] = payload.get("supplierPrices", merged.get("supplierPrices", []))
            merged["casiers"] = payload.get("casiers", merged.get("casiers", []))
            merged["casierMouvements"] = payload.get("casierMouvements", merged.get("casierMouvements", []))
            merged["creditRecoveries"] = payload.get("creditRecoveries", merged.get("creditRecoveries", []))
            merged["consignes"] = payload.get("consignes", merged.get("consignes", []))
            merged["staffAuditLog"] = payload.get("staffAuditLog", merged.get("staffAuditLog", []))
            merged["stockEntrees"] = payload.get("stockEntrees", merged.get("stockEntrees", []))
            merged["stockLosses"] = payload.get("stockLosses", merged.get("stockLosses", []))
            merged["categories"] = payload.get("categories", merged.get("categories", DEFAULT_STATE["categories"]))
            merged["charges"] = payload.get("charges", merged["charges"])
            for index, site in enumerate(merged["sites"], start=1):
                site.setdefault("prefixeFacture", f"SITE{index}")
                site.setdefault("dualZonePricing", True)
            normalize_auth_users(merged)
            self._state = merged
            self._write(self._state)
            return self.public_state()

    def public_menu(self, site_id: str, location: str = "Intérieur") -> dict[str, Any] | None:
        with self._lock:
            site = next((item for item in self._state["sites"] if item.get("id") == site_id), None)
            if not site:
                return None
            eff_location = location if site_uses_dual_zone_pricing(site) else "Intérieur"
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
                    prix = price_for_format(format_data, eff_location)
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
            return {"site": json.loads(json.dumps(site)), "menu": menu, "location": eff_location}

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
                eff_location = location if site_uses_dual_zone_pricing(site) else "Intérieur"
                prix = price_for_format(selected_format, eff_location)
                if prix <= 0:
                    continue
                lignes.append({
                    "id": self._state["nextId"]["ligneCommande"],
                    "date": time.strftime("%Y-%m-%d"),
                    "article": stock_item.get("article", article),
                    "cat": stock_item.get("cat", "Autres"),
                    "location": eff_location,
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
                existing_order["updatedAt"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
                if note.strip():
                    existing_order["note"] = f"{existing_order.get('note', '')} | {note.strip()}".strip(" |")
                self._write(self._state)
                merged_snap = json.loads(json.dumps(existing_order))
                notify_qr_order_created_async(site, merged_snap, self._state.get("auth", {}).get("users", []), self._state.get("workShifts", []))
                return merged_snap

            order_id = self._state["nextId"]["commande"]
            self._state["nextId"]["commande"] += 1
            order = {
                "id": order_id,
                "siteId": site_id,
                "client": client_label,
                "date": time.strftime("%Y-%m-%d"),
                "createdAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
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
            new_snap = json.loads(json.dumps(order))
            notify_qr_order_created_async(site, new_snap, self._state.get("auth", {}).get("users", []), self._state.get("workShifts", []))
            return new_snap

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
        un_in = str(username or "").strip()
        key_in = un_in.casefold()
        with self._lock:
            all_site_ids = [site["id"] for site in self._state["sites"]]
            for user in self._state["auth"]["users"]:
                stored = str(user.get("username", "")).strip()
                if not stored:
                    continue
                key_stored = stored.casefold()
                try:
                    user_match = hmac.compare_digest(key_stored, key_in)
                except (TypeError, ValueError):
                    user_match = key_stored == key_in
                if not user_match:
                    continue
                if not verify_password(password, user.get("passwordHash", "")):
                    continue
                if password_needs_upgrade(user.get("passwordHash", "")):
                    user["passwordHash"] = hash_password(password)
                    self._write(self._state)
                allowed = [sid for sid in user.get("allowedSiteIds", all_site_ids) if sid in all_site_ids] or all_site_ids[:1]
                role = str(user.get("role", ""))
                if str(user.get("username", "")).strip().lower() == "admin":
                    role = "superadmin"
                    allowed = list(all_site_ids)
                    prev_sites = [str(x) for x in (user.get("allowedSiteIds") or [])]
                    if user.get("role") != "superadmin" or prev_sites != [str(x) for x in all_site_ids]:
                        user["role"] = "superadmin"
                        user["allowedSiteIds"] = list(all_site_ids)
                        self._write(self._state)
                elif role == "superadmin":
                    allowed = [sid for sid in user.get("allowedSiteIds", all_site_ids) if sid in all_site_ids] or all_site_ids[:1]
                elif role == "admin":
                    allowed = [
                        str(sid)
                        for sid in user.get("allowedSiteIds", all_site_ids)
                        if str(sid) in all_site_ids
                    ] or (all_site_ids[:1] if all_site_ids else [])
                gs = compute_global_superadmin(str(user.get("username", "")), role, allowed, all_site_ids)
                return {
                    "username": user["username"],
                    "role": role,
                    "allowedSiteIds": allowed,
                    "globalSuperadmin": gs,
                }
        return None

    def update_state(self, payload: dict[str, Any], session: dict[str, Any]) -> dict[str, Any]:
        with self._lock:
            current = self._state
            site_ids = [site.get("id") for site in current["sites"] if site.get("id")]
            sid_list = [str(s) for s in site_ids]
            is_super = session_is_superadmin(session, all_site_ids=sid_list)

            if is_super:
                if "sites" in payload:
                    current["sites"] = payload["sites"]
                site_ids = [site.get("id") for site in current["sites"] if site.get("id")]
                req_aid = payload.get("activeSiteId", current.get("activeSiteId"))
                if req_aid in site_ids:
                    current["activeSiteId"] = req_aid
                elif current.get("activeSiteId") in site_ids:
                    current["activeSiteId"] = current["activeSiteId"]
                else:
                    current["activeSiteId"] = site_ids[0] if site_ids else None
                if payload.get("activeSiteId") is not None and req_aid not in site_ids and site_ids:
                    audit_log(
                        "active_site_rejected",
                        {"requested": str(req_aid), "username": str(session.get("username", ""))},
                    )
                # Patch partiel : ne remplacer une collection que si elle est dans le payload
                # (évite d'écraser ventes/charges/etc. avec [] quand le client n'envoie que le stock).
                if "workShifts" in payload:
                    if str(session.get("role", "")).strip().lower() == "serveuse":
                        payload.pop("workShifts", None)  # ignorer silencieusement pour les serveuses
                    auth_users_sa = list(current.get("auth", {}).get("users", []))
                    allowed_sa = set(sid_list)
                    ws_snapshot = bool(payload.get("workShiftsScopedSnapshot"))
                    current["workShifts"] = merge_work_shifts_scoped(
                        current.get("workShifts", []),
                        payload["workShifts"],
                        session,
                        allowed_sa,
                        sid_list,
                        auth_users_sa,
                        snapshot=ws_snapshot,
                    )
                    audit_log(
                        "work_shifts_put",
                        {
                            "username": str(session.get("username", "")),
                            "incoming": len(payload.get("workShifts") or []),
                            "stored": len(current.get("workShifts") or []),
                            "snapshot": ws_snapshot,
                        },
                    )
                _GLOBAL_PATCH_KEYS = [
                    "ventes", "stock", "commandes", "stockChecks", "dayBooks",
                    "purchaseOrders", "supplierPrices", "casiers", "casierMouvements",
                    "creditRecoveries", "consignes", "charges", "staffAuditLog",
                    "stockEntrees", "stockLosses",
                ]
                _old_sc_snap_g: dict[str, dict[str, Any]] = (
                    {str(r.get("id", "")): copy.deepcopy(r) for r in (current.get("stockChecks") or []) if isinstance(r, dict) and r.get("id")}
                    if "stockChecks" in payload else {}
                )
                _old_stock_snap_g: dict[tuple[str, str], int] = (
                    {(str(r.get("siteId", "")), str(r.get("article", "")).lower()): stock_total(r) for r in (current.get("stock") or []) if isinstance(r, dict)}
                    if "stock" in payload else {}
                )
                for _key in _GLOBAL_PATCH_KEYS:
                    if _key not in payload:
                        continue
                    if _key == "casiers":
                        sanitized = []
                        for row in (payload["casiers"] or []):
                            if not isinstance(row, dict):
                                continue
                            cap = max(1, int(row.get("capacite") or 24))
                            qte = int(row.get("quantiteActuelle") or 0)
                            row = dict(row)
                            row["quantiteActuelle"] = max(0, min(qte, cap))
                            row["capacite"] = cap
                            sanitized.append(row)
                        current["casiers"] = sanitized
                    else:
                        current[_key] = payload[_key]
                if "pdjWorkDateBySite" in payload:
                    current["pdjWorkDateBySite"] = _sanitize_pdj_work_date_map(
                        payload.get("pdjWorkDateBySite") or {},
                        site_ids,
                    )
                if "categories" in payload:
                    current["categories"] = payload.get("categories", DEFAULT_STATE["categories"])
                if "nextId" in payload:
                    current["nextId"] = merge_next_id_dict(current.get("nextId", {}), payload.get("nextId"))

                auth_payload = payload.get("auth", {})
                users_payload = auth_payload.get("users")
                is_partial_users = bool(auth_payload.get("partial"))
                if isinstance(users_payload, list):
                    existing_by_name = {u["username"]: u for u in current["auth"]["users"]}
                    new_users = []
                    payload_usernames: set[str] = set()
                    for user_data in users_payload:
                        username = str(user_data.get("username", "")).strip()
                        role = str(user_data.get("role", "serveuse"))
                        if username.strip().lower() == "admin":
                            role = "superadmin"
                        if not username or role not in VALID_USER_ROLES:
                            continue
                        payload_usernames.add(username.lower())
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
                        if username.strip().lower() == "admin":
                            allowed = list(site_ids)
                        existing = existing_by_name.get(username, {})
                        dn_sup = str(user_data.get("displayName", existing.get("displayName", "")) or "").strip()[:120]
                        wa_sup = _normalize_international_phone(str(user_data.get("waPhone", existing.get("waPhone", "")) or "").strip())
                        user_entry: dict[str, Any] = {
                            "username": username,
                            "passwordHash": password_hash,
                            "role": role,
                            "allowedSiteIds": allowed,
                            "twoFactorEnabled": existing.get("twoFactorEnabled", False),
                            "wa2faEnabled": bool(user_data.get("wa2faEnabled", existing.get("wa2faEnabled", False))),
                            "displayName": dn_sup,
                        }
                        if wa_sup:
                            user_entry["waPhone"] = wa_sup
                        if existing.get("twoFactorSecret"):
                            user_entry["twoFactorSecret"] = existing["twoFactorSecret"]
                        new_users.append(user_entry)
                    if is_partial_users:
                        # Mise à jour partielle (profil) : conserver les utilisateurs absents du payload
                        for eu in current["auth"]["users"]:
                            eu_un = str(eu.get("username", "")).strip().lower()
                            if eu_un and eu_un not in payload_usernames:
                                new_users.append(eu)
                    if not new_users:
                        raise ValueError("Aucun utilisateur valide.")
                    if not any(u["role"] in ("superadmin", "admin", "manager") for u in new_users):
                        raise ValueError("Au moins un super administrateur, administrateur de maquis ou gerant est obligatoire.")
                    old_snap = {
                        str(u.get("username", "")).strip(): json.loads(json.dumps(u))
                        for u in current["auth"]["users"]
                        if isinstance(u, dict) and str(u.get("username", "")).strip()
                    }
                    invalidate_sessions_on_auth_changes(old_snap, new_users)
                    current["auth"]["users"] = new_users
                if current["activeSiteId"] not in site_ids and site_ids:
                    current["activeSiteId"] = site_ids[0]

                self._write(current, changed_keys=set(payload.keys()))
                _sites_by_id_g = {str(s.get("id", "")): s for s in (current.get("sites") or []) if isinstance(s, dict)}
                _auth_g = current.get("auth", {}).get("users", [])
                if "stockChecks" in payload:
                    _trigger_stockcheck_wa_notifications(current.get("stockChecks") or [], _old_sc_snap_g, _sites_by_id_g, _auth_g, current.get("ventes") or [], current.get("stock") or [])
                if "stock" in payload:
                    _trigger_stock_alert_wa_notifications(current.get("stock") or [], _old_stock_snap_g, _sites_by_id_g, _auth_g)
                return self.public_state()

            allowed = session_allowed_sites(session, sid_list)
            if not allowed:
                raise ValueError("Session sans maquis autorise.")

            validate_serveuse_pdj_payload(session, payload)

            # Restrictions par rôle : supprimer silencieusement les collections non autorisées.
            # - serveuse  : ventes + commandes + dayBooks uniquement
            # - manager/admin : tout sauf sites/auth (gérés séparément)
            # - rôle inconnu  : aucune écriture de collection
            _role_str = str(session.get("role", "")).strip().lower()
            # Encaissement d'une commande (finalizeOrder) met a jour stock + casiers :
            # ces cles doivent etre autorisees en ecriture pour les serveuses.
            _SERVEUSE_WRITE = frozenset({
                "ventes", "commandes", "dayBooks",
                "stock", "casiers", "casierMouvements", "staffAuditLog",
            })
            _MANAGER_WRITE = frozenset({
                "ventes", "stock", "commandes", "stockChecks", "dayBooks",
                "purchaseOrders", "supplierPrices", "casiers", "casierMouvements",
                "creditRecoveries", "consignes", "charges", "staffAuditLog",
                "stockEntrees", "stockLosses", "workShifts",
            })
            if _role_str == "serveuse":
                _role_write_allowed = _SERVEUSE_WRITE
            elif _role_str in ("manager", "admin"):
                _role_write_allowed = _MANAGER_WRITE
            else:
                _role_write_allowed = frozenset()

            # Ne merger une collection que si elle est explicitement presente dans le payload.
            # Si elle est absente (patch partiel), conserver la valeur courante intacte.
            _SCOPED_KEYS = [
                "ventes", "stock", "commandes", "stockChecks", "dayBooks",
                "purchaseOrders", "supplierPrices", "casiers", "casierMouvements",
                "creditRecoveries", "consignes", "charges", "staffAuditLog",
                "stockEntrees", "stockLosses", "workShifts",
            ]
            # Retirer du payload les clés que le rôle ne peut pas écrire
            for _rk in [k for k in list(payload.keys()) if k in _MANAGER_WRITE and k not in _role_write_allowed]:
                payload.pop(_rk, None)
            _old_sc_snap: dict[str, dict[str, Any]] = (
                {str(r.get("id", "")): copy.deepcopy(r) for r in (current.get("stockChecks") or []) if isinstance(r, dict) and r.get("id")}
                if "stockChecks" in payload else {}
            )
            _old_stock_snap: dict[tuple[str, str], int] = (
                {(str(r.get("siteId", "")), str(r.get("article", "")).lower()): stock_total(r) for r in (current.get("stock") or []) if isinstance(r, dict)}
                if "stock" in payload else {}
            )
            if "workShifts" in payload:
                if str(session.get("role", "")).strip().lower() == "serveuse":
                    payload.pop("workShifts", None)  # ignorer silencieusement pour les serveuses
            auth_users = list(current.get("auth", {}).get("users", []))
            ws_snapshot = bool(payload.get("workShiftsScopedSnapshot"))
            for _key in _SCOPED_KEYS:
                if _key in payload:
                    if _key == "workShifts":
                        current[_key] = merge_work_shifts_scoped(
                            current.get(_key, []),
                            payload[_key],
                            session,
                            allowed,
                            sid_list,
                            auth_users,
                            snapshot=ws_snapshot,
                        )
                        audit_log(
                            "work_shifts_put",
                            {
                                "username": str(session.get("username", "")),
                                "incoming": len(payload.get("workShifts") or []),
                                "stored": len(current.get("workShifts") or []),
                                "snapshot": ws_snapshot,
                                "siteId": str(payload.get("activeSiteId") or ""),
                            },
                        )
                    elif _key == "commandes":
                        current[_key] = merge_commandes_scoped(
                            current.get(_key, []),
                            payload[_key],
                            allowed,
                            sid_list,
                            ventes=current.get("ventes", []),
                        )
                    elif _key == "stockChecks":
                        incoming_sc = sanitize_stock_checks_for_session(
                            payload[_key], session
                        )
                        current[_key] = merge_scoped_rows(
                            current.get(_key, []), incoming_sc, allowed, sid_list
                        )
                    else:
                        current[_key] = merge_scoped_rows(
                            current.get(_key, []), payload[_key], allowed, sid_list
                        )

            if "pdjWorkDateBySite" in payload:
                _prev_pdj = dict(current.get("pdjWorkDateBySite") or {})
                current["pdjWorkDateBySite"] = _merge_pdj_work_date_map_session(
                    current.get("pdjWorkDateBySite"),
                    payload.get("pdjWorkDateBySite"),
                    set(allowed),
                    sid_list,
                )
                # #region agent log
                _dbg_session(
                    "put_pdj_merge",
                    "E",
                    {
                        "username": str(session.get("username", "")),
                        "role": str(session.get("role", "")),
                        "prev_keys": list(_prev_pdj.keys()),
                        "new_keys": list((current.get("pdjWorkDateBySite") or {}).keys()),
                        "payload_keys": list((payload.get("pdjWorkDateBySite") or {}).keys())
                        if isinstance(payload.get("pdjWorkDateBySite"), dict)
                        else [],
                    },
                )
                # #endregion

            aid = payload.get("activeSiteId", current.get("activeSiteId"))
            if aid in site_ids and str(aid) in allowed:
                current["activeSiteId"] = aid
            elif str(current.get("activeSiteId", "")) not in allowed:
                current["activeSiteId"] = sorted(allowed)[0]

            # merge_next_id_dict utilise max() : une serveuse peut augmenter nextId
            # mais jamais le diminuer → pas de risque de collision en autorisant tous les rôles
            current["nextId"] = merge_next_id_dict(current.get("nextId", {}), payload.get("nextId"))

            users_payload = payload.get("auth", {}).get("users")
            if isinstance(users_payload, list):
                old_snap = {
                    str(u.get("username", "")).strip(): json.loads(json.dumps(u))
                    for u in current["auth"]["users"]
                    if isinstance(u, dict) and str(u.get("username", "")).strip()
                }
                merged_users = merge_auth_users_scoped(session, current["auth"]["users"], users_payload, sid_list)
                invalidate_sessions_on_auth_changes(old_snap, merged_users)
                current["auth"]["users"] = merged_users

            if current["activeSiteId"] not in site_ids and site_ids:
                current["activeSiteId"] = site_ids[0]

            self._write(current, changed_keys=set(payload.keys()))
            _sites_by_id = {str(s.get("id", "")): s for s in (current.get("sites") or []) if isinstance(s, dict)}
            _auth_u = current.get("auth", {}).get("users", [])
            print(f"[PUT scoped] payload keys={list(payload.keys())[:10]} sites_by_id={list(_sites_by_id.keys())}", flush=True)
            if "stockChecks" in payload:
                print(f"[PUT scoped] stockChecks detecte dans payload → lancement trigger WA", flush=True)
                _trigger_stockcheck_wa_notifications(current.get("stockChecks") or [], _old_sc_snap, _sites_by_id, _auth_u, current.get("ventes") or [], current.get("stock") or [])
            if "stock" in payload:
                _trigger_stock_alert_wa_notifications(current.get("stock") or [], _old_stock_snap, _sites_by_id, _auth_u)
            return self.public_state_for_session(session)

    def reset(self) -> dict[str, Any]:
        with self._lock:
            self._state = build_default_state()
            self._write(self._state)
            return self.public_state()

    def purge_maquis_data(self, site_id: str, *, keep_stock_catalog: bool = False) -> dict[str, Any]:
        """Efface l'historique operationnel lie a un maquis ; conserve la fiche dans ``sites``.

        Si ``keep_stock_catalog`` est True : les lignes ``stock`` de ce maquis sont conservees mais les
        quantites (init, entrees, sorties, frigo, reserve) sont remises a zero.
        """
        sid = str(site_id or "").strip()
        if not sid:
            raise ValueError("Identifiant maquis invalide.")
        with self._lock:
            site_ids = [str(s.get("id")) for s in self._state.get("sites", []) if s.get("id")]
            if sid not in site_ids:
                raise ValueError("Maquis introuvable.")

            def belongs_site(row: Any) -> bool:
                if not isinstance(row, dict):
                    return False
                raw_sid = row.get("siteId")
                if raw_sid is None or raw_sid == "":
                    return False
                return str(raw_sid).strip() == sid

            def keep_row(row: Any) -> bool:
                if not isinstance(row, dict):
                    return True
                raw_sid = row.get("siteId")
                if raw_sid is None or raw_sid == "":
                    return True
                return str(raw_sid).strip() != sid

            for key in _SITE_SCOPED_ROW_KEYS:
                rows = self._state.get(key)
                if not isinstance(rows, list):
                    continue
                if key == "stock" and keep_stock_catalog:
                    new_stock: list[Any] = []
                    for r in rows:
                        if not isinstance(r, dict):
                            new_stock.append(r)
                            continue
                        if not belongs_site(r):
                            new_stock.append(r)
                            continue
                        copy_row = json.loads(json.dumps(r))
                        _zero_stock_row_quantities(copy_row)
                        new_stock.append(copy_row)
                    self._state[key] = new_stock
                elif keep_stock_catalog and key == "supplierPrices":
                    continue
                else:
                    self._state[key] = [r for r in rows if keep_row(r)]

            self._write(self._state)
            return self.public_state()

    def list_backups_for_session(self, session: dict[str, Any]) -> dict[str, Any]:
        full = self.list_backups()
        site_ids = [str(s["id"]) for s in self._state["sites"] if s.get("id")]
        if session_is_superadmin(session, all_site_ids=site_ids):
            return full
        allowed = session_allowed_sites(session, site_ids)
        if not allowed:
            scoped = dict(full)
            scoped["jsonBackups"] = []
            scoped["sqliteBackups"] = []
            scoped["scopedNote"] = (
                "Aucun maquis autorise pour ce compte. Contactez le super administrateur."
            )
            return scoped

        def json_visible(name: str) -> bool:
            low = name.lower()
            if low.startswith("site-"):
                return any(site_backup_filename_matches_site(name, sid) for sid in allowed)
            if low.startswith("data-"):
                return True
            return False

        json_rows = [b for b in (full.get("jsonBackups") or []) if json_visible(str(b.get("name", "")))]
        scoped = dict(full)
        scoped["jsonBackups"] = json_rows
        scoped["sqliteBackups"] = list(full.get("sqliteBackups") or [])
        scoped["scopedNote"] = (
            "Sauvegardes de vos maquis autorises. Les snapshots complets (data-*.json) "
            "ne restaurent que le maquis choisi ci-dessous."
        )
        return scoped

    def list_backups(self) -> dict[str, Any]:
        BACKUP_DIR.mkdir(parents=True, exist_ok=True)
        json_rows: list[dict[str, Any]] = []
        sqlite_rows: list[dict[str, Any]] = []
        for p in sorted(BACKUP_DIR.glob("*.json"), key=lambda x: x.name, reverse=True):
            try:
                st = p.stat()
                json_rows.append({"name": p.name, "size": st.st_size, "mtimeIso": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(st.st_mtime))})
            except OSError:
                continue
        for p in sorted(BACKUP_DIR.glob("app-*.sqlite3"), key=lambda x: x.name, reverse=True):
            try:
                st = p.stat()
                sqlite_rows.append({"name": p.name, "size": st.st_size, "mtimeIso": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(st.st_mtime))})
            except OSError:
                continue
        return {
            "storageMode": "sqlite" if self._sqlite_enabled else ("postgres" if self._pg_enabled else "json"),
            "keepCount": BACKUP_KEEP_COUNT,
            "jsonBackups": json_rows,
            "sqliteBackups": sqlite_rows,
            "autoNote": "Chaque enregistrement sur le serveur cree une copie dans backups/ (nombre limite configurable : MAQUIS_MANAGER_BACKUP_KEEP, ou TDB_BAR_BACKUP_KEEP pour compatibilite).",
        }

    def restore_site_from_backup(self, backup_filename: str, site_id: str) -> dict[str, Any]:
        """Pour un maquis existant : remplace toutes ses donnees listees par celles du snapshot (autres maquis inchanges)."""
        backup = load_backup_state_payload(backup_filename)
        sid = str(site_id or "").strip()
        if not sid:
            raise ValueError("Maquis invalide.")

        def row_site(r: Any) -> str | None:
            if not isinstance(r, dict):
                return None
            v = r.get("siteId")
            if v is None or v == "":
                return None
            return str(v).strip()

        with self._lock:
            current = self._state
            site_ids = [str(s.get("id")) for s in current.get("sites", []) if s.get("id")]
            if sid not in site_ids:
                raise ValueError("Ce maquis n'existe pas dans la base actuelle. Creez-le d'abord dans la liste des sites.")

            for key in _SITE_SCOPED_ROW_KEYS:
                cur_list = list(current.get(key) or [])
                bu_list = list(backup.get(key) or [])
                cur_kept: list[Any] = []
                for r in cur_list:
                    if isinstance(r, dict) and row_site(r) == sid:
                        continue
                    cur_kept.append(r)
                from_bu = [json.loads(json.dumps(r)) for r in bu_list if isinstance(r, dict) and row_site(r) == sid]
                current[key] = cur_kept + from_bu

            bu_sites = backup.get("sites") or []
            bu_site = next((s for s in bu_sites if isinstance(s, dict) and str(s.get("id")) == sid), None)
            if bu_site:
                fresh = json.loads(json.dumps(bu_site))
                new_sites = []
                for s in current["sites"]:
                    if isinstance(s, dict) and str(s.get("id")) == sid:
                        new_sites.append(fresh)
                    else:
                        new_sites.append(s)
                current["sites"] = new_sites

            current["nextId"] = merge_next_id_dict(current.get("nextId") or {}, backup.get("nextId") or {})
            normalize_auth_users(current)
            self._write(current)
            return self.public_state()

    def write_manual_backup(self) -> dict[str, str]:
        """Ecrit une copie supplementaire dans backups/ (suffixe -manuel), sans modifier l'etat courant."""
        BACKUP_DIR.mkdir(parents=True, exist_ok=True)
        manual_keep = 40
        stamp = time.strftime("%Y%m%d-%H%M%S")
        with self._lock:
            if self._sqlite_enabled:
                name = f"app-{stamp}-manuel.sqlite3"
                dest = BACKUP_DIR / name
                if not self._sqlite_path.exists():
                    raise ValueError("Base SQLite introuvable.")
                dest.write_bytes(self._sqlite_path.read_bytes())
            else:
                name = f"data-{stamp}-manuel.json"
                dest = BACKUP_DIR / name
                body = json.dumps(self._state, ensure_ascii=False, indent=2)
                dest.write_text(body, encoding="utf-8")
            # Postgres : même comportement que JSON (sauvegarde état en mémoire)
        self._prune_manual_backups(manual_keep)
        return {"ok": "true", "file": name}

    def write_site_backup(self, site_id: str) -> dict[str, str]:
        """Cree une sauvegarde uniquement pour un maquis dans backups/site-{id}-YYYYMMDD-HHMMSS.json."""
        BACKUP_DIR.mkdir(parents=True, exist_ok=True)
        sid = str(site_id or "").strip()
        if not sid:
            raise ValueError("Maquis invalide.")

        def row_site(r: Any) -> str | None:
            if not isinstance(r, dict):
                return None
            v = r.get("siteId")
            return str(v).strip() if v is not None and v != "" else None

        stamp = time.strftime("%Y%m%d-%H%M%S")
        with self._lock:
            current = self._state
            site_ids = [str(s.get("id")) for s in current.get("sites", []) if s.get("id")]
            if sid not in site_ids:
                raise ValueError("Ce maquis n'existe pas.")
            site_state: dict[str, Any] = {
                "sites": json.loads(json.dumps(current.get("sites", []))),
                "activeSiteId": sid,
                "categories": json.loads(json.dumps(current.get("categories", []))),
                "nextId": json.loads(json.dumps(current.get("nextId", {}))),
            }
            for key in _SITE_SCOPED_ROW_KEYS:
                site_state[key] = [
                    json.loads(json.dumps(r))
                    for r in (current.get(key) or [])
                    if isinstance(r, dict) and row_site(r) == sid
                ]
            site_nom = next((str(s.get("nom", "")) for s in current.get("sites", []) if str(s.get("id")) == sid), "")
            safe_nom = re.sub(r"[^a-zA-Z0-9_-]", "_", site_nom)[:30].strip("_")
            safe_sid = re.sub(r"[^a-zA-Z0-9_-]", "_", sid)
            slug = f"{safe_nom}-{safe_sid}" if safe_nom else safe_sid
            name = f"site-{slug}-{stamp}.json"
            dest = BACKUP_DIR / name
            dest.write_text(json.dumps(site_state, ensure_ascii=False, indent=2), encoding="utf-8")
        # Purger les anciennes sauvegardes de ce maquis (garder 40)
        try:
            safe_sid_clean = re.sub(r"[^a-zA-Z0-9_-]", "_", sid)
            old_files = sorted(BACKUP_DIR.glob(f"site-*-{safe_sid_clean}-*.json"), key=lambda p: p.name, reverse=True)
            for old in old_files[40:]:
                try:
                    old.unlink()
                except OSError:
                    pass
        except OSError:
            pass
        return {"ok": "true", "file": name, "siteId": sid}

    def _prune_manual_backups(self, keep: int) -> None:
        try:
            if self._sqlite_enabled:
                paths = list(BACKUP_DIR.glob("app-*-manuel.sqlite3"))
            else:
                paths = list(BACKUP_DIR.glob("data-*-manuel.json"))
        except OSError:
            return
        try:
            paths.sort(key=lambda p: p.stat().st_mtime, reverse=True)
        except OSError:
            return
        for p in paths[keep:]:
            try:
                p.unlink()
            except OSError:
                pass


store = DataStore(DATA_FILE)
sessions = SessionManager(absolute_seconds=SESSION_ABSOLUTE_SECONDS, idle_seconds=SESSION_IDLE_SECONDS)


def invalidate_sessions_on_auth_changes(
    old_by_username: dict[str, dict[str, Any]],
    new_users: list[dict[str, Any]],
) -> None:
    """Deconnecte les sessions d'un utilisateur si mot de passe, role ou maquis autorises changent."""
    for nu in new_users or []:
        if not isinstance(nu, dict):
            continue
        un = str(nu.get("username", "")).strip()
        if not un:
            continue
        ou = old_by_username.get(un)
        if not ou or not isinstance(ou, dict):
            continue
        sites_old = sorted(str(x) for x in (ou.get("allowedSiteIds") or []))
        sites_new = sorted(str(x) for x in (nu.get("allowedSiteIds") or []))
        if (
            ou.get("passwordHash") != nu.get("passwordHash")
            or str(ou.get("role", "")) != str(nu.get("role", ""))
            or sites_old != sites_new
            or bool(ou.get("twoFactorEnabled")) != bool(nu.get("twoFactorEnabled"))
            or str(ou.get("twoFactorSecret") or "") != str(nu.get("twoFactorSecret") or "")
        ):
            sessions.invalidate_all_for_username(un)
            audit_log("sessions_invalidated", {"username": un, "reason": "auth_or_2fa_change"})


class AppHandler(BaseHTTPRequestHandler):
    server_version = "MaquisManagerServer/1.0"

    def _request_is_https(self) -> bool:
        proto = (self.headers.get("X-Forwarded-Proto") or "").strip().lower()
        if proto == "https":
            return True
        cf_visitor = (self.headers.get("CF-Visitor") or "").strip()
        return '"scheme":"https"' in cf_visitor

    def _cookie_secure(self) -> str:
        return "; Secure" if (cookie_secure_flag() or self._request_is_https()) else ""

    def _send_security_headers(self) -> None:
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "no-referrer")
        self.send_header("X-Frame-Options", "DENY")
        self.send_header("Permissions-Policy", "geolocation=(), microphone=(), camera=()")
        self.send_header(
            "Content-Security-Policy",
            "default-src 'self'; "
            "script-src 'self' 'unsafe-inline' https://cdnjs.cloudflare.com; "
            "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; "
            "font-src 'self' data: https://fonts.gstatic.com; "
            "img-src 'self' data: blob: https://quickchart.io; "
            "connect-src 'self'; "
            "frame-ancestors 'none';",
        )

    def client_ip(self) -> str:
        # If behind cloudflared, try CF-Connecting-IP.
        ip = (self.headers.get("CF-Connecting-IP") or "").strip()
        if ip:
            return ip
        return (self.client_address[0] if self.client_address else "") or "unknown"

    def do_GET(self) -> None:
        parsed = urlparse(self.path)
        query = parse_qs(parsed.query)
        get_path = (parsed.path or "/").rstrip("/") or "/"
        if get_path == "/api/public/menu":
            site_id = str((query.get("siteId") or [""])[0]).strip()
            location = str((query.get("location") or ["Intérieur"])[0]).strip()
            payload = store.public_menu(site_id, location)
            if payload is None:
                self.send_json(HTTPStatus.NOT_FOUND, {"error": "Maquis introuvable."})
                return
            self.send_json(HTTPStatus.OK, payload)
            return
        if get_path == "/api/public/orders":
            site_id = str((query.get("siteId") or [""])[0]).strip()
            table = str((query.get("table") or [""])[0]).strip()
            client = str((query.get("client") or [""])[0]).strip()
            self.send_json(HTTPStatus.OK, store.public_orders(site_id, table, client))
            return
        if get_path == "/api/session":
            session = self.require_session()
            if session is None:
                return
            aids = store.all_site_ids()
            bs = resolve_backup_session(session, store)
            role = str(bs.get("role", session.get("role", "")))
            allowed = list(bs.get("allowedSiteIds") or session.get("allowedSiteIds") or [])
            global_sa = bool(bs.get("globalSuperadmin"))
            self.send_json(
                HTTPStatus.OK,
                {
                    "authenticated": True,
                    "username": session["username"],
                    "role": role,
                    "allowedSiteIds": allowed,
                    "globalSuperadmin": global_sa,
                    "maquisBackupAllowed": session_can_manage_maquis_backups(bs, all_site_ids=aids),
                    **session_timing_fields(session),
                },
            )
            return
        if get_path == "/api/admin/backups":
            session = self.require_session()
            if session is None:
                return
            all_ids = store.all_site_ids()
            bs = resolve_backup_session(session, store)
            if not session_can_manage_maquis_backups(bs, all_site_ids=all_ids):
                self.send_json(HTTPStatus.FORBIDDEN, {"error": "Acces refuse."})
                return
            with store._lock:
                payload = (
                    store.list_backups()
                    if session_is_superadmin(bs, all_site_ids=all_ids)
                    else store.list_backups_for_session(bs)
                )
            self.send_json(HTTPStatus.OK, payload, cache_control="no-store")
            return
        if get_path == "/api/changes":
            session = self.require_session()
            if session is None:
                return
            since = str((query.get("since") or [""])[0]).strip()
            site_id = str((query.get("siteId") or [""])[0]).strip() or None
            try:
                limit = int((query.get("limit") or ["500"])[0])
            except (ValueError, TypeError):
                limit = 500
            try:
                offset = int((query.get("offset") or ["0"])[0])
            except (ValueError, TypeError):
                offset = 0
            if site_id and not session_is_superadmin(session, all_site_ids=store.all_site_ids()) and site_id not in (session.get("allowedSiteIds") or []):
                self.send_json(HTTPStatus.FORBIDDEN, {"error": "Maquis non autorisé pour cette session."})
                return
            self.send_json(HTTPStatus.OK, store.changes(since=since, site_id=site_id, session=session, limit=limit, offset=offset), cache_control="no-store")
            return
        if get_path == "/api/state":
            session = self.require_session()
            if session is None:
                return
            etag = session_state_etag(store.etag(), session, all_site_ids=store.all_site_ids())
            if self.headers.get("If-None-Match") == etag:
                self.send_not_modified(etag)
                return
            self.send_json(HTTPStatus.OK, store.public_state_for_session(session), etag=etag, cache_control="no-store")
            return
        if get_path == "/api/public/order":
            self.send_error(HTTPStatus.METHOD_NOT_ALLOWED)
            return
        self.serve_static(parsed.path)

    def do_POST(self) -> None:
        post_path = (urlparse(self.path).path or "/").rstrip("/") or "/"
        if post_path == "/api/admin/restore-from-json":
            session = self.require_session()
            if session is None:
                return
            if not self.require_csrf(session):
                return
            if not session_is_superadmin(session, all_site_ids=store.all_site_ids()):
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
        if post_path == "/api/admin/restore-site-from-backup":
            session = self.require_session()
            if session is None:
                return
            if not self.require_csrf(session):
                return
            all_ids = store.all_site_ids()
            bs = resolve_backup_session(session, store)
            if not session_can_manage_maquis_backups(bs, all_site_ids=all_ids):
                self.send_json(HTTPStatus.FORBIDDEN, {"error": "Acces refuse."})
                return
            body = self.read_json()
            bf = str((body or {}).get("backupFile", "")).strip()
            site_raw = str((body or {}).get("siteId", "")).strip()
            if not session_site_id_allowed_for_backup(bs, site_raw, all_ids):
                self.send_json(HTTPStatus.FORBIDDEN, {"error": "Maquis non autorise."})
                return
            try:
                restored_site = store.restore_site_from_backup(bf, site_raw)
            except ValueError as error:
                self.send_json(HTTPStatus.BAD_REQUEST, {"error": str(error)})
                return
            audit_log(
                "restore_site_from_backup",
                {"ip": self.client_ip(), "username": session.get("username", ""), "backupFile": bf, "siteId": site_raw},
            )
            self.send_json(HTTPStatus.OK, restored_site, cache_control="no-store")
            return
        if post_path == "/api/admin/create-site-backup":
            session = self.require_session()
            if session is None:
                return
            if not self.require_csrf(session):
                return
            all_ids = store.all_site_ids()
            bs = resolve_backup_session(session, store)
            if not session_can_manage_maquis_backups(bs, all_site_ids=all_ids):
                self.send_json(HTTPStatus.FORBIDDEN, {"error": "Acces refuse."})
                return
            body = self.read_json()
            site_raw = str((body or {}).get("siteId", "")).strip()
            if not session_site_id_allowed_for_backup(bs, site_raw, all_ids):
                self.send_json(HTTPStatus.FORBIDDEN, {"error": "Maquis non autorise."})
                return
            try:
                info = store.write_site_backup(site_raw)
            except ValueError as error:
                self.send_json(HTTPStatus.BAD_REQUEST, {"error": str(error)})
                return
            except OSError:
                self.send_json(HTTPStatus.INTERNAL_SERVER_ERROR, {"error": "Sauvegarde impossible."})
                return
            audit_log(
                "create_site_backup",
                {"ip": self.client_ip(), "username": session.get("username", ""), "siteId": site_raw, "file": info.get("file", "")},
            )
            self.send_json(HTTPStatus.OK, info, cache_control="no-store")
            return
        if post_path == "/api/admin/create-manual-backup":
            session = self.require_session()
            if session is None:
                return
            if not self.require_csrf(session):
                return
            if not session_is_superadmin(session, all_site_ids=store.all_site_ids()):
                self.send_json(HTTPStatus.FORBIDDEN, {"error": "Acces refuse."})
                return
            try:
                info = store.write_manual_backup()
            except ValueError as error:
                self.send_json(HTTPStatus.BAD_REQUEST, {"error": str(error)})
                return
            except OSError:
                audit_log("create_manual_backup_failed", {"ip": self.client_ip(), "username": session.get("username", "")})
                self.send_json(HTTPStatus.INTERNAL_SERVER_ERROR, {"error": "Sauvegarde impossible. Reessayez plus tard."})
                return
            audit_log(
                "create_manual_backup",
                {"ip": self.client_ip(), "username": session.get("username", ""), "file": info.get("file", "")},
            )
            self.send_json(HTTPStatus.OK, info, cache_control="no-store")
            return
        if post_path == "/api/public/order":
            if not public_order_rate_limit_check(self.client_ip()):
                self.send_json(
                    HTTPStatus.TOO_MANY_REQUESTS,
                    {"error": "Trop de commandes. Réessayez dans quelques instants."},
                )
                return
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

        if post_path == "/api/login":
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
            canon = str(user.get("username", "")).strip()
            with store._lock:
                user_data = next((u for u in store._state["auth"]["users"] if u["username"] == canon), None)
                has_2fa = bool(user_data and user_data.get("twoFactorEnabled") and user_data.get("twoFactorSecret"))
            if REQUIRE_2FA_FOR_PRIVILEGED and privileged_role_requires_2fa_policy(user["role"]) and not has_2fa:
                audit_log(
                    "login_denied_2fa_required",
                    {"ip": ip, "username": canon, "role": user.get("role", "")},
                )
                self.send_json(
                    HTTPStatus.FORBIDDEN,
                    {
                        "error": "La double authentification (2FA) est obligatoire pour les comptes administrateur. Activez le 2FA sur ce compte (ou désactivez temporairement MAQUIS_MANAGER_REQUIRE_2FA_ADMINS sur le serveur).",
                    },
                    cache_control="no-store",
                )
                return
            login_rate_limit_success(ip, canon)
            audit_log("login_success", {"ip": ip, "username": canon})
            # WhatsApp 2FA — prioritaire sur le TOTP si activé
            with store._lock:
                wa_user_data = next((u for u in store._state["auth"]["users"] if u["username"] == canon), None)
            wa2fa_active = bool(wa_user_data and wa_user_data.get("wa2faEnabled") and wa_user_data.get("waPhone"))
            if wa2fa_active:
                otp = _wa_otp_generate(canon)
                sent = False
                try:
                    sent = _whatsapp_send(
                        wa_user_data["waPhone"],
                        f"[Cave des Amis] Votre code de connexion : *{otp}*\nValable 15 minutes. Ne le partagez pas.",
                        force_text=True,
                    )
                except Exception as ex:
                    # En cas d'exception inattendue, on loggue et on marque comme non envoyé
                    print(f"[WA 2FA] Exception envoi OTP: {ex}", flush=True)
                    audit_log("wa_send_error", {"to": wa_user_data.get("waPhone"), "error": str(ex), "context": "login_otp"})
                    sent = False
                if not sent:
                    print(f"[WA 2FA] OTP non envoye pour {canon}", flush=True)
                    self.send_json(
                        HTTPStatus.SERVICE_UNAVAILABLE,
                        {"error": "Impossible d'envoyer le code WhatsApp. Verifiez la configuration ou consultez les logs."},
                        cache_control="no-store",
                    )
                    return
                self.send_json(HTTPStatus.OK, {"require2fa": "whatsapp", "username": canon})
                return
            if has_2fa:
                pre_auth = create_pre_auth_token(canon)
                self.send_json(HTTPStatus.OK, {"needsTwoFactor": True, "preAuthToken": pre_auth})
                return
            aids_login = store.all_site_ids()
            token = sessions.create(
                user["username"],
                user["role"],
                user["allowedSiteIds"],
                global_superadmin=bool(user.get("globalSuperadmin")),
                all_site_ids=aids_login,
            )
            sess_view = sessions.get(token) or {}
            bs_login = resolve_backup_session(sess_view, store)
            self.send_json(
                HTTPStatus.OK,
                {
                    "authenticated": True,
                    "username": user["username"],
                    "role": bs_login.get("role", user["role"]),
                    "allowedSiteIds": list(bs_login.get("allowedSiteIds") or user["allowedSiteIds"]),
                    "globalSuperadmin": bool(bs_login.get("globalSuperadmin")),
                    "maquisBackupAllowed": session_can_manage_maquis_backups(bs_login, all_site_ids=aids_login),
                    **session_timing_fields(sess_view),
                },
                cookie=token,
            )
            return

        if post_path == "/api/2fa/verify":
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
                role = str(user_data["role"])
                if str(username).strip().lower() == "admin":
                    role = "superadmin"
                    allowed = list(all_site_ids)
                    prev_sites = [str(x) for x in (user_data.get("allowedSiteIds") or [])]
                    if user_data.get("role") != "superadmin" or prev_sites != [str(x) for x in all_site_ids]:
                        user_data["role"] = "superadmin"
                        user_data["allowedSiteIds"] = list(all_site_ids)
                        store._write(store._state)
                elif role == "superadmin":
                    allowed = [sid for sid in user_data.get("allowedSiteIds", all_site_ids) if sid in all_site_ids] or all_site_ids[:1]
                gs = compute_global_superadmin(str(username), role, allowed, all_site_ids)
            aids_2fa = store.all_site_ids()
            token = sessions.create(username, role, allowed, global_superadmin=gs, all_site_ids=aids_2fa)
            sess_view = sessions.get(token) or {}
            bs_2fa = resolve_backup_session(sess_view, store)
            self.send_json(
                HTTPStatus.OK,
                {
                    "authenticated": True,
                    "username": username,
                    "role": bs_2fa.get("role", role),
                    "allowedSiteIds": list(bs_2fa.get("allowedSiteIds") or allowed),
                    "globalSuperadmin": bool(bs_2fa.get("globalSuperadmin")),
                    "maquisBackupAllowed": session_can_manage_maquis_backups(bs_2fa, all_site_ids=aids_2fa),
                    **session_timing_fields(sess_view),
                },
                cookie=token,
            )
            return

        if post_path == "/api/2fa/wa-verify":
            body = self.read_json() or {}
            uname = str(body.get("username", "")).strip().lower()
            otp = str(body.get("code", "")).strip()
            if not uname or not otp:
                self.send_json(HTTPStatus.BAD_REQUEST, {"error": "Identifiant ou code manquant."})
                return
            with store._lock:
                wv_users = store._state.get("auth", {}).get("users", [])
                wv_user_row = next(
                    (u for u in wv_users if str(u.get("username", "")).strip().lower() == uname),
                    None,
                )
            if not wv_user_row:
                self.send_json(HTTPStatus.UNAUTHORIZED, {"error": "Acces refuse."})
                return
            if not _wa_otp_verify(uname, otp):
                self.send_json(HTTPStatus.UNAUTHORIZED, {"error": "Code invalide ou expire."})
                return
            # Code correct — créer la session (même logique que /api/2fa/verify)
            wv_username = str(wv_user_row.get("username", ""))
            with store._lock:
                wv_all_site_ids = [s["id"] for s in store._state["sites"]]
                wv_allowed = [
                    sid for sid in wv_user_row.get("allowedSiteIds", wv_all_site_ids)
                    if sid in wv_all_site_ids
                ] or wv_all_site_ids[:1]
                wv_role = str(wv_user_row.get("role", "serveuse"))
                if wv_username.strip().lower() == "admin":
                    wv_role = "superadmin"
                    wv_allowed = list(wv_all_site_ids)
                    prev_sites = [str(x) for x in (wv_user_row.get("allowedSiteIds") or [])]
                    if wv_user_row.get("role") != "superadmin" or prev_sites != [str(x) for x in wv_all_site_ids]:
                        wv_user_row["role"] = "superadmin"
                        wv_user_row["allowedSiteIds"] = list(wv_all_site_ids)
                        store._write(store._state)
                elif wv_role == "superadmin":
                    wv_allowed = [
                        sid for sid in wv_user_row.get("allowedSiteIds", wv_all_site_ids)
                        if sid in wv_all_site_ids
                    ] or wv_all_site_ids[:1]
                wv_gs = compute_global_superadmin(wv_username, wv_role, wv_allowed, wv_all_site_ids)
            wv_aids = store.all_site_ids()
            wv_token = sessions.create(wv_username, wv_role, wv_allowed, global_superadmin=wv_gs, all_site_ids=wv_aids)
            wv_sess_view = sessions.get(wv_token) or {}
            wv_bs = resolve_backup_session(wv_sess_view, store)
            audit_log("login_wa2fa_success", {"username": wv_username})
            self.send_json(
                HTTPStatus.OK,
                {
                    "authenticated": True,
                    "username": wv_username,
                    "role": wv_bs.get("role", wv_role),
                    "allowedSiteIds": list(wv_bs.get("allowedSiteIds") or wv_allowed),
                    "globalSuperadmin": bool(wv_bs.get("globalSuperadmin")),
                    "maquisBackupAllowed": session_can_manage_maquis_backups(wv_bs, all_site_ids=wv_aids),
                    **session_timing_fields(wv_sess_view),
                },
                cookie=wv_token,
            )
            return

        if post_path == "/api/2fa/setup":
            session = self.require_session()
            if session is None:
                return
            if not self.require_csrf(session):
                return
            payload = self.read_json()
            target = str(payload.get("username", session["username"])).strip()
            with store._lock:
                auth_users = list(store._state["auth"]["users"])
            if target != session["username"] and not session_may_configure_2fa_for_other(
                session, target, auth_users, all_site_ids=store.all_site_ids()
            ):
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
            iss = quote(TOTP_APP_LABEL, safe="")
            acc = quote(target, safe="")
            otp_url = (
                f"otpauth://totp/{iss}:{acc}?secret={secret}"
                f"&issuer={iss}&algorithm=SHA1&digits=6&period=30"
            )
            self.send_json(HTTPStatus.OK, {"secret": secret, "otpauthUrl": otp_url})
            return

        if post_path == "/api/2fa/enable":
            session = self.require_session()
            if session is None:
                return
            if not self.require_csrf(session):
                return
            payload = self.read_json()
            target = str(payload.get("username", session["username"])).strip()
            code = str(payload.get("code", "")).strip()
            with store._lock:
                auth_users = list(store._state["auth"]["users"])
            if target != session["username"] and not session_may_configure_2fa_for_other(
                session, target, auth_users, all_site_ids=store.all_site_ids()
            ):
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

        if post_path == "/api/2fa/disable":
            session = self.require_session()
            if session is None:
                return
            if not self.require_csrf(session):
                return
            payload = self.read_json()
            target = str(payload.get("username", session["username"])).strip()
            with store._lock:
                auth_users = list(store._state["auth"]["users"])
            if target != session["username"] and not session_may_configure_2fa_for_other(
                session, target, auth_users, all_site_ids=store.all_site_ids()
            ):
                self.send_json(HTTPStatus.FORBIDDEN, {"error": "Acces refuse."})
                return
            with store._lock:
                for u in store._state["auth"]["users"]:
                    if u["username"] == target:
                        target_role = str(u.get("role", ""))
                        if REQUIRE_2FA_FOR_PRIVILEGED and privileged_role_requires_2fa_policy(target_role):
                            self.send_json(
                                HTTPStatus.FORBIDDEN,
                                {"error": "La desactivation du 2FA est interdite pour les comptes administrateur et gerant."},
                            )
                            return
                        u.pop("twoFactorSecret", None)
                        u.pop("twoFactorSecretPending", None)
                        u["twoFactorEnabled"] = False
                        store._write(store._state)
                        sessions.invalidate_all_for_username(target)
                        audit_log(
                            "2fa_disabled",
                            {
                                "ip": self.client_ip(),
                                "target": target,
                                "by": str(session.get("username", "")),
                            },
                        )
                        self.send_json(HTTPStatus.OK, {"ok": True})
                        return
                self.send_json(HTTPStatus.NOT_FOUND, {"error": "Utilisateur introuvable."})
            return

        if post_path == "/api/logout":
            token = self.session_token()
            sess = sessions.get(token)
            if sess:
                audit_log("logout", {"ip": self.client_ip(), "username": str(sess.get("username", ""))})
            sessions.clear(token)
            self.send_json(HTTPStatus.OK, {"authenticated": False}, clear_cookie=True)
            return

        if post_path == "/api/reauth":
            session = self.require_session()
            if session is None:
                return
            if not self.require_csrf(session):
                return
            body = self.read_json() or {}
            password = str(body.get("password", "")).strip()
            if not password:
                self.send_json(HTTPStatus.BAD_REQUEST, {"error": "Mot de passe requis."})
                return
            user = store.verify_credentials(str(session.get("username", "")), password)
            if user is None:
                audit_log("reauth_failed", {"ip": self.client_ip(), "username": str(session.get("username", ""))})
                self.send_json(HTTPStatus.UNAUTHORIZED, {"error": "Mot de passe incorrect."})
                return
            reauth_tok = create_reauth_token(str(session.get("username", "")), self.session_token())
            audit_log("reauth_ok", {"ip": self.client_ip(), "username": str(session.get("username", ""))})
            self.send_json(HTTPStatus.OK, {"reauthToken": reauth_tok})
            return

        if post_path == "/api/reset":
            session = self.require_session()
            if session is None:
                return
            if not self.require_csrf(session):
                return
            if not session_is_superadmin(session, all_site_ids=store.all_site_ids()):
                self.send_json(HTTPStatus.FORBIDDEN, {"error": "Seul le super administrateur peut reinitialiser l'application."})
                return
            body = self.read_json() or {}
            reauth_tok = str(body.get("reauthToken", "")).strip()
            if not consume_reauth_token(reauth_tok, self.session_token()):
                self.send_json(HTTPStatus.FORBIDDEN, {"error": "Confirmation du mot de passe requise. Veuillez re-authentifier."})
                return
            payload = store.reset()
            audit_log(
                "app_reset",
                {"ip": self.client_ip(), "username": str(session.get("username", "")), "role": str(session.get("role", ""))},
            )
            self.send_json(HTTPStatus.OK, payload)
            return

        if post_path == "/api/purge-maquis":
            session = self.require_session()
            if session is None:
                return
            if not self.require_csrf(session):
                return
            if not session_is_superadmin(session, all_site_ids=store.all_site_ids()):
                self.send_json(HTTPStatus.FORBIDDEN, {"error": "Seul le super administrateur peut purger un maquis."})
                return
            body = self.read_json() or {}
            reauth_tok = str(body.get("reauthToken", "")).strip()
            if not consume_reauth_token(reauth_tok, self.session_token()):
                self.send_json(HTTPStatus.FORBIDDEN, {"error": "Confirmation du mot de passe requise. Veuillez re-authentifier."})
                return
            target = str(body.get("siteId", "")).strip()
            keep_cat = bool(body.get("keepStockCatalog"))
            try:
                payload = store.purge_maquis_data(target, keep_stock_catalog=keep_cat)
            except ValueError as error:
                self.send_json(HTTPStatus.BAD_REQUEST, {"error": str(error)})
                return
            audit_log(
                "purge_maquis",
                {
                    "ip": self.client_ip(),
                    "username": str(session.get("username", "")),
                    "siteId": target,
                    "keepStockCatalog": keep_cat,
                },
            )
            self.send_json(HTTPStatus.OK, payload)
            return

        if post_path == "/api/wa-test":
            session = self.require_session()
            if session is None:
                return
            if not self.require_csrf(session):
                return
            body = self.read_json() or {}
            phone = str(body.get("phone", "")).strip()
            if not phone:
                self.send_json(HTTPStatus.BAD_REQUEST, {"error": "Numéro de téléphone requis."})
                return
            try:
                _whatsapp_send(phone, "[Cave des Amis] ✅ Test de notification WhatsApp réussi. Le bot est opérationnel.")
                audit_log("wa_test", {"ip": self.client_ip(), "username": str(session.get("username", "")), "to": phone})
                self.send_json(HTTPStatus.OK, {"ok": True, "to": phone})
            except Exception as ex:
                self.send_json(HTTPStatus.BAD_REQUEST, {"error": str(ex)})
            return

        if post_path.startswith("/api"):
            self.send_json(HTTPStatus.NOT_FOUND, {"error": "Route API introuvable. Verifiez que la derniere version du serveur est deployee."})
            return
        self.send_error(HTTPStatus.NOT_FOUND)

    def do_OPTIONS(self) -> None:
        self.send_response(HTTPStatus.NO_CONTENT)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, X-CSRF-Token")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, PUT, OPTIONS")
        self.end_headers()

    def do_PUT(self) -> None:
        parsed = urlparse(self.path)
        print(f"[PUT] {parsed.path} depuis {self.client_ip()}", flush=True)
        if parsed.path == "/api/state":
            session = self.require_session()
            if session is None:
                print("[PUT] session invalide → rejet", flush=True)
                return
            if not self.require_csrf(session):
                print("[PUT] CSRF invalide → rejet", flush=True)
                return
            op_id = str(self.headers.get("X-Op-Id") or "").strip()
            if _state_put_check_dedup(op_id):
                self.send_json(HTTPStatus.OK, {"meta": store.meta(), "idempotent": True})
                return
            payload = self.read_json()
            print(f"[PUT] payload recu, cles={sorted((payload or {}).keys())[:12]}", flush=True)
            try:
                validate_state_put_payload(payload)
                updated = store.update_state(payload, session)
            except ValueError as error:
                print(f"[PUT] ValueError: {error}", flush=True)
                self.send_json(HTTPStatus.BAD_REQUEST, {"error": str(error)})
                return
            except Exception as error:
                import traceback as _tb2
                print(f"[PUT] ERREUR INTERNE: {type(error).__name__}: {error}", flush=True)
                _tb2.print_exc()
                self.send_json(HTTPStatus.INTERNAL_SERVER_ERROR, {"error": f"Erreur serveur interne: {error}"})
                return
            audit_log(
                "state_put",
                {
                    "ip": self.client_ip(),
                    "username": str(session.get("username", "")),
                    "role": str(session.get("role", "")),
                    "globalSuperadmin": bool(session.get("globalSuperadmin")),
                    "sections": sorted(str(k) for k in (payload or {}).keys()),
                },
            )
            # Renvoyer uniquement les clés modifiées + meta/activeSiteId.
            # Le client fusionne localement (patchedKeys guard dans mergeStateFromServerResponse).
            _resp_keys = set((payload or {}).keys()) | {"meta", "activeSiteId"}
            self.send_json(HTTPStatus.OK, {k: v for k, v in updated.items() if k in _resp_keys})
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
        with store._lock:
            auth_users = list(store._state.get("auth", {}).get("users", []))
        if session_missing_required_2fa(session, auth_users):
            sessions.clear(token)
            self.send_json(
                HTTPStatus.UNAUTHORIZED,
                {
                    "authenticated": False,
                    "error": "La double authentification (2FA) est obligatoire. Activez le 2FA puis reconnectez-vous.",
                    "requires2FA": True,
                },
                clear_cookie=True,
            )
            return None
        sessions.sync_from_auth_user(token, store)
        return sessions.get(token)

    def require_csrf(self, session: dict[str, Any]) -> bool:
        expected = str(session.get("csrfToken") or "").strip()
        if not expected:
            return True
        provided = (self.headers.get("X-CSRF-Token") or "").strip()
        if provided and hmac.compare_digest(provided, expected):
            return True
        audit_log(
            "csrf_rejected",
            {"ip": self.client_ip(), "username": str(session.get("username", ""))},
        )
        self.send_json(
            HTTPStatus.FORBIDDEN,
            {"error": "Requete refusee. Rechargez la page puis reconnectez-vous si le probleme persiste."},
        )
        return False

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
        secure = self._cookie_secure()
        if cookie:
            self.send_header(
                "Set-Cookie",
                f"{SESSION_COOKIE}={cookie}; Path=/; HttpOnly; SameSite=Lax{secure}; Max-Age={SESSION_ABSOLUTE_SECONDS}",
            )
        if clear_cookie:
            self.send_header(
                "Set-Cookie",
                f"{SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax{secure}; Max-Age=0",
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


# ---------------------------------------------------------------------------
# Clôture automatique côté serveur (background thread, toujours actif)
# ---------------------------------------------------------------------------

def _stock_frigo_py(item: dict[str, Any]) -> float:
    if item.get("frigo") is not None:
        return max(0.0, float(item["frigo"] or 0))
    return max(0.0, float(item.get("init", 0) or 0) + float(item.get("entrees", 0) or 0) - float(item.get("sorties", 0) or 0))


def _stock_reserve_py(item: dict[str, Any]) -> float:
    if item.get("reserve") is not None:
        return max(0.0, float(item["reserve"] or 0))
    total = max(0.0, float(item.get("init", 0) or 0) + float(item.get("entrees", 0) or 0) - float(item.get("sorties", 0) or 0))
    return max(0.0, total - _stock_frigo_py(item))


def _stock_actuel_py(item: dict[str, Any]) -> float:
    if item.get("frigo") is not None or item.get("reserve") is not None:
        return max(0.0, _stock_frigo_py(item) + _stock_reserve_py(item))
    return max(0.0, float(item.get("init", 0) or 0) + float(item.get("entrees", 0) or 0) - float(item.get("sorties", 0) or 0))


def _add_calendar_days_iso(iso_date: str, days: int) -> str:
    from datetime import date, timedelta
    y, m, d = iso_date[:10].split("-")
    return (date(int(y), int(m), int(d)) + timedelta(days=days)).isoformat()


def _auto_open_next_day_after_close(state: dict[str, Any], site_id: str, closed_date: str, closing_cash: float) -> str | None:
    """Ouvre la journée comptable suivante (fonds = caisse à la fermeture) et positionne pdjWorkDateBySite."""
    today_str = _today_iso_local()
    next_date = _add_calendar_days_iso(closed_date, 1)
    if next_date > today_str:
        return None
    opening = max(0, int(round(float(closing_cash or 0))))
    books = list(state.get("dayBooks", []))
    book = next(
        (b for b in books if str(b.get("siteId", "")) == site_id and str(b.get("date", ""))[:10] == next_date),
        None,
    )
    if book and book.get("openingCashRecorded"):
        pass
    else:
        ts = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
        snapshot: dict[str, str] = {}
        for item in state.get("stock", []):
            if str(item.get("siteId", "")) != site_id:
                continue
            snapshot[str(item.get("id"))] = _stock_actuel_py(item)
        if not book:
            book = {
                "id": int(time.time() * 1000) + 1,
                "siteId": site_id,
                "date": next_date,
                "openedAt": ts,
                "openingStockById": snapshot,
                "openingCashFcfa": opening,
                "openingCashRecorded": True,
                "openingRecordedAt": ts,
                "openingRecordedBy": "clôture auto",
                "autoOpenedFromClose": True,
                "autoOpenedFromDate": closed_date[:10],
            }
        else:
            book["openingCashFcfa"] = opening
            book["openingCashRecorded"] = True
            book["openingRecordedAt"] = ts
            book["openingRecordedBy"] = "clôture auto"
            if not book.get("openingStockById"):
                book["openingStockById"] = snapshot
            book["autoOpenedFromClose"] = True
            book["autoOpenedFromDate"] = closed_date[:10]
            if not book.get("openedAt"):
                book["openedAt"] = ts
        books = [book] + [b for b in books if not (str(b.get("siteId", "")) == site_id and str(b.get("date", ""))[:10] == next_date)]
        state["dayBooks"] = books

    pdj_map = dict(state.get("pdjWorkDateBySite") or {})
    if next_date == today_str:
        pdj_map.pop(site_id, None)
    else:
        pdj_map[site_id] = next_date
    state["pdjWorkDateBySite"] = pdj_map
    return next_date


def _server_auto_close_site(site_id: str, d_str: str) -> None:
    """Clôture automatique d'un maquis pour une date donnée. Thread-safe via store._lock (RLock)."""
    with store._lock:
        state = store._state
        # Vérification idempotente : déjà clôturé ?
        if any(sc.get("siteId") == site_id and sc.get("date") == d_str for sc in state.get("stockChecks", [])):
            return
        # Commandes encore au statut « En attente » (aligné client pendingOrdersForJournalDate)
        pending = [
            c for c in state.get("commandes", [])
            if str(c.get("siteId", "")) == site_id
            and str(c.get("date", "")).startswith(d_str)
            and str(c.get("status") or "").strip() == "En attente"
        ]
        if pending:
            print(f"[auto-cloture] Site {site_id} {d_str}: {len(pending)} commande(s) en attente — clôture reportée.", flush=True)
            return

        site_stock = [item for item in state.get("stock", []) if str(item.get("siteId", "")) == site_id]
        ventes_jour = [v for v in state.get("ventes", [])
                       if str(v.get("siteId", "")) == site_id
                       and str(v.get("date", "")).startswith(d_str)]

        # Ne pas clôturer automatiquement un jour sans ventes et sans caisse ouverte
        day_books = state.get("dayBooks", [])
        day_book_exists = any(
            str(b.get("siteId", "")) == site_id and str(b.get("date", "")).startswith(d_str)
            for b in day_books
        )
        if not ventes_jour and not day_book_exists:
            print(f"[auto-cloture] Site {site_id} {d_str}: aucune vente ni caisse ouverte — clôture ignorée.", flush=True)
            return

        # Totaux paiements
        payment_totals: dict[str, float] = {}
        for v in ventes_jour:
            details = v.get("paiementDetails") or []
            if isinstance(details, list) and details:
                for d in details:
                    m = str(d.get("method") or "Espèces")
                    payment_totals[m] = payment_totals.get(m, 0.0) + float(d.get("amount") or 0)
            else:
                m = str(v.get("paiement") or "Espèces")
                net = max(0.0, float(v.get("prix") or 0) * float(v.get("qty") or 0) - float(v.get("remise") or 0))
                payment_totals[m] = payment_totals.get(m, 0.0) + net

        ca_encaisse = sum(amt for method, amt in payment_totals.items() if "dit client" not in method.lower())

        day_book = next((b for b in day_books
                         if str(b.get("siteId", "")) == site_id
                         and str(b.get("date", "")).startswith(d_str)), None)
        # Ne pas reclore un jour réouvert manuellement (évite la boucle réouverture↔auto-clôture)
        if day_book and day_book.get("manualReopenedAt"):
            print(f"[auto-cloture] Site {site_id} {d_str}: réouvert manuellement — clôture auto ignorée.", flush=True)
            return
        opening_cash = float((day_book or {}).get("openingCashFcfa") or 0)

        especes_ventes = payment_totals.get("Espèces", payment_totals.get("EspÃ¨ces", 0.0))
        especes_recouvrement = sum(
            float(r.get("montant") or 0)
            for r in state.get("creditRecoveries", [])
            if str(r.get("siteId", "")) == site_id
            and str(r.get("paidAt") or r.get("date") or "").startswith(d_str)
            and "pèces" in str(r.get("paiement") or "")
        )
        expected_especes = opening_cash + especes_ventes + especes_recouvrement
        closing_cash = expected_especes

        # Construire checkedItems avec valeurs théoriques
        opening_stock_by_id: dict[str, float] = {}
        if day_book and isinstance(day_book.get("openingStockById"), dict):
            for k, v in day_book["openingStockById"].items():
                try:
                    opening_stock_by_id[str(k)] = float(v)
                except (TypeError, ValueError):
                    pass

        prev_close = next((sc for sc in state.get("stockChecks", [])
                           if sc.get("siteId") == site_id and sc.get("date") == d_str), None)

        checked_items = []
        for item in site_stock:
            frigo = _stock_frigo_py(item)
            reserve = _stock_reserve_py(item)
            item_id_str = str(item.get("id", ""))
            if item_id_str in opening_stock_by_id:
                stock_at_open = opening_stock_by_id[item_id_str]
            else:
                stock_at_open = max(0.0, float(item.get("init") or 0) + float(item.get("entrees") or 0) - float(item.get("sorties") or 0))
            sorties_today = sum(
                float(v.get("qty") or 0) * max(1.0, float(v.get("formatQuantite") or v.get("packSize") or 1))
                for v in ventes_jour
                if v.get("article") == item.get("article")
            )
            expected_remaining = max(0.0, stock_at_open - sorties_today)
            counted = frigo + reserve
            ecart = counted - expected_remaining
            checked_items.append({
                "id": item["id"],
                "article": item.get("article", ""),
                "cat": item.get("cat", ""),
                "stockAvant": stock_at_open,
                "sortiesToday": sorties_today,
                "expected": expected_remaining,
                "frigo": frigo,
                "reserve": reserve,
                "counted": counted,
                "ecart": ecart,
                "stockApres": counted,
            })

        # Mettre à jour le stock
        for checked in checked_items:
            item = next((i for i in state["stock"] if i.get("id") == checked["id"]), None)
            if not item:
                continue
            item["frigo"] = checked["frigo"]
            item["reserve"] = checked["reserve"]
            if prev_close:
                prev_item = next((pi for pi in (prev_close.get("items") or []) if pi.get("id") == checked["id"]), None)
                if prev_item:
                    if float(prev_item.get("sortiesToday") or 0) > 0:
                        item["sorties"] = max(0.0, float(item.get("sorties") or 0) - float(prev_item["sortiesToday"]))
                    prev_ecart = float(prev_item.get("ecart") or 0)
                    if prev_ecart > 0:
                        item["entrees"] = max(0.0, float(item.get("entrees") or 0) - prev_ecart)
                    elif prev_ecart < 0:
                        item["sorties"] = max(0.0, float(item.get("sorties") or 0) - abs(prev_ecart))
            if checked["sortiesToday"] > 0:
                item["sorties"] = float(item.get("sorties") or 0) + checked["sortiesToday"]
                item["lastSortieAt"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
                item["lastSortieBy"] = "auto-cloture-serveur"
            if checked["ecart"] > 0:
                item["entrees"] = float(item.get("entrees") or 0) + checked["ecart"]
            elif checked["ecart"] < 0:
                item["sorties"] = float(item.get("sorties") or 0) + abs(checked["ecart"])

        check = {
            "id": int(time.time() * 1000),
            "siteId": site_id,
            "date": d_str,
            "createdAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            "openedAt": (day_book or {}).get("openedAt", ""),
            "openingCashFcfa": opening_cash,
            "closingCashFcfa": closing_cash,
            "expectedEspecesCash": expected_especes,
            "cashEcartEspeces": 0,
            "caEncaisse": ca_encaisse,
            "caCreances": 0,
            "caCreancesEmisesJour": 0,
            "nbVentes": len(ventes_jour),
            "totauxJour": payment_totals,
            "items": checked_items,
            "autoClose": True,
        }
        state["stockChecks"] = [check] + [
            sc for sc in state.get("stockChecks", [])
            if not (sc.get("siteId") == site_id and sc.get("date") == d_str)
        ]
        pdj_map = dict(state.get("pdjWorkDateBySite") or {})
        if pdj_map.get(site_id) == d_str:
            pdj_map.pop(site_id, None)
            state["pdjWorkDateBySite"] = pdj_map

        next_opened = _auto_open_next_day_after_close(state, site_id, d_str, closing_cash)
        store._write(state)

    audit_log("auto_cloture_jour", {
        "siteId": site_id,
        "date": d_str,
        "caEncaisse": ca_encaisse,
        "nbVentes": len(ventes_jour),
        "method": "server_background",
    })
    extra = f" → journée suivante {next_opened} ouverte auto" if next_opened else ""
    print(f"[auto-cloture] Site {site_id} clôturée pour le {d_str} (CA {ca_encaisse:.0f} FCFA, {len(ventes_jour)} ventes){extra}", flush=True)


def _auto_cloture_check() -> None:
    """Vérifie toutes les minutes si une clôture automatique est due."""
    def _to_mins(hhmm: str) -> int:
        try:
            h, m = hhmm[:5].split(":")
            return int(h) * 60 + int(m)
        except Exception:
            return -1

    try:
        now = time.localtime()
        today_str = time.strftime("%Y-%m-%d", now)
        current_mins = _to_mins(time.strftime("%H:%M", now))

        to_close: list[tuple[str, str]] = []
        with store._lock:
            state = store._state
            closed_by_site: dict[str, set[str]] = {}
            for sc in state.get("stockChecks", []):
                sid = str(sc.get("siteId") or "")
                d = str(sc.get("date") or "")[:10]
                if sid and len(d) >= 10:
                    closed_by_site.setdefault(sid, set()).add(d)

            for site in state.get("sites", []):
                site_id = str(site.get("id") or "")
                if not site_id or not site.get("autoClotureEnabled"):
                    continue
                cloture_time = str(site.get("autoClotureTime") or "")
                if len(cloture_time) < 5:
                    continue
                cloture_mins = _to_mins(cloture_time)
                if cloture_mins < 0:
                    continue
                closed_dates = closed_by_site.get(site_id, set())

                unclosed_dates: set[str] = set()
                for b in state.get("dayBooks", []):
                    if str(b.get("siteId", "")) != site_id:
                        continue
                    d = str(b.get("date") or "")[:10]
                    if len(d) >= 10 and d <= today_str and d not in closed_dates:
                        unclosed_dates.add(d)
                for v in state.get("ventes", []):
                    if str(v.get("siteId", "")) != site_id:
                        continue
                    d = str(v.get("date", ""))[:10]
                    if len(d) >= 10 and d <= today_str and d not in closed_dates:
                        unclosed_dates.add(d)

                for d_str in sorted(unclosed_dates):
                    if d_str < today_str:
                        to_close.append((site_id, d_str))
                        break
                    if d_str == today_str and current_mins >= cloture_mins:
                        to_close.append((site_id, d_str))
                        break

        for site_id, d_str in to_close:
            _server_auto_close_site(site_id, d_str)
    except Exception as exc:
        print(f"[auto-cloture] Erreur inattendue : {exc}", flush=True)


def _start_auto_cloture_thread() -> None:
    def loop() -> None:
        while True:
            time.sleep(60)
            _auto_cloture_check()
    threading.Thread(target=loop, daemon=True, name="auto-cloture").start()
    print("[auto-cloture] Planificateur de clôture automatique démarré.", flush=True)


def main() -> None:
    host = _env_first("MAQUIS_MANAGER_HOST", "TDB_BAR_HOST", default="0.0.0.0")
    requested_port = int(_env_first("MAQUIS_MANAGER_PORT", "TDB_BAR_PORT", default="8000"))
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

    _start_auto_cloture_thread()
    print(f"Maquis Manager server running on http://127.0.0.1:{bound_port}", flush=True)
    print(f"Storage mode: {STORAGE_MODE}", flush=True)
    print(f"Sauvegardes automatiques dans {BACKUP_DIR} (garder jusqu'a {BACKUP_KEEP_COUNT} fichiers par type)", flush=True)
    _wa_phone_id = os.environ.get("WHATSAPP_PHONE_NUMBER_ID", "").strip()
    _wa_token = os.environ.get("WHATSAPP_ACCESS_TOKEN", "").strip()
    if _wa_phone_id and _wa_token:
        print(f"WhatsApp: ACTIF (Phone ID={_wa_phone_id})", flush=True)
    else:
        print("WhatsApp: NON CONFIGURE - demarrer via lancer.bat pour activer les notifications", flush=True)
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
