# Open WebUI model-list sync

`open-webui-model-sync.py` keeps Open WebUI's model list in step with the LLM Router. It runs on the Open WebUI host (192.168.1.20) as root and writes Open WebUI's SQLite database (`/opt/open-webui/data/webui.db`) directly. It uses only the Python standard library.

## What it does

It reads the router's [capabilities document](../../../docs/CAPABILITIES.md) (`GET /v1/router/capabilities`) and, with `--watch`, follows its change events (`GET /v1/router/events`). From those it maintains:

1. **Routine rows.** One hidden, active row per served model whose aliases include `daytime` or `nighttime`, named `Daytime (128K)` or `Nighttime (96K)` from the live context window. Its description gives the model, inputs, tools, context, slots and an NSFW note.
2. **Alias rows.** `daytime`, `nighttime` and `local-active` keep labels. They are visible to admins only and never granted.
3. **Access.** Read grants on routine rows, and on presets based on a routine alias, follow each model's `nsfw` flag:
   - NSFW models, or models whose flag is unknown, go to every user except those listed in `nsfw_excluded_users`;
   - other models go to everyone (`*`).

   Grants that don't match are revoked, so a hand-made grant is corrected on the next pass.
4. **Availability.** When the router lists a service under `offline_services` (for example Nighttime during a solo configuration), presets based on it are deactivated. Each gets a `model_sync` marker in its `meta`, recording the reason and when. When the service is served again, only presets carrying that marker are reactivated. Presets deactivated by hand are never touched.
5. **Labels.** A routine preset whose name ends in `<N>K)`, for example `Daytime (Deep Thinking, 160K)`, keeps `N` equal to the serving model's context window. Nothing else in the preset changes: its ID, prompt, parameters, tools and image stay as they are.
6. **Retirement.** Routine-labelled rows for models the router no longer serves are soft-retired (`is_active = 0`). This happens only for a profile that is still served; an offline or missing profile retires nothing.

It never falls back to another model, and never edits chats, users, other presets or settings.

## Safety

- **No usable document, no writes.** It writes nothing when the router is unreachable, returns an unexpected document, or serves no models.
- **Atomic.** Each pass commits once.
- **Serialized.** The timer and the watcher share a lock (`/run/open-webui-model-sync.lock`), so their passes never overlap.
- **Bounded state.** One state file, `/var/lib/open-webui-model-sync/state.json`, is overwritten each pass. Logs go to journald.

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
- `router`: `http://192.168.1.4:11434`
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

Version 1, installed 2026-10-04, read `/api/tags` every 15 minutes and named the excluded user in its source. Version 2 (2026-10-07) adds:
- the capabilities document and event stream;
- availability from `offline_services`;
- NSFW-based access;
- live preset labels;
- private host settings;
- the shared lock.

On the production data it reproduced version 1's grants exactly.
