# Preserve managed generation failures through Responses

An upstream response containing reasoning alone can correctly fail the router's
empty-answer check and still reach Responses clients as `UPSTREAM_STREAM_FAILED`
(or, in non-streaming mode, `UPSTREAM_REQUEST_FAILED`). That loses the known
cause and obscures the difference between a completed empty backend response and
an interrupted stream.

The change gives router-generated session failures a specific error type and
preserves its code through all three Responses error boundaries. The error's
diagnostics carry its archive record ID, canonical backend model, backend kind,
optional catalog host and origin, observed finish reason, terminal-event flag,
available token counts and output-channel character counts. Public diagnostics
contain no request or reasoning text, URL credentials or query strings. The
generation terminal journal and request metadata retain the same diagnostics.
An error from an arbitrary external source does not gain permission to supply
its own public error code simply by having a `code` property.

There is no new inference retry and no output-channel change. The empty-answer
guard remains intact. A short, semantically unfinished non-empty answer remains
outside this guard's remit; the Strata investigation must assess the requested
task, tool execution and later continuation independently.

Validation used Node 24.19.0: 38 model-catalog integration tests passed, including
reasoning-only stops through streamed and non-streamed Responses for both
resident backends, archive correlation, admission release, and a broken-stream
control. The full 344-test suite passed with a temporary GNU-stat-interface
adapter outside the repository. On native macOS it passed 343/344: the existing
stale updater-lock test uses GNU `stat -c %Y`, which BSD stat does not support;
that failure was independently reproduced. No updater source or test was changed
to accommodate it. Syntax validation passed.

This source change has not been deployed. After separate authorization, publish
the reviewed source and use **Update and restart** on the router's Service Portal
card, following `docs/UPDATE_AND_RESTART.md`. Preserve the existing fleet,
credentials and catalog state; no AI Runtime model replacement is required.
Check an empty synthetic backend response through both Responses modes for
`EMPTY_UPSTREAM_RESPONSE` and matching `error.diagnostics.record_id`, backend,
finish reason and usage in the archive. Check a broken stream for its distinct
code. Verify normal tool calls and continuation still work and admission is
released after each failure. These checks qualify diagnostics, not Strata's
ability to finish the requested work.

Rollback is a reviewed source revert on the Mac: `git revert <diagnostic-commit>`,
run the router tests and syntax check, publish to main, then apply the same Portal
action after authorization. Do not edit a production checkout or running files
to roll it back. The diagnostic change does not migrate stored state; archives
with added fields remain ordinary JSONL records.
