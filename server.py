from __future__ import annotations

import base64
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


BASE_DIR = Path(__file__).resolve().parent
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
    return r in ("superadmin", "admin")


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
    for key in ("sessionCreatedAt", "sessionDeadlineUnix", "sessionAbsoluteSeconds", "sessionIdleSeconds"):
        if key in sess:
            out[key] = sess[key]
    return out


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


def notify_qr_order_created_async(site: dict[str, Any], order: dict[str, Any]) -> None:
    """Alertes SMS / webhook après commande cliente (QR). Ne bloque pas l'HTTP : thread daemon."""

    def run() -> None:
        alert_phone = _alert_phone_for_qr_orders(site)
        msg = _qr_order_alert_message(site, order)
        webhook_url = os.environ.get("GESTION_CAVE_QR_ALERT_WEBHOOK", "").strip()
        if webhook_url:
            try:
                _post_qr_alert_webhook(webhook_url, site, order, msg, alert_phone)
            except (OSError, HTTPError, URLError, ValueError) as ex:
                audit_log("qr_order_webhook_alert_failed", {"error": str(ex), "siteId": site.get("id"), "orderId": order.get("id")})

        twilio_sid = os.environ.get("TWILIO_ACCOUNT_SID", "").strip()
        if twilio_sid and alert_phone:
            try:
                _twilio_send_sms(alert_phone, msg)
            except (OSError, HTTPError, URLError, ValueError) as ex:
                audit_log("qr_order_twilio_sms_failed", {"error": str(ex), "siteId": site.get("id"), "orderId": order.get("id")})

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
)


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
    if re.fullmatch(r"data-\d{8}-\d{6}\.json", name):
        return migrate_state(json.loads(path.read_text(encoding="utf-8")))
    if re.fullmatch(r"app-\d{8}-\d{6}\.sqlite3", name):
        conn = sqlite3.connect(str(path))
        try:
            row = conn.execute("SELECT v FROM kv WHERE k = ?", ("state",)).fetchone()
        finally:
            conn.close()
        if not row or not row[0]:
            raise ValueError("Sauvegarde SQLite sans etat.")
        return migrate_state(json.loads(row[0]))
    raise ValueError("Formats acceptes : data-AAAAMMJJ-HHMMSS.json ou app-AAAAMMJJ-HHMMSS.sqlite3.")


def session_is_superadmin(session: dict[str, Any] | None) -> bool:
    if session is None:
        return True
    if str(session.get("role", "")) == "superadmin":
        return True
    if str(session.get("username", "")).strip().lower() == "admin":
        return True
    return False


def session_allowed_sites(session: dict[str, Any], site_ids: list[str]) -> set[str]:
    sid_set = set(site_ids)
    return {str(s) for s in (session.get("allowedSiteIds") or []) if str(s) in sid_set}


def row_effective_site_id(row: dict[str, Any], site_ids: list[str], allowed: set[str]) -> str | None:
    site_set = {str(x) for x in site_ids}
    raw = row.get("siteId")
    sid_s = str(raw) if raw is not None and raw != "" else ""
    if sid_s in site_set:
        return sid_s
    if (raw is None or raw == "") and len(allowed) == 1:
        return next(iter(allowed))
    return None


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


def user_visible_in_public_state(u: dict[str, Any], session: dict[str, Any]) -> bool:
    if session_is_superadmin(session):
        return True
    if str(u.get("username", "")) == str(session.get("username", "")):
        return True
    if str(u.get("role", "")) == "superadmin":
        return False
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
            if t_role in ("superadmin", "admin"):
                return False
            return bool(t_sites) and t_sites <= allowed
        if s_role == "manager":
            return t_role == "serveuse" and bool(t_sites & allowed)
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
                if new_role not in ("manager", "serveuse"):
                    continue
            elif s_role == "manager":
                if new_role != "serveuse":
                    continue
            else:
                continue
            nu_allowed = clamp_sites(pu.get("allowedSiteIds"))
            if set(nu_allowed) - allowed:
                continue
            pwd = str(pu.get("password", "")).strip()
            nhash = hash_password(pwd) if pwd else hash_password("serveuse123")
            merged[un] = {
                "username": un,
                "passwordHash": nhash,
                "role": new_role,
                "allowedSiteIds": nu_allowed,
                "twoFactorEnabled": False,
            }
            continue

        if not may_manage_target(exist):
            continue

        if str(exist.get("username", "")) == s_user:
            if new_role == "superadmin" and str(exist.get("role", "")) != "superadmin":
                new_role = str(exist.get("role", ""))
            if s_role != "superadmin" and new_role == "superadmin":
                new_role = str(exist.get("role", ""))
            if s_role == "admin" and new_role not in ("admin", "manager", "serveuse"):
                new_role = str(exist.get("role", ""))
            if s_role == "manager" and new_role not in ("manager", "serveuse"):
                new_role = str(exist.get("role", ""))

        if s_role == "admin" and str(exist.get("username", "")) != s_user:
            if new_role in ("superadmin", "admin"):
                new_role = str(exist.get("role", ""))
            if new_role not in ("manager", "serveuse"):
                new_role = str(exist.get("role", ""))

        nu_allowed = clamp_sites(pu.get("allowedSiteIds", exist.get("allowedSiteIds")))
        nu_allowed = [x for x in nu_allowed if str(x) in allowed] or sorted(allowed)[:1]

        pwd = str(pu.get("password", "")).strip()
        password_hash = hash_password(pwd) if pwd else exist["passwordHash"]
        entry: dict[str, Any] = {
            "username": un,
            "passwordHash": password_hash,
            "role": new_role,
            "allowedSiteIds": nu_allowed,
            "twoFactorEnabled": bool(exist.get("twoFactorEnabled", False)),
        }
        if exist.get("twoFactorSecret"):
            entry["twoFactorSecret"] = exist["twoFactorSecret"]
        if exist.get("twoFactorSecretPending"):
            entry["twoFactorSecretPending"] = exist["twoFactorSecretPending"]
        merged[un] = entry

    result = list(merged.values())
    if not any(str(u.get("role", "")) in ("superadmin", "admin", "manager") for u in result):
        raise ValueError("Au moins un super administrateur, administrateur de maquis ou gerant est obligatoire.")
    return result


def session_state_etag(base_etag: str, session: dict[str, Any]) -> str:
    if session_is_superadmin(session):
        return base_etag
    raw = f"{session.get('username', '')}|{session.get('role', '')}|{','.join(sorted(str(x) for x in (session.get('allowedSiteIds') or [])))}"
    return f"{base_etag}:{hashlib.sha256(raw.encode('utf-8')).hexdigest()[:14]}"


def session_may_configure_2fa_for_other(session: dict[str, Any], target_username: str, auth_users: list[dict[str, Any]]) -> bool:
    if session_is_superadmin(session):
        return True
    if str(session.get("username", "")) == str(target_username):
        return True
    if session.get("role") == "manager":
        return True
    if session.get("role") != "admin":
        return False
    tu = next((u for u in auth_users if u.get("username") == target_username), None)
    if not tu:
        return False
    if str(tu.get("role", "")) in ("superadmin", "admin"):
        return False
    ts = {str(x) for x in (tu.get("allowedSiteIds") or [])}
    ss = {str(x) for x in (session.get("allowedSiteIds") or [])}
    if not ts or not ss:
        return False
    return ts <= ss


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

    def create(self, username: str, role: str, allowed_site_ids: list[str]) -> str:
        token = secrets.token_urlsafe(32)
        now = int(time.time())
        with self._lock:
            self._sessions[token] = {
                "username": username,
                "role": role,
                "allowedSiteIds": list(allowed_site_ids or []),
                "createdAt": now,
                "lastActivityAt": now,
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
            "sessionCreatedAt": created,
            "sessionDeadlineUnix": deadline,
            "sessionAbsoluteSeconds": self.absolute_seconds,
            "sessionIdleSeconds": self.idle_seconds,
        }

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
            for index, site in enumerate(merged["sites"], start=1):
                site.setdefault("prefixeFacture", f"SITE{index}")
                site.setdefault("dualZonePricing", True)
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
        for index, site in enumerate(merged["sites"], start=1):
            site.setdefault("prefixeFacture", f"SITE{index}")
            site.setdefault("dualZonePricing", True)
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
                "stockEntrees": json.loads(json.dumps(self._state.get("stockEntrees", []))),
                "stockLosses": json.loads(json.dumps(self._state.get("stockLosses", []))),
                "dayBooks": json.loads(json.dumps(self._state.get("dayBooks", []))),
                "pdjWorkDateBySite": json.loads(json.dumps(self._state.get("pdjWorkDateBySite", {}))),
                "purchaseOrders": json.loads(json.dumps(self._state.get("purchaseOrders", []))),
                "supplierPrices": json.loads(json.dumps(self._state.get("supplierPrices", []))),
                "casiers": json.loads(json.dumps(self._state.get("casiers", []))),
                "casierMouvements": json.loads(json.dumps(self._state.get("casierMouvements", []))),
                "creditRecoveries": json.loads(json.dumps(self._state.get("creditRecoveries", []))),
                "consignes": json.loads(json.dumps(self._state.get("consignes", []))),
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

    def public_state_for_session(self, session: dict[str, Any]) -> dict[str, Any]:
        with self._lock:
            full = self.public_state()
            if session_is_superadmin(session):
                payload = dict(full)
                payload["adminBackups"] = json.loads(json.dumps(self.list_backups()))
                return payload
            site_ids = [str(s["id"]) for s in self._state["sites"] if s.get("id")]
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
                }
                for u in self._state["auth"]["users"]
                if user_visible_in_public_state(u, session)
            ]
            allowed_set = set(allowed)
            pdj_full = self._state.get("pdjWorkDateBySite", {}) or {}
            pdj_filtered = {k: v for k, v in pdj_full.items() if str(k) in allowed_set}

            return {
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
                "auth": {"users": users_out},
            }

    def changes(self, *, since: str, site_id: str | None = None, session: dict[str, Any] | None = None) -> dict[str, Any]:
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
            pdj_out: dict[str, str] = {}
            if session is not None:
                site_ids = [str(s["id"]) for s in self._state.get("sites", []) if s.get("id")]
                pdj_full = self._state.get("pdjWorkDateBySite", {}) or {}
                if session_is_superadmin(session):
                    pdj_out = json.loads(json.dumps(_sanitize_pdj_work_date_map(pdj_full, site_ids)))
                else:
                    allowed = session_allowed_sites(session, site_ids)
                    if not allowed and site_ids:
                        allowed = {site_ids[0]}
                    allowed_set = set(allowed)
                    raw_sub = {str(k): v for k, v in pdj_full.items() if str(k) in allowed_set}
                    pdj_out = json.loads(json.dumps(_sanitize_pdj_work_date_map(raw_sub, list(allowed_set))))
            return {
                "meta": self.meta(),
                "since": since_raw,
                "pdjWorkDateBySite": json.loads(json.dumps(pdj_out)),
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
                existing_order["updatedAt"] = time.strftime("%Y-%m-%dT%H:%M:%S")
                if note.strip():
                    existing_order["note"] = f"{existing_order.get('note', '')} | {note.strip()}".strip(" |")
                self._write(self._state)
                merged_snap = json.loads(json.dumps(existing_order))
                notify_qr_order_created_async(site, merged_snap)
                return merged_snap

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
            new_snap = json.loads(json.dumps(order))
            notify_qr_order_created_async(site, new_snap)
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
        with self._lock:
            all_site_ids = [site["id"] for site in self._state["sites"]]
            for user in self._state["auth"]["users"]:
                if hmac.compare_digest(username, user["username"]) and verify_password(password, user.get("passwordHash", "")):
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
                        allowed = list(all_site_ids)
                    return {"username": user["username"], "role": role, "allowedSiteIds": allowed}
        return None

    def update_state(self, payload: dict[str, Any], session: dict[str, Any]) -> dict[str, Any]:
        with self._lock:
            current = self._state
            site_ids = [site.get("id") for site in current["sites"] if site.get("id")]
            sid_list = [str(s) for s in site_ids]
            is_super = session_is_superadmin(session)

            if is_super:
                current["sites"] = payload.get("sites", current["sites"])
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
                current["ventes"] = payload.get("ventes", current["ventes"])
                current["stock"] = payload.get("stock", current["stock"])
                current["commandes"] = payload.get("commandes", current.get("commandes", []))
                current["stockChecks"] = payload.get("stockChecks", current.get("stockChecks", []))
                current["dayBooks"] = payload.get("dayBooks", current.get("dayBooks", []))
                current["pdjWorkDateBySite"] = _sanitize_pdj_work_date_map(
                    payload.get("pdjWorkDateBySite", current.get("pdjWorkDateBySite", {})),
                    site_ids,
                )
                current["purchaseOrders"] = payload.get("purchaseOrders", current.get("purchaseOrders", []))
                current["supplierPrices"] = payload.get("supplierPrices", current.get("supplierPrices", []))
                current["casiers"] = payload.get("casiers", current.get("casiers", []))
                current["casierMouvements"] = payload.get("casierMouvements", current.get("casierMouvements", []))
                current["creditRecoveries"] = payload.get("creditRecoveries", current.get("creditRecoveries", []))
                current["consignes"] = payload.get("consignes", current.get("consignes", []))
                current["categories"] = payload.get("categories", current.get("categories", DEFAULT_STATE["categories"]))
                current["charges"] = payload.get("charges", current["charges"])
                current["nextId"] = payload.get("nextId", current["nextId"])
                current["staffAuditLog"] = payload.get("staffAuditLog", current.get("staffAuditLog", []))
                current["stockEntrees"] = payload.get("stockEntrees", current.get("stockEntrees", []))
                current["stockLosses"] = payload.get("stockLosses", current.get("stockLosses", []))

                auth_payload = payload.get("auth", {})
                users_payload = auth_payload.get("users")
                if isinstance(users_payload, list):
                    existing_by_name = {u["username"]: u for u in current["auth"]["users"]}
                    new_users = []
                    for user_data in users_payload:
                        username = str(user_data.get("username", "")).strip()
                        role = str(user_data.get("role", "serveuse"))
                        if username.strip().lower() == "admin":
                            role = "superadmin"
                        if not username or role not in VALID_USER_ROLES:
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
                        if username.strip().lower() == "admin" or role == "superadmin":
                            allowed = list(site_ids)
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

                self._write(current)
                return self.public_state()

            allowed = session_allowed_sites(session, sid_list)
            if not allowed:
                raise ValueError("Session sans maquis autorise.")

            current["ventes"] = merge_scoped_rows(current.get("ventes", []), payload.get("ventes", []), allowed, sid_list)
            current["stock"] = merge_scoped_rows(current.get("stock", []), payload.get("stock", []), allowed, sid_list)
            current["commandes"] = merge_scoped_rows(current.get("commandes", []), payload.get("commandes", []), allowed, sid_list)
            current["stockChecks"] = merge_scoped_rows(current.get("stockChecks", []), payload.get("stockChecks", []), allowed, sid_list)
            current["dayBooks"] = merge_scoped_rows(current.get("dayBooks", []), payload.get("dayBooks", []), allowed, sid_list)
            current["purchaseOrders"] = merge_scoped_rows(current.get("purchaseOrders", []), payload.get("purchaseOrders", []), allowed, sid_list)
            current["supplierPrices"] = merge_scoped_rows(current.get("supplierPrices", []), payload.get("supplierPrices", []), allowed, sid_list)
            current["casiers"] = merge_scoped_rows(current.get("casiers", []), payload.get("casiers", []), allowed, sid_list)
            current["casierMouvements"] = merge_scoped_rows(current.get("casierMouvements", []), payload.get("casierMouvements", []), allowed, sid_list)
            current["creditRecoveries"] = merge_scoped_rows(current.get("creditRecoveries", []), payload.get("creditRecoveries", []), allowed, sid_list)
            current["consignes"] = merge_scoped_rows(current.get("consignes", []), payload.get("consignes", []), allowed, sid_list)
            current["charges"] = merge_scoped_rows(current.get("charges", []), payload.get("charges", []), allowed, sid_list)
            current["staffAuditLog"] = merge_scoped_rows(current.get("staffAuditLog", []), payload.get("staffAuditLog", []), allowed, sid_list)
            current["stockEntrees"] = merge_scoped_rows(current.get("stockEntrees", []), payload.get("stockEntrees", []), allowed, sid_list)
            current["stockLosses"] = merge_scoped_rows(current.get("stockLosses", []), payload.get("stockLosses", []), allowed, sid_list)

            if "pdjWorkDateBySite" in payload:
                current["pdjWorkDateBySite"] = _merge_pdj_work_date_map_session(
                    current.get("pdjWorkDateBySite"),
                    payload.get("pdjWorkDateBySite"),
                    set(allowed),
                    sid_list,
                )

            aid = payload.get("activeSiteId", current.get("activeSiteId"))
            if aid in site_ids and str(aid) in allowed:
                current["activeSiteId"] = aid
            elif str(current.get("activeSiteId", "")) not in allowed:
                current["activeSiteId"] = sorted(allowed)[0]

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

            self._write(current)
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

    def list_backups(self) -> dict[str, Any]:
        BACKUP_DIR.mkdir(parents=True, exist_ok=True)
        json_rows: list[dict[str, Any]] = []
        sqlite_rows: list[dict[str, Any]] = []
        for p in sorted(BACKUP_DIR.glob("data-*.json"), key=lambda x: x.name, reverse=True):
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
            "storageMode": "sqlite" if self._sqlite_enabled else "json",
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
        ):
            sessions.invalidate_all_for_username(un)


class AppHandler(BaseHTTPRequestHandler):
    server_version = "MaquisManagerServer/1.0"

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
            role = session["role"]
            allowed = list(session.get("allowedSiteIds") or [])
            if str(session.get("username", "")).strip().lower() == "admin":
                role = "superadmin"
                with store._lock:
                    allowed = [s["id"] for s in store._state["sites"]]
            elif str(role) == "superadmin":
                with store._lock:
                    allowed = [s["id"] for s in store._state["sites"]]
            self.send_json(
                HTTPStatus.OK,
                {
                    "authenticated": True,
                    "username": session["username"],
                    "role": role,
                    "allowedSiteIds": allowed,
                    **session_timing_fields(session),
                },
            )
            return
        if get_path == "/api/admin/backups":
            session = self.require_session()
            if session is None:
                return
            if not session_is_superadmin(session):
                self.send_json(HTTPStatus.FORBIDDEN, {"error": "Acces refuse."})
                return
            with store._lock:
                payload = store.list_backups()
            self.send_json(HTTPStatus.OK, payload, cache_control="no-store")
            return
        if get_path == "/api/changes":
            session = self.require_session()
            if session is None:
                return
            since = str((query.get("since") or [""])[0]).strip()
            site_id = str((query.get("siteId") or [""])[0]).strip() or None
            if site_id and not session_is_superadmin(session) and site_id not in (session.get("allowedSiteIds") or []):
                self.send_json(HTTPStatus.FORBIDDEN, {"error": "Maquis non autorise pour cette session."})
                return
            self.send_json(HTTPStatus.OK, store.changes(since=since, site_id=site_id, session=session), cache_control="no-store")
            return
        if get_path == "/api/state":
            session = self.require_session()
            if session is None:
                return
            etag = session_state_etag(store.etag(), session)
            if self.headers.get("If-None-Match") == etag:
                self.send_not_modified(etag)
                return
            self.send_json(HTTPStatus.OK, store.public_state_for_session(session), etag=etag, cache_control="no-cache")
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
            if not session_is_superadmin(session):
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
            if not session_is_superadmin(session):
                self.send_json(HTTPStatus.FORBIDDEN, {"error": "Acces refuse."})
                return
            body = self.read_json()
            bf = str((body or {}).get("backupFile", "")).strip()
            site_raw = str((body or {}).get("siteId", "")).strip()
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
        if post_path == "/api/public/order":
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
            with store._lock:
                user_data = next((u for u in store._state["auth"]["users"] if u["username"] == username), None)
                has_2fa = bool(user_data and user_data.get("twoFactorEnabled") and user_data.get("twoFactorSecret"))
            if REQUIRE_2FA_FOR_PRIVILEGED and privileged_role_requires_2fa_policy(user["role"]) and not has_2fa:
                audit_log(
                    "login_denied_2fa_required",
                    {"ip": ip, "username": username, "role": user.get("role", "")},
                )
                self.send_json(
                    HTTPStatus.FORBIDDEN,
                    {
                        "error": "La double authentification (2FA) est obligatoire pour les comptes administrateur. Activez le 2FA sur ce compte (ou désactivez temporairement MAQUIS_MANAGER_REQUIRE_2FA_ADMINS sur le serveur).",
                    },
                    cache_control="no-store",
                )
                return
            login_rate_limit_success(ip, username)
            audit_log("login_success", {"ip": ip, "username": username})
            if has_2fa:
                pre_auth = create_pre_auth_token(username)
                self.send_json(HTTPStatus.OK, {"needsTwoFactor": True, "preAuthToken": pre_auth})
                return
            token = sessions.create(user["username"], user["role"], user["allowedSiteIds"])
            sess_view = sessions.get(token) or {}
            self.send_json(
                HTTPStatus.OK,
                {
                    "authenticated": True,
                    "username": user["username"],
                    "role": user["role"],
                    "allowedSiteIds": user["allowedSiteIds"],
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
                    allowed = list(all_site_ids)
            token = sessions.create(username, role, allowed)
            sess_view = sessions.get(token) or {}
            self.send_json(
                HTTPStatus.OK,
                {
                    "authenticated": True,
                    "username": username,
                    "role": role,
                    "allowedSiteIds": allowed,
                    **session_timing_fields(sess_view),
                },
                cookie=token,
            )
            return

        if post_path == "/api/2fa/setup":
            session = self.require_session()
            if session is None:
                return
            payload = self.read_json()
            target = str(payload.get("username", session["username"])).strip()
            with store._lock:
                auth_users = list(store._state["auth"]["users"])
            if target != session["username"] and not session_may_configure_2fa_for_other(session, target, auth_users):
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
            payload = self.read_json()
            target = str(payload.get("username", session["username"])).strip()
            code = str(payload.get("code", "")).strip()
            with store._lock:
                auth_users = list(store._state["auth"]["users"])
            if target != session["username"] and not session_may_configure_2fa_for_other(session, target, auth_users):
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
            payload = self.read_json()
            target = str(payload.get("username", session["username"])).strip()
            with store._lock:
                auth_users = list(store._state["auth"]["users"])
            if target != session["username"] and not session_may_configure_2fa_for_other(session, target, auth_users):
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

        if post_path == "/api/logout":
            token = self.session_token()
            sess = sessions.get(token)
            if sess:
                audit_log("logout", {"ip": self.client_ip(), "username": str(sess.get("username", ""))})
            sessions.clear(token)
            self.send_json(HTTPStatus.OK, {"authenticated": False}, clear_cookie=True)
            return

        if post_path == "/api/reset":
            session = self.require_session()
            if session is None:
                return
            if not session_is_superadmin(session):
                self.send_json(HTTPStatus.FORBIDDEN, {"error": "Seul le super administrateur peut reinitialiser l'application."})
                return
            payload = store.reset()
            self.send_json(HTTPStatus.OK, payload)
            return

        if post_path == "/api/purge-maquis":
            session = self.require_session()
            if session is None:
                return
            if not session_is_superadmin(session):
                self.send_json(HTTPStatus.FORBIDDEN, {"error": "Seul le super administrateur peut purger un maquis."})
                return
            body = self.read_json()
            target = str((body or {}).get("siteId", "")).strip()
            keep_cat = bool((body or {}).get("keepStockCatalog"))
            try:
                payload = store.purge_maquis_data(target, keep_stock_catalog=keep_cat)
            except ValueError as error:
                self.send_json(HTTPStatus.BAD_REQUEST, {"error": str(error)})
                return
            self.send_json(HTTPStatus.OK, payload)
            return

        if post_path.startswith("/api"):
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
            session = self.require_session()
            if session is None:
                return
            payload = self.read_json()
            try:
                updated = store.update_state(payload, session)
            except ValueError as error:
                self.send_json(HTTPStatus.BAD_REQUEST, {"error": str(error)})
                return
            audit_log(
                "state_put",
                {
                    "ip": self.client_ip(),
                    "username": str(session.get("username", "")),
                    "role": str(session.get("role", "")),
                    "sections": sorted(str(k) for k in (payload or {}).keys()),
                },
            )
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
                f"{SESSION_COOKIE}={cookie}; Path=/; HttpOnly; SameSite=Lax; Max-Age={SESSION_ABSOLUTE_SECONDS}",
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

    print(f"Maquis Manager server running on http://127.0.0.1:{bound_port}")
    print(f"Storage mode: {STORAGE_MODE}")
    print(f"Sauvegardes automatiques dans {BACKUP_DIR} (garder jusqu'a {BACKUP_KEEP_COUNT} fichiers par type)")
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
