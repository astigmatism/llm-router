"""Tests for open-webui-model-sync: python3 -m unittest discover -s integrations/open-webui/model-sync"""
import copy
import importlib.util
import json
import os
import sqlite3
import tempfile
import unittest
from pathlib import Path

spec = importlib.util.spec_from_file_location("model_sync", Path(__file__).with_name("open-webui-model-sync.py"))
ms = importlib.util.module_from_spec(spec)
spec.loader.exec_module(ms)

OWNER, ALICE, CHILD = "u-owner", "u-alice", "u-child"
DAY, NIGHT = "qwen-day", "qwen-night"


def model(mid, aliases, ctx, nsfw, display):
    return {"id": mid, "service": aliases[-1], "aliases": aliases, "available": True, "slots": 1,
            "context_window": ctx, "input_modalities": ["text", "image"],
            "capabilities": ["completion", "thinking", "tools", "vision"], "nsfw": nsfw,
            "display_name": display, "capability_score": 68.3}


def doc(*models, offline=(), configuration="paired", revision="r1"):
    return {"object": "router.capabilities", "schema_version": 1, "revision": revision,
            "router": {"accepting_requests": True}, "configuration": {"id": configuration},
            "models": list(models), "offline_services": list(offline), "warnings": []}


PAIRED = doc(model(DAY, ["local-active", "daytime"], 163840, False, "Qwen Day (160K)"),
             model(NIGHT, ["nighttime"], 98304, True, "Qwen Night Abliterated (96K)"))
SOLO = doc(model("flash", ["local-active", "daytime"], 131072, False, "Flash (128K)"),
           offline=[{"model": NIGHT, "aliases": ["nighttime"], "display_name": "Night", "reason": "exclusive_configuration"}],
           configuration="flash-next-solo-128k", revision="r2")


class Fixture(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.db = os.path.join(self.tmp.name, "webui.db")
        s = sqlite3.connect(self.db)
        s.executescript("""
            create table user (id text primary key, email text, role text);
            create table model (id text primary key, user_id text, base_model_id text, name text, params text,
                                meta text, updated_at integer, created_at integer, is_active integer);
            create table access_grant (id text primary key, resource_type text, resource_id text, principal_type text,
                                       principal_id text, permission text, created_at integer);
        """)
        s.executemany("insert into user values (?,?,?)", [(OWNER, "owner@example.test", "admin"),
                                                         (ALICE, "alice@example.test", "user"),
                                                         (CHILD, "child@example.test", "user")])
        presets = [("p-day", "daytime", "Daytime (160K)", 1), ("p-day-deep", "daytime", "Daytime (Deep Thinking, 160K)", 1),
                   ("p-night", "nighttime", "Nighttime (128K)", 1), ("p-night-deep", "nighttime", "Nighttime (Deep Thinking, 128K)", 1),
                   ("p-retired", "nighttime", "Nighttime old experiment (64K)", 0), ("p-other", "llama3:8b", "Other (8K)", 1)]
        for pid, base, name, active in presets:
            s.execute("insert into model values (?,?,?,?,?,?,?,?,?)",
                      (pid, OWNER, base, name, '{"think": true}', '{"description": "kept"}', 0, 0, active))
        s.commit()
        s.close()
        self.cfg = dict(ms.DEFAULTS, db=self.db, owner_email="owner@example.test", nsfw_excluded_users=[CHILD],
                        state_file=os.path.join(self.tmp.name, "state.json"), lock_file=os.path.join(self.tmp.name, "lock"))

    def run_doc(self, document, write=True):
        return ms.reconcile(copy.deepcopy(document), self.cfg, write)

    def rows(self):
        s = sqlite3.connect(self.db)
        try:
            return {r[0]: {"base": r[1], "name": r[2], "params": r[3], "meta": json.loads(r[4] or "{}"), "active": r[5]}
                    for r in s.execute("select id, base_model_id, name, params, meta, is_active from model")}
        finally:
            s.close()

    def grants(self, mid):
        s = sqlite3.connect(self.db)
        try:
            return {r[0] for r in s.execute("select principal_id from access_grant where resource_id=?", (mid,))}
        finally:
            s.close()


class ModelSyncTests(Fixture):
    def test_paired_configuration_labels_rows_and_presets_and_grants_by_nsfw(self):
        status, changes, summary = self.run_doc(PAIRED)
        self.assertEqual(status, "ok")
        rows = self.rows()
        self.assertEqual((rows[DAY]["name"], rows[NIGHT]["name"]), ("Daytime (160K)", "Nighttime (96K)"))
        self.assertTrue(rows[NIGHT]["meta"]["description"].endswith("; NSFW"))
        self.assertEqual(rows["p-night"]["name"], "Nighttime (96K)")
        self.assertEqual(rows["p-night-deep"]["name"], "Nighttime (Deep Thinking, 96K)")
        self.assertEqual(rows["p-day"]["name"], "Daytime (160K)")
        # Non-NSFW models are public; NSFW models exclude the configured users.
        self.assertEqual(self.grants("p-day"), {OWNER, ALICE, CHILD, "*"})
        self.assertEqual(self.grants("p-night"), {OWNER, ALICE})
        self.assertEqual(self.grants(NIGHT), {OWNER, ALICE})
        # Presets keep their own parameters and descriptions; unrelated presets are untouched.
        self.assertEqual((rows["p-night"]["params"], rows["p-night"]["meta"]), ('{"think": true}', {"description": "kept"}))
        self.assertEqual(rows["p-other"]["name"], "Other (8K)")
        self.assertEqual(self.grants("p-other"), set())
        self.assertEqual(summary["nighttime"], NIGHT)
        self.assertEqual(self.run_doc(PAIRED)[1], [], "a second run is a no-op")

    def test_solo_configuration_hides_nighttime_presets_and_restores_them(self):
        self.run_doc(PAIRED)
        _, changes, summary = self.run_doc(SOLO)
        rows = self.rows()
        self.assertEqual((rows["p-night"]["active"], rows["p-night-deep"]["active"]), (0, 0))
        marker = rows["p-night"]["meta"][ms.MARKER]
        self.assertEqual(marker["reason"], "offline in runtime configuration flash-next-solo-128k (exclusive_configuration)")
        self.assertEqual(rows["p-day"]["name"], "Daytime (128K)")
        # The Nighttime routine row is not retired, and its grants are not touched while offline.
        self.assertEqual(rows[NIGHT]["active"], 1)
        self.assertEqual(self.grants("p-night"), {OWNER, ALICE})
        self.assertEqual(summary["offline"], ["nighttime", NIGHT])
        self.assertEqual(self.run_doc(SOLO)[1], [])
        # Nighttime returns, under a new canonical ID: presets come back and are relabelled.
        back = doc(model(DAY, ["local-active", "daytime"], 163840, False, "Qwen Day (160K)"),
                   model("qwen-night-mtp3", ["nighttime"], 98304, True, "Night MTP3 (96K)"), revision="r3")
        self.run_doc(back)
        rows = self.rows()
        self.assertEqual((rows["p-night"]["active"], rows["p-night-deep"]["active"]), (1, 1))
        self.assertNotIn(ms.MARKER, rows["p-night"]["meta"])
        self.assertEqual(rows["p-night"]["meta"], {"description": "kept"})
        self.assertEqual(rows["qwen-night-mtp3"]["name"], "Nighttime (96K)")
        self.assertEqual(rows[NIGHT]["active"], 0, "the replaced Nighttime model is retired")
        self.assertEqual(self.grants("p-night"), {OWNER, ALICE})

    def test_presets_deactivated_by_hand_are_never_reactivated(self):
        self.run_doc(SOLO)
        self.run_doc(PAIRED)
        rows = self.rows()
        self.assertEqual((rows["p-retired"]["active"], rows["p-retired"]["name"]), (0, "Nighttime old experiment (64K)"))
        self.assertEqual(self.grants("p-retired"), set())
        self.assertEqual(rows["p-night"]["active"], 1)

    def test_an_unknown_nsfw_flag_fails_closed(self):
        unknown = copy.deepcopy(PAIRED)
        unknown["models"][0]["nsfw"] = None
        self.run_doc(unknown)
        self.assertEqual(self.grants("p-day"), {OWNER, ALICE})

    def test_never_writes_without_a_usable_document(self):
        before = self.rows()
        for bad in ({"object": "router.capabilities", "models": [], "warnings": ["INVALID_MODEL_CATALOG"]}, {"models": []}, None):
            status, changes, _ = self.run_doc(bad)
            self.assertIn(status, ("no_models", "invalid_document"))
            self.assertEqual(changes, [])
        self.assertEqual(self.rows(), before)

    def test_dry_run_reports_changes_without_writing(self):
        before = self.rows()
        status, changes, _ = self.run_doc(SOLO, write=False)
        self.assertEqual(status, "dry_run")
        self.assertTrue(any(c.startswith("deactivate preset 'p-night'") for c in changes))
        self.assertEqual(self.rows(), before)

    def test_run_once_records_state_under_the_lock(self):
        ms.run_once(copy.deepcopy(SOLO), self.cfg, dry_run=False)
        state = json.loads(Path(self.cfg["state_file"]).read_text())
        self.assertEqual((state["status"], state["configuration"], state["revision"]), ("ok", "flash-next-solo-128k", "r2"))

    def test_private_settings_come_from_the_config_file(self):
        path = os.path.join(self.tmp.name, "config.json")
        Path(path).write_text(json.dumps({"owner_email": "o@example.test", "nsfw_excluded_users": [CHILD]}))
        cfg = ms.load_config(path, {"db": self.db})
        self.assertEqual((cfg["owner_email"], cfg["nsfw_excluded_users"], cfg["db"]), ("o@example.test", [CHILD], self.db))
        source = Path(ms.__file__).read_text()
        self.assertNotRegex(source, r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}")


if __name__ == "__main__":
    unittest.main()
