# Provenance of the v0.12.3 overlay

Ports the router integration layer from `local/open-webui:v0.11.4-router-v2` onto upstream
v0.12.3, done 2026-10-25 directly in this directory (the repository is now the build source;
the host build directory `~/deployments/open-webui/build/` is retired).

- Base image: `ghcr.io/open-webui/open-webui@sha256:a537bbe1e6b428820f52ed4a029d7fff97062e24d5cf32c365fba36fd0542def` (upstream v0.12.3, revision `91ea4e3421d1d8069f13d4a463fcb5986d94ea60`).
- Sources compared: the upstream v0.11.4 and v0.12.3 tarballs from GitHub; our patch baseline is `v0.11.4/merged/` at its deployed state (`v0.11.4/DEPLOYED-SHA256SUMS`).
- Method: for each of the 8 modified files, `git merge-file` applied our v0.11.4 delta
  (upstream v0.11.4 -> merged) onto the v0.12.3 file. Five conflicts, all resolved by hand:
  - `routers/ollama.py` (2x): upstream moved header/cookie building into
    `utils/headers.get_headers_and_cookies`; each call site now takes helper output and adds
    `X-Client-Name: open-webui`; the drain-wait retry loop now passes the helper's cookies.
  - `utils/middleware.py` (2x): completion-completion condition keeps upstream's new
    `tool_calls` term and our `router_state` term; the streaming loop initializes both
    upstream's new `finish_reason` and our `router_state`.
  - `utils/response.py` (1x): upstream now copies `done_reason` into `finish_reason`; our
    `apply_terminal` does the same and applies the router terminal policy on top, so ours
    stands. The streaming generator merge kept upstream's finish_reason lines.
- Verification before deployment: every added line of the v0.11.4 patch present in the
  merged files (structural form changes above accounted for); all `open_webui.*` imports
  resolve against the v0.12.3 tree; all files parse; unit tests + boot-smoke run inside the
  built image (mandatory, see README).
- The two new modules (`router_completion.py`, `web_fetch_window.py`) are carried unchanged.
- Upstream v0.12.0-v0.12.3 release notes carry no breaking changes for this deployment;
  context compaction became an upstream feature in kind but our overlay patch to it (cap to
  serving-model context, no silent truncation) survives and is covered by tests.

`DEPLOYED-SHA256SUMS` records each overlay file's SHA-256 and the built image ID.
