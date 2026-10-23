/* The chrome: brand line, host pills, statistics window, the live chip and the
   state strip. The strip is the "is this router healthy right now" row -
   admission, in-flight, window aggregates and the archive budget. Every figure
   names the endpoint it came from in its title, because the aggregates may
   legitimately be missing on a router that predates /admin/api/stats. */

import { ago, bytes, clock, DOT, escapeHtml, exactNumber, ms, num, text, uptime } from './format.js';
import { icon } from './icons.js';
import { setView, WINDOW_LABELS, WINDOWS, viewUrl } from './state.js';

const q = (selector) => document.querySelector(selector);

let handlers = {};

export function configure(next) {
  handlers = next;
}

export function mountChrome() {
  const search = q('#search-form');
  const input = q('#search-input');
  const iconSlot = q('#search-icon');
  if (iconSlot) iconSlot.innerHTML = icon('search');
  const refresh = q('#refresh-button');
  if (refresh) refresh.innerHTML = `${icon('refresh')}<span class="sr-only">Refresh now</span>`;
  const actionsButton = q('#actions-button');
  if (actionsButton) actionsButton.innerHTML = `Actions ${icon('chev')}`;

  if (search) {
    search.addEventListener('submit', (event) => {
      event.preventDefault();
      setView({ q: (input?.value || '').trim(), offset: 0 });
    });
  }
  let debounce = null;
  if (input) {
    input.addEventListener('input', () => {
      clearTimeout(debounce);
      debounce = setTimeout(() => setView({ q: input.value.trim(), offset: 0 }), 350);
    });
  }
  document.addEventListener('keydown', (event) => {
    if ((event.ctrlKey || event.metaKey) && String(event.key).toLowerCase() === 'k') {
      event.preventDefault();
      input?.focus();
      input?.select();
    }
  });

  for (const selector of ['#refresh-button', '#refresh-all-button']) {
    q(selector)?.addEventListener('click', () => handlers.refresh?.());
  }
  q('#pause-button')?.addEventListener('click', () => handlers.togglePause?.());
  q('#actions-button')?.addEventListener('click', () => handlers.toggleDrawer?.());
}

/* Buttons are built once and only their pressed state is touched afterwards, so
   keyboard focus on a window button survives a live-update frame. */
function renderWindowSeg(view) {
  const host = q('#window-seg');
  if (!host) return;
  if (host.childElementCount !== WINDOWS.length) {
    host.innerHTML = WINDOWS.map((key) => `<button type="button" data-window="${key}">${WINDOW_LABELS[key]}</button>`).join('');
    host.addEventListener('click', (event) => {
      const button = event.target.closest('[data-window]');
      if (!button) return;
      setView({ window: button.dataset.window, offset: 0 });
      handlers.windowChanged?.(button.dataset.window);
    });
  }
  for (const button of host.querySelectorAll('[data-window]')) {
    button.setAttribute('aria-pressed', button.dataset.window === view.window ? 'true' : 'false');
  }
}

function renderLive(state) {
  const chip = q('#live-chip');
  const button = q('#pause-button');
  const live = state.live;
  const mode = state.paused ? 'paused' : live.mode;
  const tone = mode === 'live' ? 'ok' : mode === 'connecting' || mode === 'reconnecting' ? 'warn' : 'bad';
  const iconKey = mode === 'polling' ? 'polling' : mode === 'paused' ? 'pause' : 'live';
  const freshness = live.lastEventAt ? ago(live.lastEventAt) : 'no events yet';
  const reason = state.paused
    ? 'Paused by you. Nothing is lost: resuming refetches this page.'
    : live.reason;
  if (chip) {
    chip.innerHTML = `<i class="dot ${tone} ${mode === 'live' ? 'live' : ''}"></i>${icon(iconKey)} ${mode} <b class="faint">${text(freshness)}</b>`;
    chip.title = `${reason}\n/admin/api/stream carries request, event, drain, capabilities and heartbeat events.`;
  }
  if (button) {
    button.innerHTML = `${icon(state.paused ? 'play' : 'pause')} ${state.paused ? 'Resume' : 'Pause'}`;
    button.setAttribute('aria-pressed', state.paused ? 'true' : 'false');
    button.title = state.paused
      ? 'Resume the live subscription and refetch this page'
      : 'Pause live updates. The current view stays on screen.';
  }
}

function renderPills(state) {
  const host = q('#hostpills');
  if (!host) return;
  const list = state.portal?.hosts;
  if (!list) return;
  const signature = list.map((entry) => `${entry.id}:${entry.online}:${entry.draining}:${entry.default}`).join('|');
  if (host.dataset.sig === signature) return;
  host.dataset.sig = signature;
  host.innerHTML = list.map((entry) => {
    const models = Array.isArray(entry.model_ids) ? entry.model_ids.length : 0;
    const tone = entry.error || !entry.online ? 'bad' : entry.draining ? 'warn' : 'ok';
    const status = entry.error
      ? text(entry.error.code)
      : !entry.published
        ? 'no catalog'
        : entry.draining
          ? `draining${entry.drain_reason ? ` (${text(entry.drain_reason)})` : ''}`
          : entry.online
            ? 'online'
            : 'no model answering';
    const href = viewUrl({ host: entry.id, offset: 0 });
    return `<a class="pill" href="${href}" title="${text(entry.id)} ${DOT} ${models === 1 ? '1 model' : `${models} models`} ${DOT} ${status}">`
      + `<i class="dot ${tone}"></i><b>${text(entry.display_name || entry.id)}</b>`
      + `${entry.default ? '<span class="tag">default</span>' : ''}</a>`;
  }).join('');
}

function item(key, value, extra = '', title = '') {
  return `<div class="sb"${title ? ` title="${escapeHtml(title)}"` : ''}><span class="k">${key}</span>${value}${extra}</div>`;
}

function renderStatebar(state) {
  const host = q('#statebar');
  if (!host) return;
  const portal = state.portal || {};
  const router = portal.router || {};
  const runtime = portal.state || {};
  const metrics = portal.metrics || {};
  const totals = state.stats?.totals || null;
  const latency = state.stats?.latencyMs || metrics.latencyMs || {};
  const tokens = state.stats?.tokens || metrics.tokens || {};
  const retention = runtime.retention || {};
  const archives = retention.archives || {};
  const hosts = portal.hosts || [];
  const published = hosts.filter((entry) => entry.published).length;
  const warnings = hosts.reduce((sum, entry) => sum + (entry.warnings?.length || 0), 0);
  const admission = runtime.admission || (runtime.draining ? 'draining' : router.maintenanceMode ? 'maintenance' : null);
  const inFlight = runtime.inFlight || {};
  const windowLabel = WINDOW_LABELS[state.view.window] || state.view.window;
  const aggregatesFromStats = !!totals;
  const aggregateSource = aggregatesFromStats
    ? `/admin/api/stats?window=${state.view.window}`
    : '/admin/api/metrics since start; this router does not expose /admin/api/stats yet';

  const allowed = totals ? totals.allowed : metrics.allowedRequests;
  const rejected = totals ? totals.rejected : metrics.rejectedRequests;
  const upstream = totals ? totals.upstreamErrors : metrics.upstreamErrors;
  const unknown = '<span class="faint">unknown</span>';

  const items = [
    item('Admission',
      `<span class="v ${admission === 'accepting' ? 'good' : admission ? 'warn' : ''}">${text(admission || 'not reported')}</span>`,
      runtime.maintenanceMode ? `<span class="chip warn">maintenance</span>` : '',
      'Admission state of this router (portal/state.state.admission)'),
    item('Hosts published', `<span class="v">${published} / ${hosts.length}</span>`,
      warnings
        ? `<span class="chip warn">${warnings} warning${warnings === 1 ? '' : 's'}</span>`
        : '<span class="chip on">no warnings</span>',
      'Machines whose catalog this router accepted and is serving'),
    item('In flight',
      `<span class="v">${inFlight.active == null ? unknown : exactNumber(inFlight.active)} active</span>`
      + `<span class="muted">${DOT}</span><span class="v">${inFlight.queued == null ? unknown : exactNumber(inFlight.queued)} queued</span>`,
      '', 'Admitted requests being served and waiting for a slot'),
    item(`Requests ${windowLabel}`,
      `<span class="v good">${allowed == null ? unknown : num(allowed)}</span> allowed`
      + `<span class="muted">${DOT}</span><span class="v warn">${rejected == null ? unknown : exactNumber(rejected)}</span> rejected`
      + `<span class="muted">${DOT}</span><span class="v danger">${upstream == null ? unknown : exactNumber(upstream)}</span> upstream`,
      `<span class="mini faint">${aggregatesFromStats ? 'stats' : 'since start'}</span>`, aggregateSource),
    item(`Latency p50/p95 ${windowLabel}`,
      `<span class="v">${ms(latency.p50)}</span><span class="muted">/</span>`
      + `<span class="v ${typeof latency.p95 === 'number' && latency.p95 > 20000 ? 'warn' : ''}">${ms(latency.p95)}</span>`
      + `<span class="muted">/ ${latency.samples == null ? 'no samples' : `${exactNumber(latency.samples)} samples`}</span>`,
      '', aggregateSource),
    item('Tokens in / out',
      `<span class="v">${num(tokens.prompt ?? tokens.input)}</span><span class="muted">/</span><span class="v">${num(tokens.output)}</span>`,
      '', aggregateSource),
    item('Uptime', `<span class="v">${uptime(router.uptimeSeconds)}</span>`,
      `<span class="muted">since ${text(clock(router.startedAt))}</span>`, 'router.startedAt / uptimeSeconds'),
    item('Archives',
      `<span class="v">${archives.activeFiles == null && archives.closedFiles == null ? unknown : exactNumber((archives.activeFiles || 0) + (archives.closedFiles || 0))}</span>`,
      `<span class="muted">of ${retention.generationRetentionDays == null ? '?' : `${retention.generationRetentionDays}d`} / ${bytes(retention.generationMaxBytes)}</span>`,
      'Generation journals kept for prompt payloads (portal/state.state.retention)')
  ];

  const signature = `${published}|${warnings}|${admission}|${runtime.maintenanceMode}|${inFlight.active}|${inFlight.queued}`
    + `|${allowed}|${rejected}|${upstream}|${latency.p50}|${latency.p95}|${latency.samples}|${tokens.prompt}|${tokens.input}|${tokens.output}`
    + `|${router.uptimeSeconds}|${archives.activeFiles}|${archives.closedFiles}|${state.view.window}`;
  if (host.dataset.sig === signature) return;
  host.dataset.sig = signature;
  host.innerHTML = items.join('');
}

export function render(state) {
  const router = state.portal?.router || {};
  const version = q('#router-version');
  if (version && router.version) version.textContent = `v${router.version}`;
  const address = q('#router-address');
  if (address) address.textContent = `Observability ${DOT} ${window.location.host}`;
  const caprev = q('#caprev');
  if (caprev) {
    const revision = state.portal?.state?.capabilities?.revision || state.capabilities?.revision || '';
    caprev.textContent = revision ? revision.slice(0, 16) : '\u2014';
    caprev.title = revision ? `capabilities revision ${revision}` : 'no capabilities document observed yet';
  }
  renderWindowSeg(state.view);
  renderLive(state);
  renderPills(state);
  renderStatebar(state);
}
