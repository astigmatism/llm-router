# Open WebUI model-list sync

`open-webui-model-sync.py` keeps Open WebUI's model list an exact reflection of the LLM Router. It runs on the Open WebUI host (192.168.1.20) as root and writes Open WebUI's SQLite database (`/opt/open-webui/data/webui.db`) directly. It uses only the Python standard library.

## Why the rows matter

Open WebUI reaches the router through its native Ollama connection, and Open WebUI layers its `model` table over the live list `GET /api/tags` returns: a row with the same id **renames** the model in the picker, a row marked `hidden` **vanishes** from it, and a preset row with a base model is **appended** even when the backend never heard of it. Without care the picker stops showing what the router publishes — which is exactly what version 2's profile branding did. Version 3 keeps rows that reflect, never brands.

## What it does

It reads the router's [capabilities document](../../../docs/CAPABILITIES.md) (`GET /v1/router/capabilities`) and, with `--watch`, follows its change events (`GET /v1/router/events`). From those it maintains:

1. **Model rows.** One active, visible row per served model, named with the model's published `display_name` (for example `Qwen3.8 Flash-Next (256K)`) — the same translation the DeepSeek Harness picker shows. The name is mirrored on every pass, so a new catalog or configuration renames the picker entries within seconds. The description gives the model's inputs, tools, context, slots and an NSFW note. The Open WebUI vision switch follows the model's `vision` capability.
2. **Alias rows.** One hidden, active row per alias (`daytime`, `daisy`, …), named with the raw alias: the router publishes no display name for an alias beyond the word itself. Hidden rows stay out of the picker but keep their ids and access grants, so a chat that names an alias keeps resolving and the router — not the picker — does the routing.
3. **Access.** Read grants on both kinds of row follow each model's `nsfw` flag:
   - NSFW models, or models whose flag is unknown, go to every user except those listed in `nsfw_excluded_users`;
   - other models go to everyone (`*`).

   Grants that don't match are revoked, so a hand-made grant is corrected on the next pass. Retired rows keep their grants for when the tag returns.
4. **Retirement.** Rows this enforcer marked, for tags the router no longer publishes (a different configuration, a model removed from the catalog), are soft-retired (`is_active = 0`) and come back with the tag. Nothing this tool creates is ever deleted.
5. **What it never touches.** User presets (rows with a base model), rows made by hand, and old experiments: never renamed, relabelled, re-granted, hidden or retired.

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

Version 3 (2026-10-24), at the owner's instruction, made the list a **reflection**: the picker must show what the router publishes, not a brand. It dropped version 2's profile branding — routine rows named `Daytime (160K)` / `Nighttime (96K)`, hidden alias labels visible to admins only, preset relabelling, and offline-service preset reactivation — because those rules renamed the flagship model out of the picker and hid it (`hidden: true`), while appended presets showed models the router never published. The state file records the published `tags` list.

Version 4 (2026-10-25), same instruction, one refinement: the picker should read the way the router's own clients read it, as DeepSeek Harness does. Each served model now appears once, named with its published `display_name` and mirrored on every publish; the routing aliases move from visible raw-name entries into hidden rows that still carry ids and grants. A hand-edit of a model row's name is overwritten by the next pass — the display name belongs to the router, and the picker should not disagree with it.
