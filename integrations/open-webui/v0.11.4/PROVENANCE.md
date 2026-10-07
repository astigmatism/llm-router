# Provenance of the v0.11.4 overlay

These files were copied on 2026-10-07 from the production build directory on the Open WebUI host (192.168.1.20, `~/deployments/open-webui/build/`). `DEPLOYED-SHA256SUMS` records each overlay file's SHA-256. Every value equals the same file inside the running container `open-webui`.

- Running image: `local/open-webui:v0.11.4-router-v1`, ID `sha256:7c743d410a3a4037b9212ab30e42ff236090ada53284f1b8e3d888871ed5a7ab`.
- Base image: `ghcr.io/open-webui/open-webui@sha256:9591b13f13843c7721c2b8eaf7382846c81b3ffe126526d1888d1fed50c6a33f` (upstream v0.11.4, revision `8bd8b4fac5e059578ac0c74b3c18d11139f88b7d`).
- The overlay was ported from `local/open-webui:error-details-git-b790384bc31d587c75be2dc82bd9fcf04cd70054` (v0.11.3), whose sources are the historical files in `integrations/open-webui/`.

Later commits change these files; `git log` shows each change against this baseline.
