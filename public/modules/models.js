/* 02 - Models. Catalog facts (context, slots, capabilities, placement) next to
   how the model is actually behaving in the selected window (share, success,
   p50/p95, tokens), because an operator reads the two together. Sorting is
   client-side and says so: the catalog is the full list, never a page. */

import { ago, ctxSize, DOT, escapeHtml, ms, num, pct, text } from './format.js';
import { invalidate, setView } from './state.js';

const q = (selector) => document.querySelector(selector);

const COLUMNS = ['Host', 'Model / service', 'Health', 'Slots', 'Context', 'Capabilities', 'Weights & placement',
  'Score', 'Requests', 'Success', 'p50', 'p95', 'Tokens out', 'Last request', 'Archive'];
const RIGHT = new Set([3, 4, 7, 8, 9, 10, 11, 12, 13, 14]);

const SORTERS = {
  requests: (a, b) => (b.window?.requests || 0) - (a.window?.requests || 0),
  p95: (a, b) => (b.window?.p95Ms || 0) - (a.window?.p95Ms || 0),
  score: (a, b) => (b.capability_score ?? -1) - (a.capability_score ?? -1),
  context: (a, b) => (b.context_window || 0) - (a.context_window || 0),
  name: (a, b) => String(a.display_name_qualified || a.id).localeCompare(String(b.display_name_qualified || b.id))
};

const SORT_LABELS = {
  requests: 'requests in window',
  p95: 'latency p95',
  score: 'capability score',
  context: 'context window',
  name: 'name'
};

let sortKey = 'requests';

function capabilityChips(model) {
  const caps = (model.capabilities || []).map((capability) => {
    const useful = ['tools', 'vision', 'thinking'].includes(capability);
    return `<span class="chip ${useful ? 'on' : 'mut'}" title="declared by the published catalog">${text(capability)}</span>`;
  }).join('');
  const modalities = (model.input_modalities || []).join('+');
  return `<div class="recline">${caps}${modalities ? `<span class="chip mut">${text(modalities)}</span>` : ''}</div>`;
}

function modelRow(model, hosts) {
  const stats = model.window || {};
  const hostEntry = hosts.find((entry) => entry.id === model.host) || {};
  const slots = model.active_request_limit ?? model.slots;
  const busy = typeof hostEntry.active === 'number' && hostEntry.active > 0;
  const aliases = (model.aliases || []).filter((alias) => alias !== model.service);
  const gpus = (model.placement?.gpus || []).map((gpu) => gpu.split(' ').slice(0, 2).join(' ')).join(', ');
  const scoreNote = model.capability_score == null
    ? 'backend reports no parameters or size, so nothing is guessed'
    : 'capability score v1 from the published catalog';
  const success = stats.successRate;
  const successTone = success == null ? '' : success >= 99 ? 'good' : success >= 95 ? 'warn' : 'danger';

  return `<tr class="open" data-model="${escapeHtml(model.id)}" title="Filter this page to ${escapeHtml(model.id)}">
    <td><div class="cell-2"><span class="b">${text(model.host)}</span><span class="s">${hostEntry.default ? 'default machine' : 'declared host'}</span></div></td>
    <td><div class="cell-2">
      <span class="b">${text(model.display_name_qualified || model.display_name || model.id)}</span>
      <span class="s aliases"><b>${text(model.service)}</b> <span class="faint">${DOT} send this</span>${aliases.length ? ` ${DOT} also ${aliases.map((alias) => text(alias)).join(', ')}` : ''}</span>
    </div></td>
    <td><span class="st ${model.available ? 'c2' : 'c5'}"><i class="dot ${model.available ? 'ok' : 'bad'}"></i>${model.available ? 'healthy' : 'unavailable'}</span>
      ${model.complete === false ? `<div class="mini warn">catalog contradicted by the backend</div>` : ''}</td>
    <td class="r"><span class="slots"><i class="${busy ? 'busy' : 'free'}"></i>${slots == null ? '\u2014' : slots}</span>
      <div class="mini">${slots && model.context_window ? ctxSize(model.context_window * slots) : '\u2014'} total ctx</div></td>
    <td class="r"><div class="cell-2"><span class="b num">${ctxSize(model.context_window)}</span><span class="s faint">trained ${ctxSize(model.model_context_window)}</span></div></td>
    <td>${capabilityChips(model)}</td>
    <td><div class="cell-2">
      <span class="b">${text(model.quantization || '\u2014')}</span>
      <span class="s faint">${text(model.backend_kind || 'backend not declared')} ${DOT} ${model.placement?.gpu_count ?? '\u2014'} ${gpus ? `x ${text(gpus)}` : ''}${model.placement?.exclusive ? ` ${DOT} exclusive` : ''}</span>
    </div></td>
    <td class="r"><div class="cell-2"><span class="b num">${model.capability_score ?? '\u2014'}</span><span class="s faint" title="${escapeHtml(scoreNote)}">${model.capability_score == null ? 'backend silent' : 'v1'}</span></div></td>
    <td class="r"><b class="num">${stats.requests == null ? '\u2014' : num(stats.requests)}</b></td>
    <td class="r"><span class="num ${successTone}">${pct(success)}</span>${stats.cancelled ? `<div class="mini warn">${stats.cancelled} cancelled</div>` : ''}</td>
    <td class="r num">${ms(stats.p50Ms)}</td>
    <td class="r"><span class="num ${typeof stats.p95Ms === 'number' && stats.p95Ms > 20000 ? 'warn' : ''}">${ms(stats.p95Ms)}</span></td>
    <td class="r"><div class="cell-2"><span class="b num">${num(stats.tokensOut)}</span><span class="s faint">${num(stats.tokensIn)} in</span></div></td>
    <td class="r num">${text(ago(stats.lastTs))}</td>
    <td class="r">${stats.requests ? `<span class="chip" title="generation journals carry the prompt payload of this model's requests">journals</span>` : '<span class="chip mut">none</span>'}</td>
  </tr>`;
}

function offlineRow(service) {
  return `<tr class="mutedrow"><td>${text(service.host || '\u2014')}</td>
    <td><div class="cell-2"><span class="b">${text(service.display_name || service.model)}</span><span class="s">offline service ${DOT} ${text(service.model)}</span></div></td>
    <td><span class="chip mut">no process to ask</span></td><td class="r">\u2014</td><td class="r">\u2014</td>
    <td colspan="3" class="mini">requests answer <b>503 SERVICE_OFFLINE</b> ${DOT} ${text(service.reason || 'not running')}${service.role ? ` ${DOT} role ${text(service.role)}` : ''}. The runtime declares it; the router never invents it.</td>
    <td class="r">\u2014</td><td class="r">\u2014</td><td class="r">\u2014</td><td class="r">\u2014</td><td class="r">\u2014</td><td class="r">\u2014</td><td class="r">\u2014</td></tr>`;
}

function renderSorter(models) {
  const select = q('#model-sort');
  if (!select) return;
  if (!select.childElementCount) {
    select.innerHTML = Object.entries(SORT_LABELS).map(([key, label]) => `<option value="${key}">${label}</option>`).join('');
    select.value = sortKey;
    select.addEventListener('change', () => {
      sortKey = SORTERS[select.value] ? select.value : 'requests';
      invalidate();
    });
  }
  select.disabled = models.length < 2;
}

export function render(state) {
  const table = q('#models');
  const hint = q('#mod-hint');
  const note = q('#mod-note');
  const foot = q('#models-foot');
  if (!table) return;
  const portal = state.portal;
  if (!portal) {
    table.innerHTML = '';
    if (note) note.textContent = 'Loading the catalog.';
    return;
  }
  const models = portal.models || [];
  const hosts = portal.hosts || [];
  const offline = portal.offlineServices || [];
  const aliases = models.reduce((sum, model) => sum + (model.aliases?.length || 0), 0);

  if (hint) {
    hint.textContent = `${models.length} selectable model${models.length === 1 ? '' : 's'} across ${hosts.length} machine${hosts.length === 1 ? '' : 's'} `
      + `${DOT} ${aliases} alias${aliases === 1 ? '' : 'es'} ${DOT} ${offline.length} service${offline.length === 1 ? '' : 's'} deliberately offline`;
  }
  if (note) {
    note.innerHTML = `Sorted in the browser by ${SORT_LABELS[sortKey]} ${DOT} the catalog is complete, not a page. `
      + `Statistics are this router's own measurements for <b>${escapeHtml(state.view.window === 'all' ? 'the retained window' : `the last ${escapeHtml(state.view.window)}`)}</b>.`;
  }
  renderSorter(models);

  const sorted = [...models].sort(SORTERS[sortKey] || SORTERS.requests);
  const rows = sorted.map((model) => modelRow(model, hosts)).join('') + offline.map(offlineRow).join('');
  const signature = `${sorted.map((model) => `${model.id}:${model.available}:${model.window?.requests}:${model.window?.p95Ms}:${model.capability_score}`).join('|')}|${offline.length}|${sortKey}|${state.view.window}`;
  if (table.dataset.sig === signature) return;
  table.dataset.sig = signature;
  table.innerHTML = `<thead><tr>${COLUMNS.map((title, index) => `<th class="${RIGHT.has(index) ? 'r' : ''}">${title}</th>`).join('')}</tr></thead><tbody>${rows || `<tr><td colspan="${COLUMNS.length}">No model has published a catalog to this router yet.</td></tr>`}</tbody>`;

  if (foot) {
    foot.innerHTML = '<span>Health is probed by the router (<code class="mono">/health</code>, <code class="mono">/slots</code>, <code class="mono">/props</code>) and cross-checked against the published catalog; a contradiction shows on the row and clears <code class="mono">complete</code> instead of trusting either source.</span>'
      + '<span class="spacer"></span>'
      + '<span class="faint">a <code class="mono">null</code> capability score means the backend never reported parameters or size \u2014 never guessed</span>';
  }
}

export function wire() {
  q('#models')?.addEventListener('click', (event) => {
    const row = event.target.closest('tr[data-model]');
    if (!row || event.target.closest('a')) return;
    setView({ model: row.dataset.model, offset: 0 });
    q('#sec-requests')?.scrollIntoView({ block: 'start' });
  });
}
