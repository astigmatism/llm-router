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


def model(mid, aliases, ctx, nsfw, display, caps=("completion", "thinking", "tools", "vision")):
    return {"id": mid, "service": aliases[-1], "aliases": aliases, "available": True, "slots": 1,
            "context_window": ctx, "input_modalities": ["text", "image"],
            "capabilities": list(caps), "nsfw": nsfw,
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
                   ("p-night", "nighttime", "Nighttime (96K)", 1), ("p-retired", "nighttime", "Nighttime old experiment (64K)", 0),
                   ("p-other", "llama3:8b", "Other (8K)", 1)]
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
            return {r[0] for r in s.execute(
                "select principal_id from access_grant where resource_id=? and permission='read'", (mid,))}
        finally:
            s.close()


class ReflectionTests(Fixture):
    def test_models_show_under_published_display_names_and_aliases_stay_hidden(self):
        status, changes, summary = self.run_doc(PAIRED)
        self.assertEqual(status, "ok")
        rows = self.rows()
        for tag, canonical, name, hidden in [
            (DAY, DAY, "Qwen Day (160K)", False),
            (NIGHT, NIGHT, "Qwen Night Abliterated (96K)", False),
            ("local-active", DAY, "local-active", True),
            ("daytime", DAY, "daytime", True),
            ("nighttime", NIGHT, "nighttime", True),
        ]:
            self.assertEqual(rows[tag]["name"], name, "models carry the router's display name; aliases the raw word")
            self.assertEqual(rows[tag]["active"], 1)
            self.assertIs(rows[tag]["meta"]["hidden"], hidden)
            self.assertEqual(rows[tag]["meta"][ms.MARKER], {"tag": tag})
            self.assertEqual(rows[tag]["base"], None)
        for tag in ("local-active", "daytime"):
            self.assertIn(f"alias of {DAY}", rows[tag]["meta"]["description"])
        self.assertIn(f"alias of {NIGHT}", rows["nighttime"]["meta"]["description"])
        self.assertNotIn("alias of", rows[DAY]["meta"]["description"])
        self.assertTrue(rows[NIGHT]["meta"]["description"].endswith("; NSFW"))
        # Non-NSFW rows are public; NSFW rows (and their aliases) exclude the configured users.
        for tag in (DAY, "local-active", "daytime"):
            self.assertEqual(self.grants(tag), {OWNER, ALICE, CHILD, "*"})
        for tag in (NIGHT, "nighttime"):
            self.assertEqual(self.grants(tag), {OWNER, ALICE})
        self.assertEqual(summary["tags"], sorted([DAY, "local-active", "daytime", NIGHT, "nighttime"]))
        self.assertEqual(self.run_doc(PAIRED)[1], [], "a second run is a no-op")

    def test_presets_are_never_touched(self):
        self.run_doc(PAIRED)
        rows = self.rows()
        for pid, name in [("p-day", "Daytime (160K)"), ("p-day-deep", "Daytime (Deep Thinking, 160K)"),
                          ("p-night", "Nighttime (96K)"), ("p-retired", "Nighttime old experiment (64K)"),
                          ("p-other", "Other (8K)")]:
            self.assertEqual((rows[pid]["name"], rows[pid]["params"], rows[pid]["meta"]),
                             (name, '{"think": true}', {"description": "kept"}))
            self.assertEqual(self.grants(pid), set(), "preset grants are nobody's business here")
        self.assertEqual((rows["p-day"]["active"], rows["p-retired"]["active"]), (1, 0), "active flags untouched")

    def test_legacy_branded_rows_are_adopted_renamed_and_unhidden(self):
        s = sqlite3.connect(self.db)
        s.execute("insert into model values (?,?,?,?,?,?,?,?,1)",
                  (DAY, OWNER, None, "Daytime (160K)", "{}",
                   json.dumps({"hidden": True, "description": "stale", "profile_image_url": "/img/day.png"}), 0, 0))
        s.commit()
        s.close()
        self.run_doc(PAIRED)
        rows = self.rows()
        self.assertEqual(rows[DAY]["name"], "Qwen Day (160K)", "adopted into the published display name")
        self.assertIs(rows[DAY]["meta"]["hidden"], False)
        self.assertEqual(rows[DAY]["meta"]["profile_image_url"], "/img/day.png", "a hand-picked image survives")
        self.assertEqual(rows[DAY]["meta"][ms.MARKER], {"tag": DAY})
        self.assertIn("160K context", rows[DAY]["meta"]["description"])

    def test_republished_display_names_are_mirrored_onto_visible_rows(self):
        self.run_doc(PAIRED)
        reroll = copy.deepcopy(PAIRED)
        reroll["models"][0]["display_name"] = "Qwen Day Rerolled (160K)"
        reroll["revision"] = "r7"
        _, changes, _ = self.run_doc(reroll)
        self.assertEqual(self.rows()[DAY]["name"], "Qwen Day Rerolled (160K)")
        self.assertTrue(any(f"name 'Qwen Day (160K)'->'Qwen Day Rerolled (160K)'" in c for c in changes))
        self.assertEqual(self.run_doc(reroll)[1], [], "the mirror settles")

    def test_alias_promoted_to_a_model_id_becomes_visible_and_display_named(self):
        self.run_doc(PAIRED)
        promoted = doc(model("daytime", ["local-active"], 131072, False, "Daytime Prime (128K)"))
        self.run_doc(promoted)
        rows = self.rows()
        self.assertEqual((rows["daytime"]["name"], rows["daytime"]["meta"]["hidden"]), ("Daytime Prime (128K)", False))
        self.assertEqual(rows["local-active"]["meta"]["hidden"], True)
        self.assertEqual(rows["local-active"]["meta"]["description"].count("alias"), 1)
        self.assertEqual(rows[DAY]["active"], 0, "the vanished model retires")
        self.assertEqual(rows[NIGHT]["active"], 0)

    def test_rows_for_unpublished_tags_are_retired_and_return_with_the_tag(self):
        self.run_doc(PAIRED)
        _, changes, summary = self.run_doc(SOLO)
        rows = self.rows()
        self.assertEqual((rows[NIGHT]["active"], rows["nighttime"]["active"]), (0, 0), "offline tags retire")
        self.assertEqual(self.grants(NIGHT), {OWNER, ALICE}, "retirement keeps grants for the return")
        self.assertTrue(any(c.startswith(f"retire managed row {NIGHT!r}") for c in changes))
        self.assertEqual(rows["flash"]["active"], 1)
        self.assertEqual(summary["offline"], ["nighttime", NIGHT])
        self.assertEqual(self.run_doc(SOLO)[1], [], "a second solo pass is a no-op")
        # retiring must not touch rows this enforcer never marked
        s = sqlite3.connect(self.db)
        s.execute("insert into model values (?,?,?,?,?,?,?,?,1)",
                  ("qwen-handmade", OWNER, None, "Hand Made (8K)", "{}", '{"description": "mine"}', 0, 0))
        s.commit()
        s.close()
        self.assertEqual(self.run_doc(PAIRED)[1].count("retire managed row 'qwen-handmade'"), 0)
        self.assertEqual(self.rows()["qwen-handmade"]["active"], 1)
        back = doc(model(DAY, ["local-active", "daytime"], 163840, False, "Qwen Day (160K)"),
                   model(NIGHT, ["nighttime"], 98304, True, "Qwen Night Abliterated (96K)"), revision="r3")
        self.run_doc(back)
        rows = self.rows()
        self.assertEqual((rows[NIGHT]["active"], rows["nighttime"]["active"]), (1, 1), "the tags come back")

    def test_offline_tags_publish_nothing_and_retire_nothing_when_everything_is_offline(self):
        self.run_doc(PAIRED)
        before = self.rows()
        all_offline = doc(model(DAY, ["daytime"], 163840, False, "Qwen Day (160K)"),
                          offline=[{"model": DAY, "aliases": ["daytime"], "display_name": "Day", "reason": "maintenance"}],
                          configuration="maintenance", revision="r9")
        status, changes, _ = self.run_doc(all_offline)
        self.assertEqual(status, "no_models")
        self.assertEqual(changes, [])
        self.assertEqual(self.rows(), before, "an empty inventory is not a usable document")

    def test_vision_switch_follows_the_model(self):
        text_only = copy.deepcopy(PAIRED)
        for m in text_only["models"]:
            if m["id"] == NIGHT:
                m["capabilities"] = ["completion", "thinking", "tools"]
                m["input_modalities"] = ["text"]
        self.run_doc(text_only)
        rows = self.rows()
        self.assertIs(rows[NIGHT]["meta"]["capabilities"]["vision"], False)
        self.assertIs(rows[DAY]["meta"]["capabilities"]["vision"], True)
        self.assertIs(rows["daytime"]["meta"]["capabilities"]["vision"], True, "an alias follows its model")

    def test_an_unknown_nsfw_flag_fails_closed(self):
        unknown = copy.deepcopy(PAIRED)
        unknown["models"][0]["nsfw"] = None
        self.run_doc(unknown)
        self.assertEqual(self.grants(DAY), {OWNER, ALICE})
        self.assertEqual(self.grants("daytime"), {OWNER, ALICE}, "an alias follows its model")

    def test_hand_made_grants_are_corrected(self):
        s = sqlite3.connect(self.db)
        s.execute("insert into access_grant values ('g1','model',?,'user',?,'read',0)", (NIGHT, CHILD))
        s.execute("insert into access_grant values ('g2','model',?,'user',?,'write',0)", (NIGHT, CHILD))
        s.commit()
        s.close()
        _, changes, _ = self.run_doc(PAIRED)
        self.assertEqual(self.grants(NIGHT), {OWNER, ALICE}, "the read grant to the excluded user is revoked")
        s = sqlite3.connect(self.db)
        try:
            self.assertEqual({(r[0], r[1]) for r in s.execute("select principal_id, permission from access_grant where resource_id=?", (NIGHT,))},
                             {(OWNER, "read"), (ALICE, "read"), (CHILD, "write")}, "non-read grants are never touched")
        finally:
            s.close()
        self.assertTrue(any(c.startswith("revoke read") for c in changes))

    def test_alias_colliding_with_a_canonical_id_keeps_the_canonical_row(self):
        collide = doc(model("alpha", ["beta", "gamma"], 131072, False, "Alpha (128K)"),
                      model("beta", ["beta-own"], 65536, False, "Beta (64K)"))
        self.run_doc(collide)
        rows = self.rows()
        self.assertIn("Beta", rows["beta"]["meta"]["description"], "the canonical model owns its id")
        self.assertEqual(rows["gamma"]["meta"][ms.MARKER], {"tag": "gamma"})
        self.assertIn("alias of alpha", rows["gamma"]["meta"]["description"])

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
        self.assertTrue(any(c.startswith("create model row 'flash'") for c in changes))
        self.assertEqual(self.rows(), before)

    def test_run_once_records_state_under_the_lock(self):
        ms.run_once(copy.deepcopy(SOLO), self.cfg, dry_run=False)
        state = json.loads(Path(self.cfg["state_file"]).read_text())
        self.assertEqual((state["status"], state["configuration"], state["revision"]), ("ok", "flash-next-solo-128k", "r2"))
        self.assertEqual(state["tags"], ["daytime", "flash", "local-active"])

    def test_private_settings_come_from_the_config_file(self):
        path = os.path.join(self.tmp.name, "config.json")
        Path(path).write_text(json.dumps({"owner_email": "o@example.test", "nsfw_excluded_users": [CHILD]}))
        cfg = ms.load_config(path, {"db": self.db})
        self.assertEqual((cfg["owner_email"], cfg["nsfw_excluded_users"], cfg["db"]), ("o@example.test", [CHILD], self.db))
        source = Path(ms.__file__).read_text()
        self.assertNotRegex(source, r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}")


if __name__ == "__main__":
    unittest.main()
