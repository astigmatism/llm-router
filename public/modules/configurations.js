/* 01 - Active configurations. One card per machine that publishes models here:
   the runtime configuration it is serving, the catalog revision this router
   accepted, whether it is draining, and the warnings attached to it. Catalogs
   are pushed by each machine and never polled, which is why the card explains
   where a machine comes from instead of implying discovery. */

import { ago, clock, DOT, escapeHtml, ms, pct, shortId, text } from './format.js';
import { icon } from './icons.js';
import { ROUTES } from './api.js';
import { viewUrl } from './state.js';

const q = (selector) => document.querySelector(selector);

function stateChip(entry) {
  if (entry.error) return { cls: 'bad', label: escapeHtml(entry.error.code || 'catalog error') };
  if (!entry.published) return { cls: 'mut', label: 'no catalog' };
  if (entry.draining) return { cls: 'warn', label: 'draining' };
  if (entry.online) return { cls: 'on', label: 'published ' + DOT + ' online' };
  return { cls: 'warn', label: 'published ' + DOT + ' no model answering' };
}

function hostCard(entry, options) {
  const cfg = entry.configuration || {};
  const chip = stateChip(entry);
  const windowLabel = options.windowLabel;
  // A router without /admin/api/portal/state has no per-host window on the host
  // document; /admin/api/stats reports the same figures under byHost, so the
  // card joins them instead of saying "no requests".
  const stats = options.state?.stats;
  const fromStats = (stats?.byHost || []).find((row) => row.key === entry.id) || {};
  const windowStats = { ...fromStats, ...(entry.window || {}) };
  const models = Array.isArray(entry.model_ids) ? entry.model_ids : [];
  const dotTone = entry.error || !entry.online ? 'bad' : entry.draining ? 'warn' : 'ok';
  const warnings = (entry.warnings || []).map((warning) => `<div class="warnbox"><span>${icon('warn')}</span>`
    + `<span class="msg"><b>${text(warning)}</b><br><span class="faint">Catalog max age `
    + `${options.catalogMaxAgeMs ? `${Math.round(options.catalogMaxAgeMs / 60000)}m` : 'disabled'};`
    + ` a stale catalog is still served, never averaged away.</span></span></div>`).join('');

  return `<article class="host ${entry.error ? 'off' : ''} ${entry.draining ? 'draining' : ''}" aria-label="${text(entry.id)}">
    <div class="host-top">
      <i class="dot ${dotTone}" title="${entry.online ? 'a model on this machine answers its health check' : 'no model on this machine answers the health check'}"></i>
      <h3>${text(entry.display_name || entry.id)}</h3>
      ${entry.default ? '<span class="chip role">default</span>' : ''}
      <span class="chip ${chip.cls}">${chip.label}</span>
      <span class="chip mut" title="hosts are declared in ROUTER_HOSTS, never discovered">${entry.resident ? 'resident catalog' : 'legacy marker'}</span>
      <span class="spacer"></span>
      <span class="mini faint">traffic</span>
      <span class="num">${entry.active == null ? '\u2014' : entry.active} <span class="faint">act</span> ${DOT} ${entry.queued == null ? '\u2014' : entry.queued} <span class="faint">qd</span></span>
    </div>
    <div class="host-grid">
      <div class="kv"><span class="k">configuration</span><span class="v" title="${text(cfg.id || '')}">${text(cfg.id || 'none published')}</span></div>
      <div class="kv"><span class="k">runtime</span><span class="v">rev ${shortId(cfg.runtime_revision, 12)} <span class="faint">${DOT} ${cfg.exclusive ? 'exclusive' : 'shared'}</span></span></div>
      <div class="kv"><span class="k">published</span><span class="v">${text(clock(cfg.published_at))} <span class="faint">${DOT} ${text(ago(cfg.published_at))}</span></span></div>
      <div class="kv"><span class="k">catalog</span><span class="v" title="${text(entry.revision || '')}">${shortId(entry.revision, 16)} <span class="faint">${text(entry.loaded_from || '')}</span></span></div>
      <div class="kv"><span class="k">models</span><span class="v">${models.length ? models.map((model) => `<a class="chip" href="${escapeHtml(viewUrl({ model, offset: 0 }))}">${text(model)}</a>`).join(' ') : '<span class="faint">\u2014</span>'}</span></div>
      <div class="kv"><span class="k">accepted</span><span class="v">${text(clock(entry.accepted_at))} <span class="faint">${DOT} ${text(entry.file || 'not stored in a file')}</span></span></div>
    </div>
    ${entry.error ? `<div class="warnbox bad"><span>${icon('warn')}</span><span class="msg"><b>${text(entry.error.code)}</b> ${text(entry.error.message)}<br><span class="faint">This machine contributes no models; the others keep serving. Requests for its models answer 503 with this code.</span></span></div>` : ''}
    ${warnings}
    ${entry.draining ? `<div class="warnbox"><span>${icon('pause')}</span><span class="msg">Draining - new requests for this machine's models answer <b>503 BACKEND_DRAINING</b>; accepted work finishes. Reason: ${text(entry.drain_reason || 'not stated')}</span></span></div>` : ''}
    <div class="host-foot">
      <button class="btn sm ${entry.draining ? 'primary' : ''}" type="button" data-drain-host="${text(entry.id)}" data-enabled="${entry.draining ? 'false' : 'true'}"${options.blocked ? ' disabled' : ''}
        title="${options.blocked
    ? `disabled: ${ROUTES.runtimeDrain} answered 401 ${text(options.blocked.code || '')}`
    : `POST ${ROUTES.runtimeDrain} with host ${text(entry.id)}`}">${entry.draining ? 'Resume traffic' : 'Drain for maintenance'}</button>
      <a class="btn sm ghost" href="${escapeHtml(`${ROUTES.events}?type=model_catalog_published&q=${encodeURIComponent(entry.id)}`)}" title="The published history of this machine, straight from the event feed">Publish history</a>
      <a class="btn sm ghost" href="${escapeHtml(`${ROUTES.hosts}?host=${encodeURIComponent(entry.id)}`)}" title="${ROUTES.hosts} answers the accepted catalog of every machine">Inspect catalog</a>
      <a class="btn sm ghost" href="${escapeHtml(viewUrl({ host: entry.id, offset: 0 }))}">Requests on this machine</a>
      <span class="spacer"></span>
      <span class="mini faint" title="Requests against this machine's models in ${text(windowLabel)} (portal/state hosts.window)">
        ${windowLabel}: ${windowStats.requests == null ? 'no requests' : `${windowStats.requests} req`}
        ${DOT} ${windowStats.successRate == null ? 'no outcomes' : `${pct(windowStats.successRate)} ok`}
        ${DOT} p95 ${ms(windowStats.p95Ms)}
      </span>
    </div>
  </article>`;
}

const RULE_CARD = `<article class="host rule" aria-label="How a machine joins">
  <div class="host-top"><i class="dot"></i><h3 class="muted">How a machine joins</h3></div>
  <p class="dim" style="font-size:11.8px;margin:0;line-height:1.65">
    Hosts are <b>declared</b> in <code class="mono">ROUTER_HOSTS</code>, in precedence order, with
    <code class="mono">ROUTER_DEFAULT_HOST</code> answering an unnamed request. Each machine pushes its own catalog
    with <code class="mono">PUT ${ROUTES.hosts}/&lt;host&gt;/catalog</code>; the router validates it at the door and keeps
    the previous one when a push is refused (<code class="mono">INVALID_MODEL_CATALOG</code>,
    <code class="mono">CATALOG_ID_CONFLICT</code>, <code class="mono">HOST_CATALOG_INCOMPATIBLE</code>). A machine that
    is switched off is reported as absent, never as a failure of the others.
  </p>
</article>`;

export function render(state) {
  const host = q('#hosts');
  const hint = q('#cfg-hint');
  const note = q('#cfg-error');
  if (!host) return;
  const portal = state.portal;
  if (!portal) {
    if (!host.childElementCount) host.innerHTML = '<p class="section-note">Loading the fleet from the router.</p>';
    return;
  }
  const hosts = portal.hosts || [];
  const fleet = portal.state?.fleet || {};
  const declared = fleet.hosts || hosts.map((entry) => entry.id);
  const windowLabel = state.view.window === 'all' ? 'since start' : state.view.window;

  if (hint) {
    hint.textContent = hosts.length
      ? `${hosts.length} publishing machine${hosts.length === 1 ? '' : 's'} (${declared.join(', ') || 'none declared'}) `
        + `${DOT} default ${fleet.defaultHost || hosts.find((entry) => entry.default)?.id || 'unset'} `
        + `${DOT} catalogs are pushed by each machine, never polled`
      : 'no machine has published a catalog to this router yet';
  }
  if (note) {
    const problem = state.notes.configurations;
    note.hidden = !problem;
    note.textContent = problem || '';
  }

  const options = { windowLabel, catalogMaxAgeMs: fleet.catalogMaxAgeMs || 0, blocked: state.controlBlocked, state };
  const cards = hosts.map((entry) => hostCard(entry, options)).join('');
  const offline = (portal.offlineServices || []).length;
  const signature = `${hosts.map((entry) => `${entry.id}:${entry.online}:${entry.draining}:${entry.active}:${entry.queued}:${entry.revision}`).join('|')}`
    + `|blocked:${state.controlBlocked ? state.controlBlocked.code || 'yes' : ''}`
    + `|${offline}|${state.view.window}|${state.notes.configurations || ''}`;
  if (host.dataset.sig === signature) return;
  host.dataset.sig = signature;
  host.innerHTML = cards + RULE_CARD;
}

export function wire(actions) {
  q('#hosts')?.addEventListener('click', (event) => {
    const button = event.target.closest('[data-drain-host]');
    if (!button) return;
    actions.drainHost(button.dataset.drainHost, button.dataset.enabled === 'true');
  });
}
