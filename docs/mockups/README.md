# Portal redesign mock-ups

Static, dependency-free mock-ups of the redesigned router portal, seeded with **real data captured
read-only from the production instance** (`http://192.168.1.23:11435`, 2026-10-22T21:47Z —
`/admin/api/{summary,hosts,requests,metrics,events}`, `:11434/v1/router/capabilities`, one
`/admin/api/generation-record`). Hosts, configuration ids, catalog revisions, models, aliases,
clients, counts, latencies and error codes are real; the per-minute *series shapes* in Signals are
illustrative (the router keeps no time series yet — that is part of the proposed work).

Open `portal-mockup.html` in a browser (no server, no build). Query flags:

| flag | effect |
|---|---|
| `?dense=1` | compact density variant (26 px rows, tighter type) |
| `?modal=1` | the request-detail modal over the dashboard |
| `?modal=1&reject=1` | the same modal for a refused request (no payload archive) |
| `?only=sec-requests` | isolate one section: `sec-configurations`, `sec-models`, `sec-signals`, `sec-requests`, `sec-state` |

`captured-production-data.json` is the seed the mock-up renders; `screenshots/` holds the review set
at 1600 px (desktop + dense) and 500 px (phone; headless Chrome clamps below 500 px).

## What each section answers

| section | question it answers |
|---|---|
| 01 Active configurations | which runtime configuration each machine is serving right now, which catalog revision the router accepted, who is draining, which warnings are attached |
| 02 Models | what can be asked of this router, on which machine, with what context/slots/capabilities, and how it is actually behaving (share, success, p50/p95, tokens) |
| 03 Signals | is it healthy in this window — request mix, latency, tokens, queue depth, who is calling, what changed (configuration publishes, drain flips, startup) |
| 04 Requests | every handled request: caller, protocol, requested→served model, machine, outcome, timings, tokens, and whether its payload archive survived |
| 05 Router state / retention | admission and drain state, listener map, retention budgets, and what is broken today (401s, unreachable capability feeds, wrong portal link) |
| Modal | one request in full: routing decision, stage timings, control negotiation, outcome, the actual prompt/payload from the generation journal, and the backend journal |

Design rules carried over from the current portal: GitHub-dark palette, no framework, no build step,
semantic HTML, `prefers-reduced-motion` respected, keyboard-operable tabs, no invented metrics
(`null` is shown as "backend silent", never as a zero).
