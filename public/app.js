const output = document.querySelector('#control-output');
const requestFilter = document.querySelector('#request-filter');
let lastSummary = null;
let lastRequests = [];

const REQUEST_FILTER_KEY = 'router-admin-request-filter';
const PROMPT_CALLS = new Set([
  'POST /api/chat',
  'POST /api/generate',
  'POST /v1/responses',
  'POST /responses'
]);
const STATUS_CALLS = new Set([
  'GET /api/tags',
  'GET /api/version',
  'GET /api/ps',
  'POST /api/show'
]);

if (requestFilter) {
  const savedFilter = localStorage.getItem(REQUEST_FILTER_KEY) || 'all';
  if ([...requestFilter.options].some((option) => option.value === savedFilter)) {
    requestFilter.value = savedFilter;
  }
  requestFilter.addEventListener('change', () => {
    localStorage.setItem(REQUEST_FILTER_KEY, requestFilter.value);
    renderRequests(filterRequests(lastRequests, requestFilter.value));
  });
}

document.querySelector('#refresh').addEventListener('click', refresh);
document.querySelector('#prewarm').addEventListener('click', () => postControl('/admin/api/prewarm', { model: document.querySelector('#control-model').value }));
document.querySelector('#reload-config').addEventListener('click', () => postControl('/admin/api/reload-config', {}));
document.querySelector('#test-chat').addEventListener('click', () => postControl('/admin/api/test-chat', { model: document.querySelector('#control-model').value, prompt: 'Reply with a short router health check.' }));
document.querySelector('#toggle-maintenance').addEventListener('click', () => {
  const enabled = !(lastSummary && lastSummary.router && lastSummary.router.maintenanceMode);
  postControl('/admin/api/maintenance', { enabled });
});

function headers() {
  return { 'content-type': 'application/json', accept: 'application/json' };
}

async function getJson(url) {
  const response = await fetch(url, { headers: headers(), cache: 'no-store' });
  if (!response.ok) throw new Error(`${response.status} ${await response.text()}`);
  return response.json();
}

async function postControl(url, body) {
  output.textContent = 'Running...';
  try {
    const response = await fetch(url, { method: 'POST', headers: headers(), body: JSON.stringify(body) });
    const text = await response.text();
    output.textContent = text;
    refresh();
  } catch (error) {
    output.textContent = error.message;
  }
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function fmt(value) {
  if (value === null || value === undefined || value === '') return 'none';
  if (typeof value === 'number') return Number.isInteger(value) ? String(value) : value.toFixed(2);
  if (typeof value === 'boolean') return value ? 'yes' : 'no';
  return String(value);
}

function text(value) {
  return escapeHtml(fmt(value));
}

function card(label, value, className = '') {
  return `<div class="card"><div class="label">${text(label)}</div><div class="value ${className}">${text(value)}</div></div>`;
}

function modelContext(summary) {
  const marker = summary.activeModel?.raw || {};
  const loaded = summary.activeLoadedState?.raw || {};
  return marker.context || marker.num_ctx || marker.numCtx || marker.options?.num_ctx || loaded.context || loaded.context_length || 'not reported';
}

function uptime(value) {
  const seconds = Number(value || 0);
  if (!Number.isFinite(seconds)) return 'unknown';
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m ${seconds % 60}s`;
}

function renderCards(summary) {
  const loaded = summary.activeLoadedState || {};
  const upstreamClass = summary.upstream?.ok ? 'good' : 'danger';
  const loadedClass = loaded.loaded ? 'good' : 'warn';
  const metrics = summary.metrics || {};
  const config = summary.config || {};
  document.querySelector('#cards').innerHTML = [
    card('Default backend', summary.upstream?.ok ? 'healthy' : 'unavailable', upstreamClass),
    card('Active model', summary.activeModel?.model),
    card('Active loaded', loaded.loaded ? 'loaded' : 'not loaded', loadedClass),
    card('Context', modelContext(summary)),
    card('Loaded until', loaded.until || 'unknown'),
    card('Forced keep_alive', config.forcedKeepAlive),
    card('Router policy', config.modelPolicyMode),
    card('Model rewrite', config.rewriteRequestedModelToActive ? 'enabled' : 'disabled', config.rewriteRequestedModelToActive ? 'warn' : ''),
    card('Uptime', uptime(summary.router?.uptimeSeconds)),
    card('Requests', metrics.totalRequests || 0),
    card('Keep-alive rewrites', metrics.keepAliveNormalizations || 0),
    card('Rejected/errors', `${metrics.rejectedRequests || 0} / ${metrics.upstreamErrors || 0}`, metrics.rejectedRequests || metrics.upstreamErrors ? 'warn' : 'good')
  ].join('');
}

function kv(label, value) {
  return `<div class="kv"><div class="kv-label">${text(label)}</div><div class="kv-value">${text(value)}</div></div>`;
}

function renderPolicy(summary) {
  const config = summary.config || {};
  const active = summary.activeModel || {};
  const router = summary.router || {};
  const admin = router.admin || {};
  document.querySelector('#policy').innerHTML = [
    kv('API listener', `${router.api?.host || config.host}:${router.api?.port || config.port}`),
    kv('Admin listener', admin.enabled ? `${admin.bindHost}:${admin.port}` : 'disabled'),
    kv('Admin portal auth', admin.authRequired ? 'required' : 'not required'),
    kv('Policy mode', config.modelPolicyMode),
    kv('Rewrite requested model to active', config.rewriteRequestedModelToActive),
    kv('Forced keep_alive', config.forcedKeepAlive),
    kv('Protected endpoints', (config.protectedModelEndpoints || []).join(', ')),
    kv('Active marker source', active.source),
    kv('Active marker loaded from', active.loadedFrom),
    kv('Marker keep_alive', active.keep_alive),
    kv('Marker updated at', active.updated_at || active.file_mtime),
    kv('Upstream URL', config.upstreamUrl)
  ].join('');
}

function renderIssues(summary) {
  const issues = summary.recentRejectsOrErrors || [];
  const retentionError = summary.logs?.generationRetention?.lastError;
  const retentionIssue = retentionError
    ? `<div class="issue"><strong>Archive cleanup failed</strong> ${text(retentionError.message)}. Cleanup will retry automatically.</div>`
    : '';
  if (!issues.length) {
    document.querySelector('#issues').innerHTML = retentionIssue || '<p class="empty">No recent rejects or upstream errors.</p>';
    return;
  }
  document.querySelector('#issues').innerHTML = retentionIssue + issues.map((row) => `<div class="issue">
    <div><strong>${text(row.errorCode || row.responseStatus || row.status)}</strong> ${text(row.errorSummary || row.endpoint)}</div>
    <div class="event-time">${text(row.ts)} · ${text(row.method)} ${text(row.endpoint)} · ${text(row.clientIdentity)}</div>
  </div>`).join('');
}

function classifyRequest(row) {
  const key = `${row.method || 'GET'} ${row.endpoint || ''}`;
  if (PROMPT_CALLS.has(key)) return 'prompt';
  if (STATUS_CALLS.has(key)) return 'status';
  return 'other';
}

function filterRequests(rows, filter) {
  if (!filter || filter === 'all') return rows;
  return rows.filter((row) => classifyRequest(row) === filter);
}

function renderRequests(rows) {
  const table = document.querySelector('#requests-table');
  const header = '<tr><th>Time</th><th>Client</th><th>Endpoint</th><th>Model</th><th>Thinking</th><th>Keep alive</th><th>Status</th><th>Latency</th></tr>';
  if (!rows.length) {
    table.innerHTML = header + '<tr><td colspan="8">No requests match this filter.</td></tr>';
    return;
  }
  const body = rows.map((row) => {
    const statusClass = row.rejected || row.upstreamError ? 'warn' : 'good';
    return `<tr>
      <td>${text(row.ts)}</td>
      <td>${text(row.clientIdentity)}<br><span class="event-time">${text(row.sourceIp)}</span></td>
      <td>${text(row.method)} ${text(row.endpoint)}</td>
      <td>${text(row.modelRewritten ? `${row.requestedModel} -> ${row.forwardedModel}` : row.forwardedModel || row.requestedModel)}</td>
      <td>${thinkCell(row)}</td>
      <td>in: ${text(row.incomingKeepAlive)}<br>out: ${text(row.forwardedKeepAlive)}</td>
      <td class="${statusClass}">${text(row.responseStatus || row.status)}</td>
      <td>${text(row.latencyMs)} ms</td>
    </tr>`;
  }).join('');
  table.innerHTML = header + body;
}

function thinkValue(value) {
  if (value === undefined || value === null) return 'not set';
  if (typeof value === 'boolean') return value ? 'on' : 'off';
  return String(value);
}

function thinkCell(row) {
  const dropped = row.thinkDropped === true
    || (row.thinkDropped === undefined && row.thinkNormalized && row.forwardedThink === undefined);
  const lines = [
    `in: ${text(thinkValue(row.incomingThink))}`,
    `out: ${text(dropped ? 'dropped' : thinkValue(row.forwardedThink))}`
  ];
  if (row.incomingReasoningEffort) lines.push(`request effort: ${text(row.incomingReasoningEffort)}`);
  else if (row.reasoningEffort) lines.push(`effective effort: ${text(row.reasoningEffort)}`);
  if (row.thinkMapped && !dropped) lines.push('<span class="event-time">mapped by active profile</span>');
  if (dropped) lines.push('<span class="event-time">control dropped: model lacks thinking</span>');
  return lines.join('<br>');
}

function renderEvents(events) {
  if (!events.length) {
    document.querySelector('#events').innerHTML = '<p class="empty">No events yet.</p>';
    return;
  }
  document.querySelector('#events').innerHTML = events.map((event) => `<div class="event"><div>${text(event.type)}</div><div class="event-time">${text(event.ts)}</div><pre>${text(JSON.stringify(event, null, 2))}</pre></div>`).join('');
}

async function refresh() {
  try {
    const [summary, requests, events] = await Promise.all([
      getJson('/admin/api/summary'),
      getJson('/admin/api/requests?limit=100'),
      getJson('/admin/api/events?limit=50')
    ]);
    lastSummary = summary;
    renderCards(summary);
    const models = summary.models || [];
    document.querySelector('#model-catalog').innerHTML = '<table><tr><th>Model</th><th>Health</th><th>Context</th><th>Slots</th><th>Capabilities</th><th>Aliases</th></tr>' + models.map((entry) => {
      const meta = entry.x_ollama_router;
      return `<tr><td>${text(meta.display_name ?? meta.upstream_model)}</td><td>${text(meta.health?.available ? 'healthy' : 'unavailable')}</td><td>${text(meta.context_window)}</td><td>${text(meta.active_request_limit)}</td><td>${text(meta.capabilities?.join(', '))}</td><td>${text(meta.aliases?.join(', '))}</td></tr>`;
    }).join('') + '</table>';
    const picker = document.querySelector('#control-model');
    const previous = picker.value;
    picker.innerHTML = models.map((entry) => `<option value="${text(entry.id)}">${text(entry.x_ollama_router?.display_name ?? entry.id)}</option>`).join('');
    if (models.some((entry) => entry.id === previous)) picker.value = previous;
    renderPolicy(summary);
    renderIssues(summary);
    lastRequests = requests.requests || [];
    renderRequests(filterRequests(lastRequests, requestFilter ? requestFilter.value : 'all'));
    renderEvents(events.events || []);
    document.querySelector('#ps').textContent = JSON.stringify(summary.models || summary.ollamaPs, null, 2);
    document.querySelector('#metrics').textContent = JSON.stringify(summary.metrics, null, 2);
  } catch (error) {
    document.querySelector('#cards').innerHTML = card('Dashboard error', error.message, 'danger');
    document.querySelector('#policy').innerHTML = '';
    document.querySelector('#issues').innerHTML = '';
  }
}

refresh();
setInterval(refresh, 10000);
