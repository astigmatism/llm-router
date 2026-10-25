# Open WebUI model-list sync

`open-webui-model-sync.py` keeps Open WebUI's model list an exact reflection of the LLM Router. It runs on the Open WebUI host (192.168.1.20) as root and writes Open WebUI's SQLite database (`/opt/open-webui/data/webui.db`) directly. It uses only the Python standard library.

## Why the rows matter

Open WebUI reaches the router through its native Ollama connection, and Open WebUI layers its `model` table over the live list `GET /api/tags` returns: a row with the same id **renames** the model in the picker, a row marked `hidden` **vanishes** from it, and a preset row with a base model is **appended** even when the backend never heard of it. Without care the picker stops showing what the router publishes — which is exactly what version 2's profile branding did. Version 3 keeps rows that reflect, never brands.

## What it does

It reads the router's [capabilities document](../../../docs/CAPABILITIES.md) (`GET /v1/router/capabilities`) and, with `--watch`, follows its change events (`GET /v1/router/events`). From those it maintains:

1. **Reflection rows.** One active, visible row per published tag — every served model's canonical id plus every alias, which is exactly the set of names `GET /api/tags` returns. A row is named with the tag itself and never renamed. Its description gives the model behind the tag, its inputs, tools, context, slots and an NSFW note; alias rows add "alias of ‹canonical›". The Open WebUI vision switch follows the model's `vision` capability.
2. **Access.** Read grants on those rows follow each model's `nsfw` flag:
   - NSFW models, or models whose flag is unknown, go to every user except those listed in `nsfw_excluded_users`;
   - other models go to everyone (`*`).

   Grants that don't match are revoked, so a hand-made grant is corrected on the next pass. Retired rows keep their grants for when the tag returns.
3. **Retirement.** Rows this enforcer marked, for tags the router no longer publishes (a different configuration, a model removed from the catalog), are soft-retired (`is_active = 0`) and come back with the tag. Nothing this tool creates is ever deleted.
4. **What it never touches.** User presets (rows with a base model), rows made by hand, and old experiments: never renamed, relabelled, re-granted, hidden or retired.

It never falls back to another model, and never edits chats, users, other presets or settings.

## Safety

- **No usable document, no writes.** It writes nothing when the router is unreachable, returns an unexpected document, serves no models, or publishes no tag at all (everything offline).
- **Atomic.** Each pass commits once.
- **Serialized.** The timer and the watcher share a lock (`/run/open-webui-model-sync.lock`), so their passes never overlap.
- **Bounded state.** One state file, `/var/lib/open-webui-model-sync/state.json`, is overwritten each pass; it records the published `tags` list and any offline names. Logs go to journald.

## Host settings

Private settings live in `/etc/open-webui-model-sync.json` on the host (root, mode 0600), never in this repository:

```json
{
  "owner_email": "<email of the Open WebUI account that owns rows this tool creates>",
  "nsfw_excluded_users": ["<Open WebUI user ID>", "…"]
}
```

Optional keys with defaults:
- `db`: `/opt/open-webui/data/webui.db`
- `router`: `http://192.168.1.23:11434` (the multi-host router instance; `192.168.1.4` is retired)
- `state_file`, `lock_file`
- `client_name`: `open-webui-model-sync`, sent as `X-Client-Name`

## Units

| Unit | Role |
|---|---|
| `open-webui-model-sync-watch.service` | `--watch`: follows the router's event stream and reconciles within seconds of each change. While disconnected it polls every 30 s and reconnects with backoff. `Restart=always`. |
| `open-webui-model-sync.service` + `.timer` | One pass every 15 minutes and 2 minutes after boot: a backstop that also corrects hand edits. |

## Operations

```sh
sudo /usr/local/bin/open-webui-model-sync.py --dry-run        # show planned changes; write nothing
systemctl status open-webui-model-sync-watch.service
sudo journalctl -u open-webui-model-sync-watch.service -n 30 --no-pager
sudo cat /var/lib/open-webui-model-sync/state.json
sudo systemctl disable --now open-webui-model-sync-watch.service open-webui-model-sync.timer   # pause
```

**Testing without touching production:** take a scratch copy with the SQLite backup API, then run with `--db <copy> --state-file <path> --lock-file <path> --config <test config>`. Add `--source-file <capabilities.json>` to test a configuration the router isn't currently in. The unit tests need no Open WebUI:

```sh
python3 -m unittest discover -s integrations/open-webui/model-sync -v
```

## History

Version 1, installed 2026-10-04, read `/api/tags` every 15 minutes and named the excluded user in its source. Version 2 (2026-10-07) added the capabilities document and event stream, availability from `offline_services`, NSFW-based access, live preset labels, private host settings, and the shared lock.

Version 3 (2026-10-24), at the owner's instruction, made the list a **reflection**: the picker must show exactly what the router publishes, under the names the router publishes. It dropped version 2's profile branding — routine rows named `Daytime (160K)` / `Nighttime (96K)`, hidden alias labels visible to admins only, preset relabelling, and offline-service preset reactivation — because those rules renamed the flagship model out of the picker and hid it (`hidden: true`), while appended presets showed models the router never published. The state file now records the published `tags` instead of the daytime/nighttime pair. Rows version 2 branded are adopted by the first version 3 pass: renamed to their tag, unhidden, described, and granted.
