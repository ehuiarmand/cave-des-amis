#!/usr/bin/env python3
"""Regression: le SSO portail doit etre fail-closed tant qu'aucun secret propre
n'est configure, sinon un token signe avec le secret par defaut (public dans le
depot) permettrait d'usurper n'importe quel compte, y compris admin, via /sso.

Lancer : python3 tests/test_sso_fail_closed.py
"""

import base64
import hashlib
import hmac
import importlib
import json
import os
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

DEFAULT_SECRET = "portail-sso-dev-secret-change-in-production"


def _forge(secret, username="admin", role="superadmin"):
    payload = {
        "app": "cave",
        "username": username,
        "role": role,
        "allowedSiteIds": ["maquis-1"],
        "exp": int(time.time()) + 3600,
    }
    raw = base64.urlsafe_b64encode(json.dumps(payload).encode()).decode().rstrip("=")
    sig = hmac.new(secret.encode(), raw.encode(), hashlib.sha256).hexdigest()
    return raw + "." + sig


def _reload_server(secret_env):
    if secret_env is None:
        os.environ.pop("PORTAL_SSO_SECRET", None)
    else:
        os.environ["PORTAL_SSO_SECRET"] = secret_env
    import server
    return importlib.reload(server)


def main():
    failures = []

    # 1. Secret par defaut (public) -> SSO desarme, token forge refuse.
    server = _reload_server(None)
    if server.PORTAL_SSO_CONFIGURED:
        failures.append("PORTAL_SSO_CONFIGURED devrait etre False avec le secret par defaut")
    if server._verify_portal_sso_token(_forge(DEFAULT_SECRET)) is not None:
        failures.append("un token forge avec le secret par defaut ne doit PAS etre accepte")

    # 2. Secret propre configure -> SSO actif et token legitime accepte.
    server = _reload_server("un-vrai-secret-robuste-123")
    if not server.PORTAL_SSO_CONFIGURED:
        failures.append("PORTAL_SSO_CONFIGURED devrait etre True avec un secret propre")
    good = server._verify_portal_sso_token(_forge("un-vrai-secret-robuste-123"))
    if good is None or good.get("username") != "admin":
        failures.append("un token legitime signe avec le secret configure doit etre accepte")

    # 3. Attaquant ne connaissant que l'ancien secret par defaut -> refuse.
    if server._verify_portal_sso_token(_forge(DEFAULT_SECRET)) is not None:
        failures.append("un token forge avec l'ancien secret par defaut ne doit PAS passer contre un secret propre")

    if failures:
        print("ECHEC:")
        for f in failures:
            print("  -", f)
        sys.exit(1)
    print("OK: SSO fail-closed verifie (3 cas)")


if __name__ == "__main__":
    main()
