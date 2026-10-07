#!/usr/bin/env python3
"""open-webui-model-sync — keep Open WebUI's model list in step with the LLM Router.

The LLM Router publishes its live deployment at GET /v1/router/capabilities
and pushes every change at GET /v1/router/events (see the router's
docs/CLIENT_CONTRACT.md). Open WebUI (data dir /opt/open-webui/data) reaches the
router through its native Ollama connection. This enforcer keeps Open WebUI's
`model` and `access_grant` rows consistent with what the router serves:

  1. routine rows — one hidden, active row per served model whose aliases
     include `daytime` or `nighttime`, named "Daytime (128K)" / "Nighttime (96K)"
     from the live context window, with a description of the model;
  2. alias rows — `daytime`, `nighttime`, `local-active` stay labelled (admins
     only, never granted);
  3. access — read grants on routine rows and on presets based on a routine
     alias follow the model's NSFW flag: NSFW models (or models whose flag is
     unknown) go to every user except `nsfw_excluded_users`; other models go to
     everyone ('*');
  4. availability — presets based on a service that the current runtime
     configuration deliberately stops (router `offline_services`) are
     deactivated with a marker, and reactivated when the service returns. Only
     presets this enforcer deactivated are ever reactivated;
  5. labels — a routine preset name ending in "<N>K)" keeps N equal to the
     serving model's context window;
  6. retirement — routine-labelled rows for models the router no longer serves
     are soft-retired (is_active = 0), but only for a profile still served.

Runs once per invocation (timer) or follows the router's event stream
(`--watch`). Writes nothing when the router is unreachable or serves no models.
All writes commit atomically under a lock shared by both modes. Private host
settings (owner, per-user exclusions) live in /etc/open-webui-model-sync.json,
never in this file.
"""

import argparse
import fcntl
import json
import os
import re
import sqlite3
import sys
import time
import urllib.error
import urllib.request
import uuid

CONFIG_FILE = "/etc/open-webui-model-sync.json"
DEFAULTS = {
    "db": "/opt/open-webui/data/webui.db",
    "router": "http://192.168.1.4:11434",
    "state_file": "/var/lib/open-webui-model-sync/state.json",
    "lock_file": "/run/open-webui-model-sync.lock",
    "owner_email": None,           # owner of rows this enforcer creates; first admin when unset
    "nsfw_excluded_users": [],     # user IDs that never receive read access to NSFW models
    "client_name": "open-webui-model-sync",
}
PROFILE_WORDS = ("daytime", "nighttime")     # router service alias -> routine word
CAPS = {
    "vision": True,
    "builtin_tools": True,
    "web_search": True,
    "code_interpreter": True,
    "terminal": True,
    "image_generation": True,
}
ROUTINE_NAME_RE = re.compile(r"^(Daytime|Nighttime) \(")
CONTEXT_SUFFIX_RE = re.compile(r"^(?P<prefix>.*?)(?P<k>\d+)K\)$")
MARKER = "model_sync"                        # key in a preset's meta set when this enforcer deactivates it


def log(msg):
    print(f"[model-sync] {msg}", flush=True)


def warn(msg):
    print(f"[model-sync] WARNING: {msg}", flush=True)


def load_config(path, overrides):
    cfg = dict(DEFAULTS)
    if path and os.path.exists(path):
        with open(path) as f:
            cfg.update(json.load(f))
    cfg.update({k: v for k, v in overrides.items() if v is not None})
    if not isinstance(cfg["nsfw_excluded_users"], list):
        raise RuntimeError("nsfw_excluded_users must be a list of user IDs")
    return cfg


def kctx(ctx):
    """163840 -> '160K'."""
    try:
        return f"{int(ctx) // 1024}K"
    except (TypeError, ValueError):
        return ""


def routine_word(aliases):
    for w in PROFILE_WORDS:
        if w in (aliases or []):
            return w.capitalize()
    return None


def desired(word, model):
    """Desired (label, meta) for a routine row, from a capabilities-document model."""
    ctx = model.get("context_window")
    label = f"{word} ({kctx(ctx)})" if ctx else word
    disp = model.get("display_name") or model["id"]
    disp_core = disp.rsplit(" (", 1)[0] if " (" in disp else disp
    modalities = ", ".join(model.get("input_modalities") or ["text"])
    caps = model.get("capabilities") or []
    extras = [c for c in ("tools", "reasoning") if c in caps]
    desc = f"{disp_core}; {modalities}"
    if extras:
        desc += f", {', '.join(extras)}"
    if ctx:
        desc += f"; {kctx(ctx)} context"
    if model.get("slots") == 1:
        desc += ", one active request"
    if model.get("nsfw") is True:
        desc += "; NSFW"
    meta = {
        "profile_image_url": None,
        "description": desc,
        "capabilities": dict(CAPS),
        "knowledge": None,
        "hidden": True,
    }
    return label, meta


def principals_for(model, user_ids, excluded):
    """NSFW models (or an unknown flag) exclude the configured users; others are public."""
    if model.get("nsfw") is False:
        return set(user_ids) | {"*"}
    return set(user_ids) - set(excluded)


def request(cfg, path, etag=None, timeout=15):
    headers = {"Accept": "application/json", "X-Client-Name": cfg["client_name"]}
    if etag:
        headers["If-None-Match"] = etag
    return urllib.request.urlopen(urllib.request.Request(cfg["router"].rstrip("/") + path, headers=headers), timeout=timeout)


def fetch_capabilities(cfg, etag=None):
    """(document, etag); document is None when unchanged (304)."""
    try:
        with request(cfg, "/v1/router/capabilities", etag) as r:
            return json.load(r), r.headers.get("ETag")
    except urllib.error.HTTPError as e:
        if e.code == 304:
            return None, etag
        raise


def follow_events(cfg):
    """Yield each complete capabilities document from the router's event stream."""
    headers = {"Accept": "text/event-stream", "X-Client-Name": cfg["client_name"]}
    req = urllib.request.Request(cfg["router"].rstrip("/") + "/v1/router/events", headers=headers)
    # Keepalives arrive every 15 s; 60 s without bytes means the connection is dead.
    with urllib.request.urlopen(req, timeout=60) as stream:
        event, data = None, []
        for raw in stream:
            line = raw.decode("utf-8").rstrip("\r\n")
            if line == "":
                if event == "capabilities" and data:
                    yield json.loads("\n".join(data))
                event, data = None, []
            elif line.startswith(":"):
                continue
            elif line.startswith("event:"):
                event = line[6:].strip()
            elif line.startswith("data:"):
                data.append(line[5:].lstrip(" "))


def get_owner(s, owner_email):
    if owner_email:
        row = s.execute("select id from user where email = ?", (owner_email,)).fetchone()
        if row:
            return row[0]
    row = s.execute("select id from user where role = 'admin' limit 1").fetchone()
    if not row:
        raise RuntimeError("no owner found: neither the configured owner nor any admin user exists")
    return row[0]


def sync_grants(s, mid, principals, changes, write):
    """Reconcile read grants for a managed model id with the policy set."""
    have = {
        r[0] for r in s.execute(
            "select principal_id from access_grant where resource_type='model' "
            "and resource_id=? and principal_type='user' and permission='read'", (mid,),
        )
    }
    for p in sorted(set(principals) - have):
        changes.append(f"grant read {p!r} on model {mid!r}")
        if write:
            s.execute(
                "insert into access_grant (id, resource_type, resource_id, principal_type,"
                " principal_id, permission, created_at) values (?,?,?,?,?,?,?)",
                (str(uuid.uuid4()), "model", mid, "user", p, "read", int(time.time())),
            )
    for p in sorted(have - set(principals)):
        changes.append(f"revoke read {p!r} on model {mid!r}")
        if write:
            s.execute(
                "delete from access_grant where resource_type='model' and resource_id=? "
                "and principal_type='user' and permission='read' and principal_id=?",
                (mid, p),
            )


def reconcile(doc, cfg, write):
    """Apply one capabilities document to the database. Returns (status, changes, summary)."""
    if not isinstance(doc, dict) or doc.get("object") != "router.capabilities":
        warn("router returned an unexpected document; refusing to touch the DB")
        return "invalid_document", [], {}
    models = [m for m in doc.get("models") or [] if isinstance(m, dict) and m.get("id")]
    if not models:
        warn(f"router serves no models ({', '.join(doc.get('warnings') or []) or 'no warnings'}); refusing to touch the DB")
        return "no_models", [], {}

    configuration = (doc.get("configuration") or {}).get("id")
    offline = {}
    for service in doc.get("offline_services") or []:
        reason = f"offline in runtime configuration {configuration}" if configuration else "offline"
        if service.get("reason"):
            reason += f" ({service['reason']})"
        for alias in [service.get("model"), *(service.get("aliases") or [])]:
            if alias:
                offline[alias] = reason

    served = {}           # alias -> model, for every served alias
    managed = {}          # canonical id -> (word, model)
    for m in models:
        word = routine_word(m.get("aliases"))
        if word:
            managed[m["id"]] = (word, m)
        for alias in m.get("aliases") or []:
            served[alias] = m
    words_served = {word for word, _ in managed.values()}
    for word in (w.capitalize() for w in PROFILE_WORDS):
        if word not in words_served:
            state = "offline by configuration" if word.lower() in offline else "not served"
            warn(f"no {word} model this cycle ({state}); stale rows for that profile will not be retired")

    changes = []
    s = sqlite3.connect(cfg["db"], timeout=30)
    try:
        def execute(sql, params=()):
            if write:
                s.execute(sql, params)

        owner_id = get_owner(s, cfg.get("owner_email"))
        user_ids = [r[0] for r in s.execute("select id from user")]
        excluded = cfg["nsfw_excluded_users"]
        existing = {
            r[0]: {"name": r[1], "meta": r[2], "is_active": r[3]}
            for r in s.execute("select id, name, meta, is_active from model where base_model_id is null")
        }
        now = int(time.time())

        # ---- pass 1: routine rows (served daytime/nighttime models) ----
        for mid in sorted(managed):
            word, model = managed[mid]
            label, meta = desired(word, model)
            ex = existing.get(mid)
            if ex is None:
                changes.append(f"create routine row {mid!r} name={label!r}")
                execute("insert into model (id, user_id, base_model_id, name, params, meta,"
                        " updated_at, created_at, is_active) values (?,?,?,?,?,?,?,?,1)",
                        (mid, owner_id, None, label, "{}", json.dumps(meta, separators=(",", ":")), now, now))
            else:
                old_meta = json.loads(ex["meta"] or "{}")
                new_meta = dict(meta, profile_image_url=old_meta.get("profile_image_url"))
                what = []
                if ex["name"] != label:
                    what.append(f"name {ex['name']!r}->{label!r}")
                if old_meta.get("description") != meta["description"]:
                    what.append("description refreshed")
                if old_meta.get("hidden") is not True:
                    what.append("hidden->true")
                if not ex["is_active"]:
                    what.append("re-activated")
                if what:
                    changes.append(f"update routine row {mid!r}: " + ", ".join(what))
                    execute("update model set name=?, meta=?, is_active=1, updated_at=? where id=?",
                            (label, json.dumps(new_meta, separators=(",", ":")), now, mid))
            sync_grants(s, mid, principals_for(model, user_ids, excluded), changes, write)

        # ---- pass 2: alias rows (admin labels, never granted) ----
        alias_ids = set()
        for alias, model in sorted(served.items()):
            word = routine_word(model.get("aliases"))
            if not word:
                continue
            if alias in managed:
                warn(f"alias {alias!r} collides with a routine model id; skipping alias row")
                continue
            alias_ids.add(alias)
            label, meta = desired(word, model)
            ex = existing.get(alias)
            if ex is None:
                changes.append(f"create alias row {alias!r} name={label!r}")
                execute("insert into model (id, user_id, base_model_id, name, params, meta,"
                        " updated_at, created_at, is_active) values (?,?,?,?,?,?,?,?,1)",
                        (alias, owner_id, None, label, "{}", json.dumps(meta, separators=(",", ":")), now, now))
            elif ex["name"] != label:
                changes.append(f"rename alias row {alias!r}: {ex['name']!r}->{label!r}")
                execute("update model set name=?, updated_at=? where id=?", (label, now, alias))

        # ---- passes 3-5: presets based on a routine alias ----
        routine_aliases = {a for a, m in served.items() if routine_word(m.get("aliases"))} | set(offline)
        for pid, base, name, meta_raw, active in list(s.execute(
                "select id, base_model_id, name, meta, is_active from model where base_model_id is not null")):
            if base not in routine_aliases:
                continue  # presets on other bases (experiments, retired backends) are never touched
            meta = json.loads(meta_raw or "{}")
            marker = meta.get(MARKER) if isinstance(meta.get(MARKER), dict) else None
            if not active and not (marker and marker.get("offline")):
                continue  # deactivated by hand: never relabelled, regranted or reactivated
            model = served.get(base)
            if model is None:
                # Offline by configuration: hide it until the service returns.
                if active:
                    meta[MARKER] = {"offline": True, "reason": offline[base], "since": now}
                    changes.append(f"deactivate preset {pid!r} ({name!r}): {offline[base]}")
                    execute("update model set is_active=0, meta=?, updated_at=? where id=?",
                            (json.dumps(meta, separators=(",", ":")), now, pid))
                continue
            updates = {}
            if marker and marker.get("offline"):
                meta.pop(MARKER, None)
                updates["is_active"] = 1
                changes.append(f"reactivate preset {pid!r} ({name!r}): {base} is served again")
            match = CONTEXT_SUFFIX_RE.match(name or "")
            label = kctx(model.get("context_window"))
            if match and label and f"{match.group('k')}K" != label:
                new_name = f"{match.group('prefix')}{label})"
                updates["name"] = new_name
                changes.append(f"relabel preset {pid!r}: {name!r}->{new_name!r}")
            if updates:
                execute("update model set name=?, meta=?, is_active=?, updated_at=? where id=?",
                        (updates.get("name", name), json.dumps(meta, separators=(",", ":")),
                         updates.get("is_active", active), now, pid))
            sync_grants(s, pid, principals_for(model, user_ids, excluded), changes, write)

        # ---- pass 6: retire stale routine-labelled raw-model rows ----
        for mid, ex in sorted(existing.items()):
            if mid in managed or mid in alias_ids:
                continue
            m = ROUTINE_NAME_RE.match(ex["name"] or "")
            if not m or m.group(1) not in words_served:
                continue  # not routine, or its profile isn't served this cycle: never retire
            if ex["is_active"]:
                changes.append(f"retire stale routine row {mid!r} name={ex['name']!r} (is_active=0)")
                execute("update model set is_active=0, updated_at=? where id=?", (now, mid))

        if changes and write:
            s.commit()
    finally:
        s.close()

    summary = {
        "configuration": configuration,
        "revision": doc.get("revision"),
        "daytime": next((m["id"] for m in models if "daytime" in (m.get("aliases") or [])), None),
        "nighttime": next((m["id"] for m in models if "nighttime" in (m.get("aliases") or [])), None),
        "offline": sorted(a for a in offline if a in routine_aliases),
    }
    return ("ok" if write else "dry_run"), changes, summary


def write_state(path, obj):
    try:
        os.makedirs(os.path.dirname(path), exist_ok=True)
        tmp = path + ".tmp"
        with open(tmp, "w") as f:
            json.dump(obj, f)
        os.replace(tmp, path)
    except Exception as e:
        warn(f"could not write state file {path}: {e!r}")


def run_once(doc, cfg, dry_run):
    """Reconcile one document under the shared lock, log, and record state."""
    lock_dir = os.path.dirname(cfg["lock_file"])
    if lock_dir:
        os.makedirs(lock_dir, exist_ok=True)
    with open(cfg["lock_file"], "a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        status, changes, summary = reconcile(doc, cfg, write=not dry_run)
    for c in changes:
        log(f"{'would' if dry_run else 'applied'}: {c}")
    if not changes and status in ("ok", "dry_run"):
        log("in sync, no changes")
    if not dry_run:
        write_state(cfg["state_file"], {"status": status, "ts": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
                                        "router": cfg["router"], "changes": len(changes), **summary})
    log(f"done: status={status} configuration={summary.get('configuration')} daytime={summary.get('daytime')} "
        f"nighttime={summary.get('nighttime')} offline={summary.get('offline')} changes={len(changes)}")
    return status


def watch(cfg, dry_run):
    """Follow the event stream; while it is down, poll every 30 s and reconnect with backoff."""
    last_revision, etag, delay = None, None, 3
    while True:
        try:
            for doc in follow_events(cfg):
                delay = 3
                if doc.get("revision") != last_revision:
                    run_once(doc, cfg, dry_run)
                    last_revision = doc.get("revision")
        except Exception as e:
            warn(f"event stream ended ({e!r}); polling until it reconnects")
        try:
            doc, etag = fetch_capabilities(cfg, etag)
            if doc and doc.get("revision") != last_revision:
                run_once(doc, cfg, dry_run)
                last_revision = doc.get("revision")
        except Exception as e:
            warn(f"router unreachable ({e!r})")
        time.sleep(delay)
        delay = min(delay * 2, 30)


def main():
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--config", default=CONFIG_FILE, help="private host settings (JSON)")
    ap.add_argument("--db", help="path to webui.db")
    ap.add_argument("--router", help="router base URL, e.g. http://192.168.1.4:11434")
    ap.add_argument("--source-file", help="read a capabilities document from this file instead of HTTP (testing)")
    ap.add_argument("--state-file")
    ap.add_argument("--lock-file")
    ap.add_argument("--dry-run", action="store_true", help="log planned changes, write nothing")
    ap.add_argument("--watch", action="store_true", help="follow the router's event stream")
    args = ap.parse_args()
    cfg = load_config(args.config, {"db": args.db, "router": args.router, "state_file": args.state_file,
                                    "lock_file": args.lock_file})
    if args.watch:
        watch(cfg, args.dry_run)
        return 0
    if args.source_file:
        with open(args.source_file) as f:
            doc = json.load(f)
    else:
        try:
            doc, _ = fetch_capabilities(cfg)
        except Exception as e:
            warn(f"router unreachable ({e!r}); skipping this cycle")
            if not args.dry_run:
                write_state(cfg["state_file"], {"status": "router_unreachable", "error": repr(e)})
            return 0
    run_once(doc, cfg, args.dry_run)
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as e:
        print(f"[model-sync] ERROR: {e!r}", file=sys.stderr, flush=True)
        sys.exit(1)
