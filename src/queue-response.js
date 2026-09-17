// Streaming callers receive protocol-neutral keepalives while waiting. JSON
// callers retain the eventual HTTP status; never commit a premature 200 for them.
export function queueHeartbeat(response, protocol, { model, intervalMs = 15000 } = {}) {
  if (!protocol) return () => {};
  response.writeHead(200, {
    'content-type': protocol === 'native' ? 'application/x-ndjson; charset=utf-8' : 'text/event-stream; charset=utf-8',
    'cache-control': 'no-store',
    'x-accel-buffering': 'no',
    'x-ollama-router': 'llm-router'
  });
  const beat = () => {
    if (!response.destroyed && !response.writableEnded && !response.writableNeedDrain) {
      // Open WebUI parses every native line as JSON, including empty lines.
      // An empty nonterminal Ollama frame keeps that parser and the socket alive.
      response.write(protocol === 'native' ? `${JSON.stringify({ model, created_at: new Date().toISOString(),
        message: { role: 'assistant', content: '' }, response: '', done: false,
        x_router: { status: 'in_progress' } })}\n` : ': waiting for inference slot\n\n');
    }
  };
  beat();
  const timer = setInterval(beat, intervalMs);
  timer.unref?.();
  const stop = () => { clearInterval(timer); response.off('close', stop); };
  response.once('close', stop);
  return stop;
}

export function endQueuedError(response, protocol, error) {
  if (response.destroyed || response.writableEnded) return;
  const x_router = { status: 'incomplete', stop_reason: error.code };
  if (protocol === 'native') {
    response.end(`${JSON.stringify({ error: error.message, done: true, done_reason: 'error', x_router })}\n`);
  } else {
    response.end(`data: ${JSON.stringify({ ...(protocol === 'responses' ? { type: 'error', ...error } : {}), error, x_router })}\n\ndata: [DONE]\n\n`);
  }
}

export function connectionAbort(request, response) {
  const controller = new AbortController();
  const abort = () => { if (!response.writableEnded) controller.abort(new Error('Client disconnected.')); };
  request.once('aborted', abort);
  response.once('close', abort);
  if (request.aborted || response.destroyed) abort();
  return { signal: controller.signal, cleanup: () => { request.off('aborted', abort); response.off('close', abort); } };
}
