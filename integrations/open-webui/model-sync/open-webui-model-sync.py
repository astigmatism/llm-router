#!/usr/bin/env python3
"""open-webui-model-sync — keep Open WebUI's model list an exact reflection of the LLM Router.

The LLM Router publishes its live deployment at GET /v1/router/capabilities
and pushes every change at GET /v1/router/events (see the router's
docs/CLIENT_CONTRACT.md). Open WebUI (data dir /opt/open-webui/data) reaches
the router through its native Ollama connection, and Open WebUI layers its
`model` table over that live list: a row with the same id renames the model
and a row marked hidden vanishes from the picker. This enforcer keeps those
rows from branding or hiding what the router serves:

  1. model rows — one active, visible row per served model, named with the
     router's published `display_name` and mirrored on every publish, so a new
     catalog or configuration renames the picker within seconds;
  2. alias rows — one hidden, active row per alias, named with the raw alias
     (the router publishes no display name beyond the word itself). Aliases
     stay out of the picker but keep their access grants, so chats that name
     an alias keep resolving;
  3. access — read grants on those rows follow each model's NSFW flag: NSFW
     models (or models whose flag is unknown) go to every user except
     `nsfw_excluded_users`; other models go to everyone ('*');
  4. retirement — rows this enforcer marked, for tags the router no longer
     publishes, are soft-retired (`is_active = 0`) and reactivated if the tag
     returns. Nothing here is ever deleted.

Rows this enforcer did not mark — user presets (any row with a base model)
and rows made by hand — are never renamed, relabelled, re-granted, hidden or
retired. Version 3 (2026-10-24) replaced version 2's profile branding with a
reflection rule at the owner's request: the picker must show what the router
publishes, not a brand. Version 4 (2026-10-25) matched the DeepSeek Harness
picker: each router model appears once, under its published display name, and
the routing aliases step out of the picker into hidden rows.

Runs once per invocation (timer) or follows the router's event stream
(`--watch`). Writes nothing when the router is unreachable or publishes no
tags. All writes commit atomically under a lock shared by both modes.
Private host settings (owner, per-user exclusions) live in
/etc/open-webui-model-sync.json, never in this file.
"""

import argparse
import fcntl
import json
import os
import sqlite3
import sys
import time
import urllib.error
import urllib.request
import uuid

CONFIG_FILE = "/etc/open-webui-model-sync.json"
DEFAULTS = {
    "db": "/opt/open-webui/data/webui.db",
    "router": "http://192.168.1.23:11434",   # multi-host router instance (192.168.1.4 is retired)
    "state_file": "/var/lib/open-webui-model-sync/state.json",
    "lock_file": "/run/open-webui-model-sync.lock",
    "owner_email": None,           # owner of rows this enforcer creates; first admin when unset
    "nsfw_excluded_users": [],     # user IDs that never receive read access to NSFW models
    "client_name": "open-webui-model-sync",
}
CAPS = {
    "vision": True,
    "builtin_tools": True,
    "web_search": True,
    "code_interpreter": True,
    "terminal": True,
    "image_generation": True,
}
MARKER = "model_sync"                        # key in a row's meta set when this enforcer manages it


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


def describe(model, canonical, tag):
    """Description for a reflection row: model, inputs, extras, context, and, for an
    alias, the model it answers."""
    disp = model.get("display_name") or canonical
    disp_core = disp.rsplit(" (", 1)[0] if " (" in disp else disp
    modalities = ", ".join(model.get("input_modalities") or ["text"])
    caps = model.get("capabilities") or []
    extras = [c for c in ("tools", "thinking") if c in caps]
    desc = f"{disp_core}; {modalities}"
    if extras:
        desc += f", {', '.join(extras)}"
    ctx = kctx(model.get("context_window"))
    if ctx:
        desc += f"; {ctx} context"
    if model.get("slots") == 1:
        desc += ", one active request"
    if tag != canonical:
        desc += f"; alias of {canonical}"
    if model.get("nsfw") is True:
        desc += "; NSFW"
    return desc


def caps_for(model):
    """Open WebUI feature switches for a row: the router's word for vision drives
    the vision switch; the rest are Open WebUI-side features."""
    caps = dict(CAPS)
    caps["vision"] = "vision" in (model.get("capabilities") or [])
    return caps


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


def published_tags(doc, offline, configuration):
    """{tag: (canonical id, model)} for everything the router publishes right now:
    each available model's canonical id plus its aliases, minus offline names."""
    available = [m for m in doc if m.get("available") is not False]
    tags = {}
    for m in available:
        if m["id"] not in offline:
            tags[m["id"]] = (m["id"], m)
    for m in available:
        for alias in m.get("aliases") or []:
            if alias in offline:
                continue
            if alias in tags:
                if tags[alias][0] != m["id"]:
                    warn(f"alias {alias!r} collides with model {tags[alias][0]!r}; keeping the canonical row")
                continue
            tags[alias] = (m["id"], m)
    return tags


def reconcile(doc, cfg, write):
    """Apply one capabilities document to the database. Returns (status, changes, summary)."""
    if not isinstance(doc, dict) or doc.get("object") != "router.capabilities":
        warn("router returned an unexpected document; refusing to touch the DB")
        return "invalid_document", [], {}
    models = [m for m in doc.get("models") or [] if isinstance(m, dict) and m.get("id")]
    configuration = (doc.get("configuration") or {}).get("id")
    if not models:
        warn(f"router serves no models ({', '.join(doc.get('warnings') or []) or 'no warnings'}); refusing to touch the DB")
        return "no_models", [], {}

    offline = {}
    for service in doc.get("offline_services") or []:
        reason = f"offline in runtime configuration {configuration}" if configuration else "offline"
        if service.get("reason"):
            reason += f" ({service['reason']})"
        for alias in [service.get("model"), *(service.get("aliases") or [])]:
            if alias:
                offline[alias] = reason

    tags = published_tags(models, offline, configuration)
    if not tags:
        warn(f"router publishes no tags this cycle (all offline{': ' + ', '.join(sorted(offline)) if offline else ''}); refusing to touch the DB")
        return "no_models", [], {}

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

        # ---- pass 1: model rows (visible, display-named) and alias rows (hidden) ----
        for tag in sorted(tags):
            canonical, model = tags[tag]
            is_model = tag == canonical
            name = (model.get("display_name") or tag) if is_model else tag
            desc = describe(model, canonical, tag)
            caps = caps_for(model)
            principals = principals_for(model, user_ids, excluded)
            marker = {"tag": tag}
            ex = existing.get(tag)
            if ex is None:
                changes.append(f"create {'model' if is_model else 'alias'} row {tag!r} name={name!r}")
                meta = {
                    "profile_image_url": None,
                    "description": desc,
                    "capabilities": caps,
                    "knowledge": None,
                    "hidden": not is_model,
                    MARKER: marker,
                }
                execute("insert into model (id, user_id, base_model_id, name, params, meta,"
                        " updated_at, created_at, is_active) values (?,?,?,?,?,?,?,?,1)",
                        (tag, owner_id, None, name, "{}", json.dumps(meta, separators=(",", ":")), now, now))
            else:
                old_meta = json.loads(ex["meta"] or "{}")
                new_meta = dict(old_meta)
                new_meta["description"] = desc
                new_meta["capabilities"] = caps
                new_meta["hidden"] = not is_model
                new_meta[MARKER] = marker
                what = []
                if ex["name"] != name:
                    what.append(f"name {ex['name']!r}->{name!r}")
                if old_meta.get("description") != desc:
                    what.append("description refreshed")
                if old_meta.get("capabilities") != caps:
                    what.append("capabilities refreshed")
                if old_meta.get("hidden") is not (not is_model):
                    what.append("hidden->" + ("true" if not is_model else "false"))
                if old_meta.get(MARKER) != marker:
                    what.append("marked")
                if not ex["is_active"]:
                    what.append("re-activated")
                if what:
                    changes.append(f"update {'model' if is_model else 'alias'} row {tag!r}: " + ", ".join(what))
                    execute("update model set name=?, meta=?, is_active=1, updated_at=? where id=?",
                            (name, json.dumps(new_meta, separators=(",", ":")), now, tag))
            sync_grants(s, tag, principals, changes, write)

        # ---- pass 2: retire marked rows whose tag the router no longer publishes ----
        for mid, ex in sorted(existing.items()):
            if mid in tags:
                continue
            try:
                meta = json.loads(ex["meta"] or "{}")
            except ValueError:
                continue
            if not isinstance(meta.get(MARKER), dict):
                continue  # not ours: hand-made rows and old experiments stay exactly as they are
            if ex["is_active"]:
                changes.append(f"retire managed row {mid!r} (no longer published)")
                execute("update model set is_active=0, updated_at=? where id=?", (now, mid))

        if changes and write:
            s.commit()
    finally:
        s.close()

    summary = {
        "configuration": configuration,
        "revision": doc.get("revision"),
        "tags": sorted(tags),
        "offline": sorted(offline),
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
    log(f"done: status={status} configuration={summary.get('configuration')} revision={summary.get('revision')} "
        f"tags={len(summary.get('tags') or [])} offline={summary.get('offline')} changes={len(changes)}")
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
    ap.add_argument("--router", help="router base URL, e.g. http://192.168.1.23:11434")
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
