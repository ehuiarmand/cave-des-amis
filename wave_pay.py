"""Paiement Wave Checkout (API Wave Business) pour les commandes QR.

Configuration (variables d'environnement, jamais en dur). Chaque maquis a son propre
compte Wave : suffixez la variable par l'id du maquis en MAJUSCULES, caractères non
alphanumériques remplacés par « _ » (maquis-1 → __MAQUIS_1, NO-STRESS → __NO_STRESS) :
- WAVE_API_KEY__<SITE>            clé API Wave Business (Bearer) — active le mode « checkout »
- WAVE_WEBHOOK_SECRET__<SITE>     secret de signature du webhook (wave_sn_WHS_...) — recommandé
- WAVE_WEBHOOK_SHARED_SECRET__<SITE>  alternative : secret partagé « Authorization: Bearer »
- WAVE_SIGNING_SECRET__<SITE>     optionnel : signature des requêtes sortantes (wave_sn_AKS_...)
- WAVE_MERCHANT_URL__<SITE>       optionnel : lien du QR marchand statique (repli sans API)
Sans suffixe, la variable vaut pour les maquis qui n'ont AUCUNE variable suffixée (un maquis
configuré n'hérite jamais des valeurs globales : l'argent irait sur un autre compte).
Communs : WAVE_PUBLIC_BASE_URL (URL publique HTTPS du serveur), WAVE_CURRENCY (XOF),
MAQUIS_WAVE_STORE (registre des paiements, défaut wave_payments.json).

Les paiements sont tenus dans un fichier séparé de data.json : les commandes sont
remplacées à chaque synchro staff (merge_commandes_scoped), une marque posée dessus
serait donc perdue.
"""
from __future__ import annotations

import hashlib
import hmac
import json
import os
import re
import threading
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

WAVE_API_BASE = "https://api.wave.com"
SIGNATURE_TOLERANCE_SECONDS = 5 * 60
MAX_EVENT_IDS = 1000
MAX_SESSIONS = 5000
SITE_KEYS = ("WAVE_API_KEY", "WAVE_WEBHOOK_SECRET", "WAVE_WEBHOOK_SHARED_SECRET", "WAVE_SIGNING_SECRET", "WAVE_MERCHANT_URL")


class WaveError(Exception):
    """Erreur d'appel à l'API Wave (message générique, détail dans `code`)."""

    def __init__(self, message: str, code: str = "", status: int = 0) -> None:
        super().__init__(message)
        self.code = code
        self.status = status


def _env(name: str) -> str:
    return os.environ.get(name, "").strip()


def site_env_suffix(site_id: str) -> str:
    """maquis-1 → MAQUIS_1 ; NO-STRESS → NO_STRESS."""
    return re.sub(r"[^A-Z0-9]", "_", str(site_id or "").upper())


def site_config(site_id: str) -> dict[str, str]:
    """Config Wave d'un maquis : variables suffixées si le maquis en a au moins une, sinon globales."""
    suffix = site_env_suffix(site_id)
    own = {k: _env(f"{k}__{suffix}") for k in SITE_KEYS} if suffix else {}
    if any(own.values()):
        return own
    return {k: _env(k) for k in SITE_KEYS}


def _all_configs() -> list[dict[str, str]]:
    """Toutes les configs présentes (globale + chaque suffixe), pour authentifier un webhook."""
    suffixes = {name.split("__", 1)[1] for name in os.environ if name.startswith(SITE_KEYS) and "__" in name}
    configs = [{k: _env(k) for k in SITE_KEYS}]
    configs.extend({k: _env(f"{k}__{s}") for k in SITE_KEYS} for s in sorted(suffixes))
    return configs


def public_base_url() -> str:
    return _env("WAVE_PUBLIC_BASE_URL").rstrip("/")


def checkout_enabled(site_id: str) -> bool:
    """Mode API : clé du maquis présente et URL publique HTTPS (exigée par Wave pour les retours)."""
    return bool(site_config(site_id)["WAVE_API_KEY"]) and public_base_url().startswith("https://")


def merchant_url(site_id: str) -> str:
    url = site_config(site_id)["WAVE_MERCHANT_URL"]
    return url if url.startswith("https://") else ""


def currency() -> str:
    return (_env("WAVE_CURRENCY") or "XOF").upper()


def public_info(site_id: str) -> dict[str, Any]:
    """Ce que le front public peut savoir de la config du maquis (aucun secret)."""
    if checkout_enabled(site_id):
        return {"mode": "checkout"}
    if merchant_url(site_id):
        return {"mode": "merchant", "merchantUrl": merchant_url(site_id)}
    return {"mode": None}


def amount_to_wave(amount: float) -> str:
    """Montant au format Wave : chaîne entière pour XOF (pas de décimales autorisées)."""
    value = int(round(float(amount or 0)))
    if value <= 0:
        raise ValueError("Montant invalide.")
    return str(value)


def _signature(secret: str, timestamp: str, raw_body: bytes) -> str:
    return hmac.new(secret.encode("utf-8"), timestamp.encode("utf-8") + raw_body, hashlib.sha256).hexdigest()


def sign_request(secret: str, raw_body: bytes, timestamp: int | None = None) -> str:
    """En-tête Wave-Signature pour une requête sortante (signature optionnelle de clé API)."""
    ts = str(int(timestamp if timestamp is not None else time.time()))
    return f"t={ts},v1={_signature(secret, ts, raw_body)}"


def verify_webhook_signature(secret: str, header: str, raw_body: bytes, now: float | None = None) -> bool:
    """Vérifie `Wave-Signature: t=<ts>,v1=<hex>[,v1=...]` = HMAC-SHA256(secret, ts + corps brut)."""
    if not secret or not header:
        return False
    timestamp = ""
    candidates: list[str] = []
    for part in header.split(","):
        key, _, value = part.strip().partition("=")
        if key == "t":
            timestamp = value.strip()
        elif key == "v1" and value.strip():
            candidates.append(value.strip().lower())
    if not timestamp.isdigit() or not candidates:
        return False
    current = time.time() if now is None else now
    if abs(current - int(timestamp)) > SIGNATURE_TOLERANCE_SECONDS:
        return False
    expected = _signature(secret, timestamp, raw_body)
    return any(hmac.compare_digest(expected, c) for c in candidates)


def _verify_with(cfg: dict[str, str], headers: Any, raw_body: bytes) -> bool:
    signing = cfg.get("WAVE_WEBHOOK_SECRET", "")
    if signing:
        return verify_webhook_signature(signing, str(headers.get("Wave-Signature") or ""), raw_body)
    shared = cfg.get("WAVE_WEBHOOK_SHARED_SECRET", "")
    if shared:
        auth = str(headers.get("Authorization") or "")
        got = auth[7:].strip() if auth.lower().startswith("bearer ") else ""
        return bool(got) and hmac.compare_digest(shared, got)
    return False


def verify_webhook_request(headers: Any, raw_body: bytes, site_id: str | None = None) -> bool:
    """Avec site_id : uniquement le secret de ce maquis. Sans : n'importe quel secret configuré."""
    configs = [site_config(site_id)] if site_id is not None else _all_configs()
    return any(_verify_with(cfg, headers, raw_body) for cfg in configs)


def webhook_configured() -> bool:
    return any(c["WAVE_WEBHOOK_SECRET"] or c["WAVE_WEBHOOK_SHARED_SECRET"] for c in _all_configs())


def _api_call(site_id: str, method: str, path: str, payload: dict[str, Any] | None = None, timeout: int = 15) -> dict[str, Any]:
    cfg = site_config(site_id)
    api_key = cfg["WAVE_API_KEY"]
    if not api_key:
        raise WaveError("Paiement Wave non configuré.", "not-configured")
    raw = json.dumps(payload, separators=(",", ":")).encode("utf-8") if payload is not None else b""
    headers = {"Authorization": f"Bearer {api_key}", "Accept": "application/json"}
    if payload is not None:
        headers["Content-Type"] = "application/json"
    if cfg["WAVE_SIGNING_SECRET"]:
        headers["Wave-Signature"] = sign_request(cfg["WAVE_SIGNING_SECRET"], raw)
    req = Request(WAVE_API_BASE + path, data=raw if payload is not None else None, headers=headers, method=method)
    try:
        with urlopen(req, timeout=timeout) as resp:
            return json.loads(resp.read().decode("utf-8") or "{}")
    except HTTPError as exc:
        code = ""
        try:
            code = str(json.loads(exc.read().decode("utf-8") or "{}").get("code") or "")
        except (ValueError, UnicodeDecodeError):
            pass
        raise WaveError("Wave a refusé la demande de paiement.", code, exc.code) from exc
    except (URLError, TimeoutError, OSError) as exc:
        raise WaveError("Wave est injoignable pour le moment.", "network") from exc


def create_checkout_session(site_id: str, amount: str, client_reference: str, success_url: str, error_url: str) -> dict[str, Any]:
    return _api_call(site_id, "POST", "/v1/checkout/sessions", {
        "amount": amount,
        "currency": currency(),
        "client_reference": client_reference[:255],
        "success_url": success_url,
        "error_url": error_url,
    })


def retrieve_checkout_session(site_id: str, session_id: str) -> dict[str, Any]:
    safe = "".join(ch for ch in str(session_id) if ch.isalnum() or ch in "-_")
    if not safe:
        raise WaveError("Session Wave invalide.", "invalid-id")
    return _api_call(site_id, "GET", f"/v1/checkout/sessions/{safe}")


def _parse_iso(value: Any) -> float:
    try:
        return datetime.fromisoformat(str(value).replace("Z", "+00:00")).timestamp()
    except (TypeError, ValueError):
        return 0.0


def _now_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


class WavePaymentStore:
    """Registre JSON des sessions Wave : {"sessions": {id: record}, "events": [ids]}."""

    def __init__(self, path: Path) -> None:
        self.path = Path(path)
        self._lock = threading.Lock()
        self._data = self._load()

    def _load(self) -> dict[str, Any]:
        try:
            data = json.loads(self.path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            data = {}
        if not isinstance(data, dict):
            data = {}
        if not isinstance(data.get("sessions"), dict):
            data["sessions"] = {}
        if not isinstance(data.get("events"), list):
            data["events"] = []
        return data

    def _save(self) -> None:
        sessions = self._data["sessions"]
        if len(sessions) > MAX_SESSIONS:
            # Purge les sessions non payées les plus anciennes ; les paiements réussis restent.
            stale = sorted(
                (k for k, v in sessions.items() if v.get("paymentStatus") != "succeeded"),
                key=lambda k: str(sessions[k].get("createdAt") or ""),
            )
            for key in stale[: len(sessions) - MAX_SESSIONS]:
                sessions.pop(key, None)
        self._data["events"] = self._data["events"][-MAX_EVENT_IDS:]
        tmp = self.path.with_suffix(self.path.suffix + ".tmp")
        tmp.write_text(json.dumps(self._data, ensure_ascii=False, indent=1), encoding="utf-8")
        os.replace(tmp, self.path)

    def reusable_session(self, site_id: str, order_id: int, amount: str) -> dict[str, Any] | None:
        """Session encore ouverte pour la même commande et le même montant (évite les doublons)."""
        limit = time.time() + 120
        with self._lock:
            for rec in self._data["sessions"].values():
                if (
                    rec.get("siteId") == site_id
                    and int(rec.get("orderId") or -1) == order_id
                    and rec.get("amount") == amount
                    and rec.get("checkoutStatus") == "open"
                    and rec.get("paymentStatus") not in ("succeeded", "cancelled")
                    and _parse_iso(rec.get("whenExpires")) > limit
                    and rec.get("launchUrl")
                ):
                    return dict(rec)
        return None

    def add_session(self, site_id: str, order_id: int, amount: str, reference: str, session: dict[str, Any]) -> dict[str, Any]:
        rec = {
            "id": str(session.get("id") or ""),
            "siteId": site_id,
            "orderId": order_id,
            "amount": amount,
            "currency": str(session.get("currency") or currency()),
            "clientReference": reference,
            "launchUrl": str(session.get("wave_launch_url") or ""),
            "checkoutStatus": str(session.get("checkout_status") or "open"),
            "paymentStatus": str(session.get("payment_status") or "processing"),
            "whenExpires": str(session.get("when_expires") or ""),
            "createdAt": _now_iso(),
            "transactionId": None,
            "paidAt": None,
        }
        if not rec["id"] or not rec["launchUrl"].startswith("https://"):
            raise WaveError("Réponse Wave invalide.", "invalid-response")
        with self._lock:
            self._data["sessions"][rec["id"]] = rec
            self._save()
        return dict(rec)

    def get_session(self, session_id: str) -> dict[str, Any] | None:
        with self._lock:
            rec = self._data["sessions"].get(str(session_id or ""))
            return dict(rec) if rec else None

    def seen_event(self, event_id: str) -> bool:
        """True si l'événement a déjà été traité ; sinon le mémorise (anti-doublon webhook)."""
        if not event_id:
            return False
        with self._lock:
            if event_id in self._data["events"]:
                return True
            self._data["events"].append(event_id)
            self._save()
        return False

    def apply_session_update(self, session: dict[str, Any]) -> tuple[dict[str, Any] | None, bool]:
        """Met à jour une session connue depuis l'objet Wave (webhook ou relecture API).

        Renvoie (record, devenu_payé). Refuse une session inconnue ou dont le montant,
        la devise ou la référence ne correspondent pas à ce que le serveur a créé."""
        session_id = str(session.get("id") or "")
        with self._lock:
            rec = self._data["sessions"].get(session_id)
            if rec is None:
                return None, False
            if (
                str(session.get("amount") or "") != rec.get("amount")
                or str(session.get("currency") or "").upper() != str(rec.get("currency") or "").upper()
                or str(session.get("client_reference") or "") != rec.get("clientReference")
            ):
                return None, False
            was_paid = rec.get("paymentStatus") == "succeeded"
            rec["checkoutStatus"] = str(session.get("checkout_status") or rec.get("checkoutStatus"))
            if not was_paid:
                rec["paymentStatus"] = str(session.get("payment_status") or rec.get("paymentStatus"))
            if session.get("transaction_id"):
                rec["transactionId"] = str(session.get("transaction_id"))
            became_paid = not was_paid and rec["paymentStatus"] == "succeeded"
            if became_paid:
                rec["paidAt"] = str(session.get("when_completed") or _now_iso())
            self._save()
            return dict(rec), became_paid

    def open_sessions_for_order(self, site_id: str, order_id: int) -> list[str]:
        with self._lock:
            return [
                k for k, v in self._data["sessions"].items()
                if v.get("siteId") == site_id and int(v.get("orderId") or -1) == order_id
                and v.get("paymentStatus") not in ("succeeded", "cancelled")
                and v.get("checkoutStatus") == "open"
            ]

    def order_summary(self, site_id: str, order_id: int) -> dict[str, Any]:
        return self.site_summaries(site_id).get(order_id) or {"paidAmount": 0, "payments": []}

    def site_summaries(self, site_id: str) -> dict[int, dict[str, Any]]:
        """{orderId: {paidAmount, payments:[{amount, transactionId, paidAt}]}} — paiements réussis uniquement."""
        out: dict[int, dict[str, Any]] = {}
        with self._lock:
            for rec in self._data["sessions"].values():
                if rec.get("siteId") != site_id or rec.get("paymentStatus") != "succeeded":
                    continue
                oid = int(rec.get("orderId") or -1)
                row = out.setdefault(oid, {"paidAmount": 0, "payments": []})
                row["paidAmount"] += int(rec.get("amount") or 0)
                row["payments"].append({
                    "amount": int(rec.get("amount") or 0),
                    "transactionId": rec.get("transactionId"),
                    "paidAt": rec.get("paidAt"),
                })
        return out
