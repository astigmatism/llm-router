/* The Actions drawer: the control routes (section 10) with their bodies visible in the
   confirmation text, because these buttons change what the router admits. A 401
   from an older router behind a token disables the whole group and quotes the
   reason instead of failing silently in the corner of the screen. */

import { DOT, escapeHtml, text } from './format.js';
import { icon } from './icons.js';
import { postJson, ROUTES } from './api.js';
import { dropNote, get, note, set } from './state.js';

const q = (selector) => document.querySelector(selector);

let handlers = {};

export function configure(next) {
  handlers = next;
}

function out(message, tone = '') {
  const pre = q('#drawer-out');
  if (!pre) return;
  pre.hidden = false;
  pre.className = `out ${tone}`;
  pre.textContent = message;
}

function describe(response) {
  if (response.ok) return `${response.status} ${JSON.stringify(response.data ?? {}).slice(0, 400)}`;
  return `${response.status} ${response.code} ${DOT} ${response.message || 'no message'}`;
}

async function control(route, body, label) {
  out(`${label} ${DOT} running`);
  const response = await postJson(route, body);
  out(`${label}: ${describe(response)}`, response.ok ? 'good' : response.status === 401 ? 'warn' : 'danger');
  if (response.status === 401) {
    note('controls', `${route} answered 401 ${response.code || 'ADMIN_AUTH_REQUIRED'}: this router still demands the admin token on the portal port, so the control buttons are disabled here.`);
    set({ controlBlocked: { route, code: response.code, message: response.message } });
    return response;
  }
  dropNote('controls');
  if (response.ok) set({ controlBlocked: null });
  handlers.refresh?.({ reason: 'control' });
  return response;
}

function group(title, rows, hint) {
  const blocked = get().controlBlocked;
  return `<div class="grp"><h3>${title}</h3>${hint ? `<p class="section-note" style="margin:0 0 8px">${hint}</p>` : ''}
    <div class="row"${blocked ? ' title="controls disabled: 401 from the router"' : ''}>${rows.map((row) => `<button class="btn sm ${row.primary ? 'primary' : 'ghost'}" type="button" data-action="${escapeHtml(row.action)}" data-arg="${escapeHtml(row.arg ?? '')}"${blocked ? ' disabled' : ''}>${row.label}</button>`).join('')}</div>
  </div>`;
}

export function render(state) {
  const body = q('#drawer-body');
  if (!body) return;
  const hosts = state.portal?.hosts || [];
  const models = state.portal?.models || [];
  const runtime = state.portal?.state || {};
  const blocked = state.controlBlocked;
  const signature = `${hosts.map((entry) => `${entry.id}:${entry.draining}`).join('|')}|${runtime.maintenanceMode}|${runtime.draining}|${models.length}|${blocked?.code || ''}|${state.drawerOpen}`;
  if (body.dataset.sig === signature) return;
  body.dataset.sig = signature;

  const hostRows = hosts.length
    ? hosts.map((entry) => group(
      `Machine ${escapeHtml(entry.display_name || entry.id)}`,
      [{
        action: 'drain',
        arg: entry.id,
        primary: !entry.draining,
        label: `${entry.draining ? 'Resume traffic' : 'Drain'} ${icon(entry.draining ? 'play' : 'pause')} <span class="faint">${text(entry.active ?? 0)} active</span>`
      }],
      entry.draining
        ? `Draining ${DOT} new requests for this machine's models answer 503 BACKEND_DRAINING; work already admitted finishes.`
        : `Draining is per machine: the rest of the fleet keeps answering.`
    )).join('')
    : '<div class="grp"><p class="section-note" style="margin:0">No machine has published a catalog to this router.</p></div>';

  body.innerHTML = hostRows
    + group('This router',
      [
        { action: 'router-drain', primary: !runtime.draining, label: `${runtime.draining ? 'Resume admission' : 'Drain the whole router'}` },
        { action: 'maintenance', label: runtime.maintenanceMode ? 'Leave maintenance' : 'Enter maintenance' },
        { action: 'reload', label: 'Reload active marker' }
      ],
      `Admission today: <b>${escapeHtml(runtime.admission || (runtime.maintenanceMode ? 'maintenance' : 'unknown'))}</b>. Drain and maintenance are POSTs to ${escapeHtml(ROUTES.runtimeDrain)} and ${escapeHtml(ROUTES.maintenance)}; reload re-reads the active-model marker.`)
    + group('Prewarm',
      [{ action: 'prewarm', primary: true, label: `Load selected model ${icon('bolt')}` }],
      `<select id="prewarm-model" aria-label="Model to prewarm" style="height:28px">${models.map((model) => `<option value="${escapeHtml(model.id)}">${text(model.service || model.id)}</option>`).join('') || '<option value="">no models</option>'}</select>`)
    + (blocked
      ? `<div class="grp"><p class="section-note" style="margin:0;color:var(--warn)">${escapeHtml(blocked.code || 'ADMIN_AUTH_REQUIRED')} ${DOT} ${escapeHtml(blocked.message || 'the router asked for a token')} The buttons are disabled until this router serves the control routes without a token on the admin port.</p></div>`
      : '');
}

export function toggle(force) {
  const open = typeof force === 'boolean' ? force : !get().drawerOpen;
  set({ drawerOpen: open });
  q('#actions-drawer')?.toggleAttribute('hidden', !open);
  q('#drawer-scrim')?.toggleAttribute('hidden', !open);
  q('#actions-button')?.setAttribute('aria-expanded', open ? 'true' : 'false');
  if (open) q('#drawer-close')?.focus();
  else q('#actions-button')?.focus();
}

export function wire(next) {
  handlers = next;
  const drawer = q('#actions-drawer');
  q('#drawer-close')?.addEventListener('click', () => toggle(false));
  q('#drawer-scrim')?.addEventListener('click', () => toggle(false));
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && get().drawerOpen) toggle(false);
  });
  drawer?.addEventListener('click', (event) => {
    const button = event.target.closest('[data-action]');
    if (!button) return;
    const { action, arg } = button.dataset;
    if (action === 'drain') drainHost(arg, !(get().portal?.hosts || []).find((entry) => entry.id === arg)?.draining);
    else if (action === 'router-drain') control(ROUTES.runtimeDrain, { enabled: !(get().portal?.state?.draining), reason: 'drained from the portal' }, 'Router drain');
    else if (action === 'maintenance') control(ROUTES.maintenance, { enabled: !(get().portal?.state?.maintenanceMode) }, 'Maintenance');
    else if (action === 'reload') control(ROUTES.reloadConfig, {}, 'Reload config');
    else if (action === 'prewarm') {
      const model = q('#prewarm-model')?.value;
      if (model) control(ROUTES.prewarm, { model }, 'Prewarm');
      else out('No model to prewarm: this router has none published.');
    }
  });
}

export function drainHost(host, enabled) {
  return control(ROUTES.runtimeDrain, {
    enabled,
    host,
    reason: enabled ? 'drained from the admin portal' : null
  }, `${enabled ? 'Drain' : 'Resume'} ${host}`);
}
