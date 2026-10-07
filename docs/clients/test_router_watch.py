"""Tests for the Python reference client: python3 -m unittest discover -s docs/clients"""
import json
import threading
import time
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import router_watch as rw


def document(revision, *, accepting=True, night=True, night_available=True, offline=False):
    models = [{"id": "day-model", "aliases": ["local-active", "daytime"], "available": accepting,
               "slots": 1, "context_window": 163840, "metadata": {"context_safety_reserve": 1024}}]
    ids = {"day-model": "day-model", "local-active": "day-model", "daytime": "day-model"}
    if night:
        models.append({"id": "night-model", "aliases": ["nighttime"], "available": accepting and night_available,
                       "slots": 1, "context_window": 98304, "metadata": {"context_safety_reserve": 1024}})
        ids.update({"night-model": "night-model", "nighttime": "night-model"})
    return {"object": "router.capabilities", "schema_version": 1, "revision": revision,
            "router": {"accepting_requests": accepting}, "models": models, "ids": ids,
            "offline_services": [{"model": "night-model", "aliases": ["nighttime"]}] if offline else []}


class Router(BaseHTTPRequestHandler):
    docs = []

    def log_message(self, *args):
        pass

    def do_GET(self):
        current = self.docs[-1]
        if self.path == "/v1/router/capabilities":
            etag = '"%s"' % current["revision"]
            if self.headers.get("If-None-Match") == etag:
                self.send_response(304); self.send_header("ETag", etag); self.end_headers(); return
            body = json.dumps(current).encode()
            self.send_response(200); self.send_header("ETag", etag)
            self.send_header("Content-Length", str(len(body))); self.end_headers(); self.wfile.write(body)
        elif self.path == "/v1/router/events":
            self.send_response(200); self.send_header("Content-Type", "text/event-stream"); self.end_headers()
            self.wfile.write(b"retry: 1000\n\n: keepalive\n\n")
            for doc in list(self.docs):
                self.wfile.write(b"event: capabilities\nid: " + doc["revision"].encode() + b"\ndata: " + json.dumps(doc).encode() + b"\n\n")
                self.wfile.write(b'event: load\ndata: {"revision": "x", "load": {}}\n\n')
                self.wfile.flush()
                time.sleep(0.05)


class ResolveTests(unittest.TestCase):
    def test_prefers_then_falls_back_then_waits(self):
        self.assertEqual(rw.resolve(document("a"), "nighttime", ["daytime"]), "nighttime")
        self.assertEqual(rw.resolve(document("b", night=False, offline=True), "nighttime", ["daytime"]), "daytime")
        self.assertEqual(rw.resolve(document("c", night_available=False), "nighttime", ["daytime"]), "daytime")
        self.assertEqual(rw.resolve(document("d", accepting=False), "nighttime", ["daytime"]), rw.WAIT)
        self.assertEqual(rw.resolve(document("e", night=False, offline=True), "nighttime"), rw.UNAVAILABLE)
        self.assertEqual(rw.resolve(None, "nighttime", ["daytime"]), "nighttime")
        self.assertEqual(rw.model_for(document("f"), "nighttime")["context_window"], 98304)
        self.assertIsNone(rw.model_for(document("g", night=False), "nighttime"))

    def test_classifies_router_errors(self):
        body = lambda code: json.dumps({"error": {"code": code, "message": "m"}})
        self.assertEqual(rw.classify_error(503, body("SERVICE_OFFLINE")), rw.FALLBACK)
        self.assertEqual(rw.classify_error(503, body("BACKEND_UNAVAILABLE")), rw.FALLBACK)
        self.assertEqual(rw.classify_error(404, body("MODEL_NOT_FOUND")), rw.FALLBACK)
        self.assertEqual(rw.classify_error(503, body("BACKEND_DRAINING")), rw.WAIT)
        self.assertEqual(rw.classify_error(503, body("MAINTENANCE_MODE")), rw.WAIT)
        self.assertEqual(rw.classify_error(400, body("INVALID_REQUEST_BODY")), rw.FAIL)
        self.assertEqual(rw.classify_error(None), rw.RETRY)
        self.assertEqual(rw.classify_error(502, "not json"), rw.RETRY)
        self.assertEqual(rw.classify_error(503, json.dumps({"error": "legacy string"})), rw.RETRY)


class WatchTests(unittest.TestCase):
    def setUp(self):
        Router.docs = [document("r1")]
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Router)
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        self.addCleanup(self.server.server_close)
        self.addCleanup(self.server.shutdown)
        self.base = "http://127.0.0.1:%d" % self.server.server_address[1]

    def test_fetch_revalidates_and_stream_reports_each_new_revision(self):
        changes = []
        watch = rw.RouterWatch(self.base, on_change=lambda doc: changes.append(doc["revision"]))
        self.assertEqual(watch.fetch()["revision"], "r1")
        self.assertEqual(watch.fetch()["revision"], "r1")  # 304 keeps the current document
        Router.docs.append(document("r2", night=False, offline=True))
        stop = threading.Event()
        thread = threading.Thread(target=watch.run_forever, args=(stop,), daemon=True)
        thread.start()
        deadline = time.time() + 5
        while watch.doc["revision"] != "r2" and time.time() < deadline:
            time.sleep(0.02)
        stop.set()
        thread.join(5)
        self.assertEqual(changes, ["r1", "r2"])
        self.assertEqual(rw.resolve(watch.doc, "nighttime", ["daytime"]), "daytime")
        self.assertFalse(thread.is_alive())


if __name__ == "__main__":
    unittest.main()
