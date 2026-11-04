"""Paiement Wave : signature webhook, montant recalculé côté serveur, registre des paiements."""
from __future__ import annotations

import json
import os
import sys
import tempfile
import threading
import time
import unittest
from http.client import HTTPConnection
from http.server import ThreadingHTTPServer
from pathlib import Path
from unittest import mock

os.environ.setdefault("MAQUIS_MANAGER_STORAGE", "memory")
os.environ.setdefault("MAQUIS_MANAGER_SKIP_AUTO_CLOTURE", "1")

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

import server  # noqa: E402
import wave_pay  # noqa: E402

SECRET = "wave_sn_WHS_test_secret"
SITE = "site-wave-test"
ORDER_ID = 987654


def fake_session(session_id="cos-test1", amount="2500", ref="", status="open", pay="processing"):
    return {
        "id": session_id,
        "amount": amount,
        "currency": "XOF",
        "client_reference": ref,
        "checkout_status": status,
        "payment_status": pay,
        "wave_launch_url": f"https://pay.wave.com/c/{session_id}",
        "when_expires": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(time.time() + 1800)),
        "transaction_id": "TXN1" if pay == "succeeded" else None,
    }


class SignatureTests(unittest.TestCase):
    def test_roundtrip_and_rejections(self):
        body = b'{"id":"EV_1","type":"checkout.session.completed"}'
        header = wave_pay.sign_request(SECRET, body)
        self.assertTrue(wave_pay.verify_webhook_signature(SECRET, header, body))
        self.assertFalse(wave_pay.verify_webhook_signature(SECRET, header, body + b" "))
        self.assertFalse(wave_pay.verify_webhook_signature("autre", header, body))
        old = wave_pay.sign_request(SECRET, body, timestamp=int(time.time()) - 600)
        self.assertFalse(wave_pay.verify_webhook_signature(SECRET, old, body))
        self.assertFalse(wave_pay.verify_webhook_signature(SECRET, "", body))
        self.assertFalse(wave_pay.verify_webhook_signature(SECRET, "t=abc,v1=00", body))

    def test_rotation_accepts_any_v1(self):
        body = b"{}"
        good = wave_pay.sign_request(SECRET, body)
        ts, v1 = good.split(",")
        self.assertTrue(wave_pay.verify_webhook_signature(SECRET, f"{ts},v1=deadbeef,{v1}", body))

    def test_amount_format_xof(self):
        self.assertEqual(wave_pay.amount_to_wave(2500.0), "2500")
        self.assertEqual(wave_pay.amount_to_wave(1499.6), "1500")
        with self.assertRaises(ValueError):
            wave_pay.amount_to_wave(0)


class SiteConfigTests(unittest.TestCase):
    def test_each_site_uses_its_own_account(self):
        env = {
            "WAVE_MERCHANT_URL": "https://pay.wave.com/m/M_global/c/ci/",
            "WAVE_MERCHANT_URL__MAQUIS_1": "https://pay.wave.com/m/M_un/c/ci/",
            "WAVE_API_KEY__MAQUIS_3": "cle_trois",
            "WAVE_PUBLIC_BASE_URL": "https://maquis.example",
        }
        with mock.patch.dict(os.environ, env, clear=True):
            self.assertEqual(wave_pay.site_env_suffix("NO-STRESS"), "NO_STRESS")
            self.assertEqual(wave_pay.public_info("maquis-1"), {"mode": "merchant", "merchantUrl": "https://pay.wave.com/m/M_un/c/ci/"})
            self.assertEqual(wave_pay.public_info("maquis-3"), {"mode": "checkout"})
            # maquis-3 a sa propre config : il n'hérite pas du lien global.
            self.assertEqual(wave_pay.merchant_url("maquis-3"), "")
            # Maquis sans variable suffixée : valeurs globales.
            self.assertEqual(wave_pay.merchant_url("NO-STRESS"), "https://pay.wave.com/m/M_global/c/ci/")

    def test_webhook_secret_is_per_site(self):
        body = b"{}"
        env = {"WAVE_WEBHOOK_SECRET__MAQUIS_1": "secret_un", "WAVE_WEBHOOK_SECRET__MAQUIS_3": "secret_trois"}
        with mock.patch.dict(os.environ, env, clear=True):
            sig = {"Wave-Signature": wave_pay.sign_request("secret_trois", body)}
            self.assertTrue(wave_pay.webhook_configured())
            self.assertTrue(wave_pay.verify_webhook_request(sig, body))
            self.assertTrue(wave_pay.verify_webhook_request(sig, body, "maquis-3"))
            self.assertFalse(wave_pay.verify_webhook_request(sig, body, "maquis-1"))


class StoreTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.store = wave_pay.WavePaymentStore(Path(self.tmp.name) / "wave.json")

    def tearDown(self):
        self.tmp.cleanup()

    def test_update_requires_matching_amount_and_reference(self):
        self.store.add_session(SITE, ORDER_ID, "2500", "ref-1", fake_session(ref="ref-1"))
        rec, paid = self.store.apply_session_update(fake_session(amount="100", ref="ref-1", status="complete", pay="succeeded"))
        self.assertIsNone(rec)
        self.assertFalse(paid)
        rec, paid = self.store.apply_session_update(fake_session(ref="ref-1", status="complete", pay="succeeded"))
        self.assertTrue(paid)
        self.assertEqual(self.store.order_summary(SITE, ORDER_ID)["paidAmount"], 2500)
        # Rejoué : pas de double comptage.
        _, paid_again = self.store.apply_session_update(fake_session(ref="ref-1", status="complete", pay="succeeded"))
        self.assertFalse(paid_again)
        self.assertEqual(self.store.order_summary(SITE, ORDER_ID)["paidAmount"], 2500)

    def test_persisted_and_dedup_events(self):
        self.store.add_session(SITE, ORDER_ID, "2500", "ref-1", fake_session(ref="ref-1"))
        self.assertFalse(self.store.seen_event("EV_1"))
        self.assertTrue(self.store.seen_event("EV_1"))
        reloaded = wave_pay.WavePaymentStore(self.store.path)
        self.assertIsNotNone(reloaded.reusable_session(SITE, ORDER_ID, "2500"))
        self.assertIsNone(reloaded.reusable_session(SITE, ORDER_ID, "3000"))


class HttpTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory()
        cls.env = mock.patch.dict(os.environ, {
            "WAVE_API_KEY": "wave_test_key",
            "WAVE_PUBLIC_BASE_URL": "https://maquis.example",
            "WAVE_WEBHOOK_SECRET": SECRET,
        })
        cls.env.start()
        cls.store_patch = mock.patch.object(server, "wave_store", wave_pay.WavePaymentStore(Path(cls.tmp.name) / "wave.json"))
        cls.store_patch.start()
        with server.store._lock:
            server.store._state.setdefault("sites", []).append({"id": SITE, "nom": "Maquis Test"})
            server.store._state.setdefault("commandes", []).insert(0, {
                "id": ORDER_ID, "siteId": SITE, "client": "KOFFI", "table": "Table 4", "status": "En attente",
                "source": "qr", "date": "2026-11-04",
                "lignes": [
                    {"article": "Bière", "qty": 2, "prix": 1000, "remise": 0},
                    {"article": "Soda", "qty": 1, "prix": 500, "remise": 0},
                ],
            })
        cls.httpd = ThreadingHTTPServer(("127.0.0.1", 0), server.AppHandler)
        cls.port = cls.httpd.server_address[1]
        threading.Thread(target=cls.httpd.serve_forever, daemon=True).start()

    @classmethod
    def tearDownClass(cls):
        cls.httpd.shutdown()
        cls.httpd.server_close()
        with server.store._lock:
            server.store._state["commandes"] = [o for o in server.store._state["commandes"] if o.get("id") != ORDER_ID]
            server.store._state["sites"] = [s for s in server.store._state["sites"] if s.get("id") != SITE]
        cls.store_patch.stop()
        cls.env.stop()
        cls.tmp.cleanup()

    def request(self, method, path, body=b"", headers=None):
        conn = HTTPConnection("127.0.0.1", self.port, timeout=10)
        conn.request(method, path, body=body, headers=headers or {})
        resp = conn.getresponse()
        data = resp.read()
        conn.close()
        return resp, data

    def test_checkout_amount_comes_from_server(self):
        created = {}

        def fake_create(site_id, amount, ref, success_url, error_url):
            created.update(amount=amount, ref=ref, success=success_url)
            return fake_session(session_id="cos-http1", amount=amount, ref=ref)

        with mock.patch.object(wave_pay, "create_checkout_session", side_effect=fake_create):
            body = json.dumps({
                "siteId": SITE, "orderId": ORDER_ID, "table": "Table 4", "client": "KOFFI", "amount": 1,
            }).encode()
            resp, data = self.request("POST", "/api/public/wave/checkout", body, {"Content-Type": "application/json"})
        self.assertEqual(resp.status, 200, data)
        self.assertEqual(json.loads(data)["url"], "https://pay.wave.com/c/cos-http1")
        self.assertEqual(created["amount"], "2500")  # 2×1000 + 500, le "amount" client est ignoré
        self.assertTrue(created["success"].startswith("https://maquis.example/order.html?"))

    def test_checkout_rejects_other_client(self):
        body = json.dumps({"siteId": SITE, "orderId": ORDER_ID, "table": "Table 4", "client": "AUTRE"}).encode()
        resp, _ = self.request("POST", "/api/public/wave/checkout", body, {"Content-Type": "application/json"})
        self.assertEqual(resp.status, 404)

    def test_ticket_form_requires_token(self):
        resp, _ = self.request(
            "POST", "/wave/pay", f"site={SITE}&order={ORDER_ID}&t=faux".encode(),
            {"Content-Type": "application/x-www-form-urlencoded"},
        )
        self.assertEqual(resp.status, 403)

    def test_webhook_signed_marks_paid(self):
        ref = f"{SITE}:{ORDER_ID}:hook"
        server.wave_store.add_session(SITE, ORDER_ID, "2500", ref, fake_session(session_id="cos-hook", ref=ref))
        event = {"id": "EV_hook", "type": "checkout.session.completed",
                 "data": fake_session(session_id="cos-hook", ref=ref, status="complete", pay="succeeded")}
        raw = json.dumps(event).encode()
        resp, _ = self.request("POST", "/api/wave/webhook", raw, {"Wave-Signature": "t=1,v1=00"})
        self.assertEqual(resp.status, 401)
        resp, _ = self.request("POST", "/api/wave/webhook", raw, {"Wave-Signature": wave_pay.sign_request(SECRET, raw)})
        self.assertEqual(resp.status, 200)
        self.assertGreaterEqual(server.wave_store.order_summary(SITE, ORDER_ID)["paidAmount"], 2500)
        resp, data = self.request("POST", "/api/wave/webhook", raw, {"Wave-Signature": wave_pay.sign_request(SECRET, raw)})
        self.assertTrue(json.loads(data).get("duplicate"))


if __name__ == "__main__":
    unittest.main()
