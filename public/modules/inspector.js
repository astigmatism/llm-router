/* 05 - Router state, retention and what is broken today. This is the card an
   operator reads when the portal itself is the suspect: which listener answers
   where, what the retention budgets are and how full they are, which
   capabilities document the router published, and every degradation this page
   noticed while loading (a missing aggregate endpoint, a missing stream, a
   control route behind a token). */

import { ago, bytes, DOT, escapeHtml, exactNumber, text } from './format.js';
import { icon } from './icons.js';
import { ROUTES } from './api.js';
import { viewUrl } from './state.js';

const q = (selector) => document.querySelector(selector);

function krow(label, value) {
  return `<div class="krow"><span class="k">${label}</span><span class="v">${value}</span></div>`;
}

function card(title, rows, extra = '') {
  return `<div class="card"><h4>${title}</h4><div style="margin-top:8px">${rows.join('')}</div>${extra}</div>`;
}

function retentionRows(state) {
  const retention = state.portal?.state?.retention || {};
  const archives = retention.archives || {};
  const lastError = archives.lastError;
  return [
    krow('Request history', retention.requestHistoryLimit == null
      ? '<span class="faint">not reported by this router</span>'
      : `${exactNumber(retention.requestHistoryLimit)} records ${DOT} ${bytes(retention.requestLogMaxBytes)} of snapshot`),
    krow('Event history', retention.eventHistoryLimit == null
      ? '<span class="faint">not reported</span>'
      : `${exactNumber(retention.eventHistoryLimit)} records`),
    krow('Prompt logging', `${text(retention.promptLogging || 'not reported')} ${DOT} the request log keeps ${retention.promptLogging === 'full' ? 'the body' : 'roles and counts, never the text'}`),
    krow('Generation archives', `${exactNumber(archives.activeFiles ?? 0)} open ${DOT} ${exactNumber(archives.closedFiles ?? 0)} closed ${DOT} ${bytes(archives.closedBytes)} of ${bytes(retention.generationMaxBytes)}`),
    krow('Archive window', retention.generationRetentionDays == null
      ? '<span class="faint">not reported</span>'
      : `${retention.generationRetentionDays} days, oldest first; journals still being written are protected`),
    krow('Last sweep', `${escapeHtml(ago(archives.lastRunAt))} ${DOT} ${lastError
      ? `<span class="danger">${escapeHtml(lastError.code || lastError.message || 'failed')}</span>`
      : '<span class="good">ok</span>'}`),
    krow('View budget', `the journal view reads at most ${escapeHtml('GENERATION_JOURNAL_VIEW_BYTES')} (4 MiB default) and says when it truncated`),
    krow('Payload readers', `<span class="mono">${escapeHtml(ROUTES.journal(':id'))}</span> ${DOT} bounded projection<br><span class="mono">${escapeHtml(`${ROUTES.generationRecord}?id=\u2026`)}</span> ${DOT} untouched NDJSON`)
  ];
}

function degradationRows(state) {
  const rows = [];
  const notes = state.notes || {};
  const order = [
    ['portal', 'Portal state'],
    ['stats', 'Aggregates'],
    ['stream', 'Live stream'],
    ['controls', 'Control routes'],
    ['events', 'Event feed'],
    ['capabilities', 'Capabilities']
  ];
  for (const [key, label] of order) {
    if (!notes[key]) continue;
    rows.push(krow(label, `<span class="chip warn">${icon('warn')} degraded</span> ${escapeHtml(notes[key])}`));
  }
  const blocked = state.controlBlocked;
  if (blocked && !notes.controls) {
    rows.push(krow('Control routes', `<span class="chip warn">${escapeHtml(blocked.code || 'ADMIN_AUTH_REQUIRED')}</span> ${escapeHtml(blocked.message || '')}`));
  }
  if (!rows.length) {
    rows.push(krow('This page', `<span class="chip on">all endpoints answered</span> ${escapeHtml(`${ROUTES.portalState}, ${ROUTES.stats}, ${ROUTES.events}, ${ROUTES.capabilities} and ${ROUTES.stream} all responded.`)}`));
  }
  return rows;
}

export function render(state) {
  const host = q('#ops');
  if (!host) return;
  const portal = state.portal;
  if (!portal) {
    host.innerHTML = '<div class="card"><h4>Router state</h4><p class="section-note" style="margin:8px 0 0">Loading.</p></div>';
    return;
  }
  const runtime = portal.state || {};
  const listeners = runtime.listeners || {};
  const router = portal.router || {};
  const capabilities = runtime.capabilities || {};
  const offline = portal.offlineServices || [];
  const warnings = portal.warnings || [];
  const draining = (portal.hosts || []).filter((entry) => entry.draining);

  const stateRows = [
    krow('Admission', `<span class="${runtime.admission === 'accepting' ? 'good' : 'warn'}">${text(runtime.admission || (runtime.maintenanceMode ? 'maintenance' : 'not reported'))}</span>`
      + (runtime.draining ? ` ${DOT} draining` : '') + (runtime.maintenanceMode ? ` ${DOT} maintenance` : '')),
    krow('API listener', `<span class="mono">${text(listeners.api?.host || router.api?.host || '?')}:${text(listeners.api?.port ?? router.api?.port ?? '?')}</span> ${DOT} client-facing, token applies`),
    krow('Admin portal', `<span class="mono">${text(listeners.admin?.host || router.admin?.bindHost || '?')}:${text(listeners.admin?.port ?? router.admin?.port ?? '?')}</span> ${DOT} ${listeners.admin?.authRequired ? 'token required' : 'unauthenticated by design'}`),
    krow('In flight', `${exactNumber(runtime.inFlight?.active ?? 0)} active ${DOT} ${exactNumber(runtime.inFlight?.queued ?? 0)} queued`
      + (Object.keys(runtime.inFlight?.byHost || {}).length
        ? ` ${DOT} ${Object.entries(runtime.inFlight?.byHost || {}).map(([id, count]) => `${escapeHtml(id)} ${exactNumber(count)}`).join(', ')}`
        : '')),
    krow('Draining machines', draining.length
      ? draining.map((entry) => `<span class="chip warn">${escapeHtml(entry.id)}${entry.drain_reason ? ` ${DOT} ${escapeHtml(entry.drain_reason)}` : ''}</span>`).join(' ')
      : '<span class="chip on">none</span>'),
    krow('Capabilities', `<span class="mono">${escapeHtml(String(capabilities.revision || '\u2014').slice(0, 12))}</span> ${DOT} observed ${escapeHtml(ago(capabilities.observedAt))} ${DOT} ${capabilities.complete ? 'complete' : '<span class="warn">incomplete</span>'}`),
    ...(capabilities.warnings || []).map((warning) => krow('Capability warning', `<span class="warn">${escapeHtml(warning)}</span>`)),
    krow('Offline services', offline.length
      ? offline.map((service) => `<span class="chip bad">${escapeHtml(service.model)} ${DOT} ${escapeHtml(service.errorCode || 'SERVICE_OFFLINE')}</span>`).join(' ')
      : '<span class="chip on">none declared</span>'),
    krow('Selectable models', `<a href="${escapeHtml(viewUrl({}))}#sec-models">${exactNumber((portal.models || []).length)} models across ${exactNumber((portal.hosts || []).length)} machines</a>`)
  ];

  const routerWarnings = warnings.length
    ? `<div class="notice warn" style="margin:12px 0 0">${icon('warn')}<span><b>${exactNumber(warnings.length)} router advisory.</b> ${warnings.map((warning) => escapeHtml(warning)).join('<br>')}</span></div>`
    : '';

  host.innerHTML = card('Retention and storage', retentionRows(state),
    `<div class="notice" style="margin:12px 0 0">${icon('archive')}<span>Archives hold the <b>complete prompt and every backend attempt</b>. On the unauthenticated admin port that is a deliberate trade: the portal port stays LAN-only, and payload reads are the reason.</span></div>`)
    + card('Listeners, policy and what is degraded', degradationRows(state).concat(stateRows), routerWarnings);

}
