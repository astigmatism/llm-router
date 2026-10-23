/* 04 - Requests. Every handled request of the retained window, one server page
   at a time: filters become query parameters (deep-linkable and shareable),
   sorting is asked of the server and only falls back to the current page when
   this router build ignores the parameter - which the header then says out
   loud. Streamed records are prepended in place when the active filters and the
   window position allow it, so a live page never jumps. */

import { bytes, clock, dash, DOT, escapeHtml, exactNumber, ms, num, outcomeTone, statusClass, text } from './format.js';
import { icon } from './icons.js';
import { ROUTES } from './api.js';
import {
  activeFilters,
  clearFilter,
  OUTCOMES,
  PROTOCOLS,
  setView,
  viewUrl,
  WINDOW_LABELS,
  WINDOWS
} from './state.js';

const q = (selector) => document.querySelector(selector);

const COLUMNS = [
  ['Time', 'ts'], ['Client', ''], ['Protocol / endpoint', ''], ['Model served', ''], ['Machine', ''],
  ['Outcome', 'outcome'], ['Duration', 'duration'], ['TTFB', 'ttft'], ['Queue', ''],
  ['Tokens in \u2192 out', 'tokens'], ['Tokens/s', ''], ['Payload', '']
];
const RIGHT = new Set([6, 7, 8, 9, 10, 11]);
const SORT_TITLES = {
  ts: 'newest first; the server sorts this',
  duration: 'total time the router spent, from admission to the last byte',
  ttft: 'first content delta on the response stream',
  tokens: 'output tokens of the request',
  outcome: 'success, cancelled, rejected, error or pending'
};

const KIND_TITLES = {
  all: 'every logged request',
  prompt: 'generation routes only',
  errors: 'cancelled, rejected and failed requests only',
  status: 'discovery calls (models, tags, version) only'
};

function selectOptions(select, entries, current, allLabel) {
  if (!select) return;
  const signature = `${allLabel}|${entries.map(([value]) => value).join('|')}|${current}`;
  if (select.dataset.sig === signature) return;
  select.dataset.sig = signature;
  select.innerHTML = `<option value="">${allLabel}</option>`
    + entries.map(([value, label]) => `<option value="${escapeHtml(value)}"${value === current ? ' selected' : ''}>${text(label)}</option>`).join('');
  if (select.value !== (current || '')) select.value = current || '';
}

function renderFilters(state) {
  const portal = state.portal || {};
  const view = state.view;
  const models = (portal.models || []).map((model) => [model.id, `${model.service || model.id} ${DOT} ${model.id}`]);
  const hosts = (portal.hosts || []).map((entry) => [entry.id, entry.display_name || entry.id]);
  const clients = (state.stats?.byClient || []).map((entry) => [entry.key, `${entry.key} (${entry.requests})`]);
  const statuses = [['2xx', '2xx successful'], ['4xx', '4xx client or cancelled'], ['5xx', '5xx upstream or refused'],
    ['200', '200 only'], ['499', '499 client closed'], ['503', '503 refused']];

  selectOptions(q('#filter-model'), models, view.model, 'All models');
  selectOptions(q('#filter-host'), hosts, view.host, 'All machines');
  selectOptions(q('#filter-client'), clients, view.client, 'All clients');
  selectOptions(q('#filter-outcome'), OUTCOMES.map((value) => [value, value]), view.outcome, 'Any outcome');
  selectOptions(q('#filter-status'), statuses, view.status, 'Any status');
  selectOptions(q('#filter-protocol'), PROTOCOLS.map((value) => [value, value]), view.protocol, 'Any protocol');
  selectOptions(q('#filter-window'), WINDOWS.map((value) => [value, WINDOW_LABELS[value]]), view.window, 'Last hour');
  selectOptions(q('#filter-journal'), [['true', 'payload archived'], ['false', 'no payload archive']], view.journal, 'Any payload state');

  const chips = activeFilters(view);
  const chipHost = q('#filter-chips');
  if (chipHost) {
    const signature = chips.map((chip) => `${chip.key}=${chip.value}`).join('|');
    if (chipHost.dataset.sig !== signature) {
      chipHost.dataset.sig = signature;
      chipHost.innerHTML = chips.map((chip) => `<span class="fchip">${escapeHtml(chip.label)}: <b>${text(chip.value)}</b>`
        + `<button type="button" data-clear="${escapeHtml(chip.key)}" aria-label="Clear ${escapeHtml(chip.label)} filter">${icon('x')}</button></span>`).join('')
        + (chips.length > 1 ? '<span class="fchip"><button type="button" data-clear="all">clear all</button></span>' : '');
    }
  }
  const kindSeg = q('#kind-seg');
  if (kindSeg) {
    if (!kindSeg.childElementCount) {
      kindSeg.innerHTML = [['all', 'All'], ['prompt', 'Prompt calls'], ['errors', 'Errors only'], ['status', 'Status pings']]
        .map(([value, label]) => `<button type="button" data-kind="${value}" title="${KIND_TITLES[value]}${DOT} applied to this page${value === 'all' ? '' : ' and sent to the router as an unknown parameter'}">${label}</button>`).join('');
    }
    for (const button of kindSeg.querySelectorAll('[data-kind]')) {
      button.setAttribute('aria-pressed', button.dataset.kind === view.kind ? 'true' : 'false');
    }
  }
  const densitySeg = q('#density-seg');
  if (densitySeg) {
    for (const button of densitySeg.querySelectorAll('[data-density]')) {
      button.setAttribute('aria-pressed', button.dataset.density === view.density ? 'true' : 'false');
    }
  }
}

function journalCell(record) {
  const journal = record.journal || {};
  if (journal.state === 'archived' && journal.available !== false) {
    return `<span class="chip on" title="generation journal retained (${ROUTES.generationRecord})">payload archived</span>`;
  }
  if (journal.state === 'pre_admission') {
    return '<span class="chip mut" title="refused before admission, so no journal was ever opened and none can exist">no journal ' + DOT + ' refused before admission</span>';
  }
  if (journal.state === 'not_archived') {
    // The server knows which kind of "no archive" this is; say that rather than
    // listing possibilities a reader has to triage themselves.
    const why = journal.note || 'accepted, but this backend writes no generation archive';
    return `<span class="chip warn" title="${escapeHtml(why)}">no archive</span>`;
  }
  return '<span class="chip mut" title="this router does not report a journal state for the record">payload state unknown</span>';
}

function rowMarkup(record) {
  const status = record.responseStatus ?? record.status;
  const cls = statusClass(status);
  const tone = outcomeTone(record.outcome);
  const client = record.client || {};
  const tokens = record.tokens || {};
  const rewritten = record.modelRewritten && record.requestedModel && record.servedModel
    && record.requestedModel !== record.servedModel;
  const durationUnknown = 'no timing: this record predates the timing fields, or the request never reached a backend';
  const ttftUnknown = record.streaming === false
    ? 'not a stream, so there is no first delta'
    : 'no first token: the request never streamed content, or an older build wrote this record';
  const queueUnknown = record.outcome === 'rejected'
    ? 'refused before admission, so it never queued'
    : 'queue wait not measured for this record';
  const id = String(record.id || '');
  const url = viewUrl({ request: id });
  return `<tr class="open" data-id="${escapeHtml(id)}" data-href="${escapeHtml(url)}" tabindex="0"
      aria-label="Request ${escapeHtml(id)}" title="Open this request; Ctrl or Command click opens it in a new tab">
    <td class="num nowrap">${escapeHtml(clock(record.ts))}<div class="mini">${escapeHtml(record.ts ? String(record.ts).slice(5, 10) : '')}</div></td>
    <td><div class="cell-2"><span class="b">${text(client.name || client.identity || 'unknown')}</span>
      <span class="s mono faint" title="${escapeHtml(client.userAgent || 'no user agent recorded')}">${text(client.identity || 'no identity')} ${DOT} ${text(client.ip || 'no source address')}</span></div></td>
    <td><div class="cell-2"><span class="b">${text(record.protocolLabel || record.protocol || 'other')}</span>
      <span class="s mono faint">${text(`${record.method || 'GET'} ${record.endpoint || ''}${record.streaming ? ' ' + DOT + ' stream' : ''}`)}</span></div></td>
    <td><div class="cell-2"><span class="b">${text(record.servedModel || record.activeModel || '\u2014')}</span>
      <span class="s">${rewritten
        ? `<span class="mono">${text(record.requestedModel)}</span><span class="arrow">\u2192</span>rewritten`
        : `<span class="mono">${text(record.requestedModel || 'omitted')}</span> as sent`}</span></div></td>
    <td>${text(record.host || '\u2014')}${record.hostDefault ? '<div class="mini faint">default</div>' : ''}</td>
    <td><span class="st ${cls}"><i class="dot ${record.outcome === 'success' ? 'ok' : record.outcome === 'cancelled' ? 'warn' : record.outcome === 'pending' ? '' : 'bad'}"></i>${status == null ? '\u2014' : status}</span>
      <div class="mini ${tone}">${text(record.outcome || 'unknown')}</div>
      ${record.errorCode ? `<div class="mini ${record.outcome === 'cancelled' ? 'warn' : 'danger'}" title="errorCode">${text(record.errorCode)}</div>` : ''}</td>
    <td class="r num">${record.durationMs == null ? dash(durationUnknown) : ms(record.durationMs)}</td>
    <td class="r num faint">${record.ttftMs == null ? dash(ttftUnknown) : ms(record.ttftMs)}</td>
    <td class="r num faint">${record.queueWaitMs == null ? dash(queueUnknown) : ms(record.queueWaitMs)}</td>
    <td class="r"><div class="cell-2"><span class="b num">${num(tokens.input)} \u2192 ${num(tokens.output)}</span>
      <span class="s faint">${bytes(record.responseBytes)} out</span></div></td>
    <td class="r num faint">${record.tokensPerSecond == null ? '\u2014' : record.tokensPerSecond.toFixed(1)}</td>
    <td class="r">${journalCell(record)}</td>
  </tr>`;
}

/* The sort key of a record, or null when this router never measured it. */
function sortValue(record, key) {
  if (key === 'duration') return record.durationMs ?? null;
  if (key === 'ttft') return record.ttftMs ?? null;
  if (key === 'tokens') return record.tokens?.output ?? null;
  if (key === 'outcome') return String(record.outcome || '');
  return record.tsEpochMs ?? (record.ts ? new Date(record.ts).getTime() : null);
}

/* Whether the rows arrived in the order we asked for. A hole in the column
   settles it: an order that cannot be checked has not been checked, so the page
   sorts what it can see instead of wearing a sort indicator the data does not
   support. Unknown values sort last either way, never as a zero. */
function orderedServerSide(records, key, dir) {
  if (records.length < 2) return true;
  const values = records.map((record) => sortValue(record, key));
  const known = values.filter((value) => value !== null && value !== undefined);
  if (known.length < 2) return true;
  if (known.length !== values.length) return false;
  const factor = dir === 'asc' ? 1 : -1;
  for (let index = 1; index < known.length; index += 1) {
    const step = key === 'outcome'
      ? String(known[index]).localeCompare(String(known[index - 1]))
      : known[index] - known[index - 1];
    if (step * factor < 0) return false;
  }
  return true;
}

function sortLocally(records, key, dir) {
  const factor = dir === 'asc' ? 1 : -1;
  const known = [];
  const unknown = [];
  for (const record of records) {
    const value = sortValue(record, key);
    (value === null || value === undefined ? unknown : known).push({ record, value });
  }
  known.sort((left, right) => {
    const step = typeof left.value === 'string'
      ? left.value.localeCompare(right.value)
      : left.value - right.value;
    return step === 0 ? 0 : step * factor;
  });
  return [...known.map((entry) => entry.record), ...unknown.map((entry) => entry.record)];
}

function pager(currentOffset, limit, total, hasMore) {
  const pages = Math.max(1, Math.ceil(total / limit));
  const current = Math.floor(currentOffset / limit) + 1;
  const numbers = [];
  const push = (page) => numbers.push(page);
  if (pages <= 7) {
    for (let page = 1; page <= pages; page += 1) push(page);
  } else {
    push(1);
    if (current > 3) push('gap');
    for (let page = Math.max(2, current - 1); page <= Math.min(pages - 1, current + 1); page += 1) push(page);
    if (current < pages - 2) push('gap');
    push(pages);
  }
  const buttons = numbers.map((entry) => {
    if (entry === 'gap') return '<button type="button" disabled aria-hidden="true">\u2026</button>';
    const offset = (entry - 1) * limit;
    return `<button type="button" data-page="${entry}"${entry === current ? ' aria-current="page"' : ''}>${entry}</button>`;
  }).join('');
  return `<span class="pg" role="group" aria-label="Pagination">`
    + `<button type="button" data-page="${Math.max(0, current - 2)}" ${current === 1 ? 'disabled' : ''} aria-label="Previous page">${icon('left')}</button>`
    + buttons
    + `<button type="button" data-page="${Math.min(pages, current + 1)}" ${!hasMore && current >= pages ? 'disabled' : ''} aria-label="Next page">${icon('right')}</button></span>`
    + `<span class="mono">${exactNumber(total)} matching requests ${DOT} page ${current} of ${pages} ${DOT} ${limit} rows per page</span>`
    + `<select id="page-size" aria-label="Rows per page">${[16, 25, 50, 100].map((size) => `<option value="${size}"${size === limit ? ' selected' : ''}>${size}</option>`).join('')}</select>`;
}

export function render(state) {
  document.body.classList.toggle('dense', state.view.density === 'dense');
  renderFilters(state);

  const table = q('#requests');
  const foot = q('#requests-foot');
  const hint = q('#req-hint');
  const match = q('#match-info');
  if (!table) return;
  const view = state.view;
  const bucket = state.requests;
  const shown = bucket?.shown || [];
  const page = bucket?.page || null;

  const sortable = (label, key) => {
    if (!key) return `<th>${label}</th>`;
    const active = view.sort === key;
    const arrow = active ? icon(view.dir === 'desc' ? 'chev' : 'up', 11) : '';
    return `<th class="sortable${RIGHT.has(COLUMNS.findIndex((entry) => entry[0] === label)) ? ' r' : ''}" data-sort="${key}">`
      + `<button type="button" data-sort="${key}" title="${escapeHtml(`${SORT_TITLES[key]}; ${active ? `currently ${view.dir === 'desc' ? 'newest or largest first' : 'smallest first'}` : 'click to sort'}`)}">${label}`
      + `<span class="ar">${arrow}</span></button></th>`;
  };

  const header = `<thead><tr>${COLUMNS.map(([label, key]) => sortable(label, key)).join('')}</tr></thead>`;
  const body = shown.length
    ? shown.map((record) => rowMarkup(record)).join('')
    : `<tr><td colspan="${COLUMNS.length}">${state.loading.requests ? 'Loading this page from the router.' : 'No request matches these filters. Widen the window or clear a filter.'}</td></tr>`;
  const signature = `${shown.map((record) => record.id).join(',')}|${view.sort}|${view.dir}|${view.density}|${state.loading.requests}|${bucket?.serverSorted}`;
  if (table.dataset.sig !== signature) {
    table.dataset.sig = signature;
    table.innerHTML = `${header}<tbody>${body}</tbody>`;
  }

  if (hint) {
    const retained = state.portal?.state?.retention;
    hint.textContent = page
      ? `${exactNumber(page.total)} matching in the retained window ${DOT} server pages of ${page.limit} ${DOT} `
        + `${retained?.requestHistoryLimit ? `${exactNumber(retained.requestHistoryLimit)} records retained` : 'retention not reported'}`
      : 'loading the retained request window';
  }
  if (match) {
    const overlay = view.kind !== 'all';
    match.innerHTML = bucket
      ? `showing <b class="mono">${exactNumber(shown.length)}</b> of <b class="mono">${exactNumber(page?.total ?? shown.length)}</b> matched by the router`
        + (overlay ? ` ${DOT} kind overlay applied to this page` : '')
      : 'waiting for the first page';
  }
  if (foot && page) {
    const signatureFoot = `${page.total}|${page.offset}|${page.limit}|${page.hasMore}|${bucket?.serverSorted}`;
    if (foot.dataset.sig !== signatureFoot) {
      foot.dataset.sig = signatureFoot;
      foot.innerHTML = pager(page.offset || 0, page.limit || view.limit, page.total || 0, page.hasMore)
        + '<span class="spacer"></span>'
        + `<span class="faint">${bucket?.serverSorted === false ? 'sorted in the browser ' + DOT + ' this router ignored the sort parameter; ' : ''}`
        + `rows come from ${escapeHtml(ROUTES.requests)}; Ctrl or Command click opens a request in its own tab.</span>`;
    }
  } else if (foot && !bucket) {
    foot.innerHTML = '<span class="faint">loading.</span>';
  }
}

/* A fetched page becomes the table's bucket: server order is kept when the
   router honoured `sort`, otherwise the page is sorted here and the footer says
   so instead of pretending the server did it. */
export function ingest(payload, state) {
  const records = Array.isArray(payload?.requests) ? payload.requests : [];
  const page = payload?.page || {
    limit: state.view.limit,
    offset: state.view.offset,
    returned: records.length,
    total: records.length,
    hasMore: false
  };
  const bucket = {
    records,
    page,
    filters: payload?.filters || null,
    generatedAt: payload?.generatedAt || null,
    serverSorted: orderedServerSide(records, state.view.sort, state.view.dir),
    staleCount: 0,
    shown: []
  };
  state.requests = bucket;
  return materialize(bucket, state);
}

/* A streamed record belongs on this page only if the router would have returned
   it for this query: the page was fetched with filters, and prepending a row
   the user cannot reproduce by reloading would make the table lie. The
   predicates mirror the query parameters we send. */
function statusMatches(record, want) {
  const status = Number(record.responseStatus ?? record.status ?? 0);
  if (!status) return false;
  const text = String(want);
  if (/^\dxx$/i.test(text)) return Math.floor(status / 100) === Number(text[0]);
  return String(status) === text;
}

function matchesPageFilters(record, view) {
  const client = record.client || {};
  if (view.model && ![record.servedModel, record.requestedModel, record.alias].includes(view.model)) return false;
  if (view.host && record.host !== view.host) return false;
  if (view.client && ![client.name, client.identity, client.ip].some((value) => value && String(value).startsWith(view.client))) return false;
  if (view.outcome && record.outcome !== view.outcome) return false;
  if (view.status && !statusMatches(record, view.status)) return false;
  if (view.protocol && record.protocol !== view.protocol) return false;
  if (view.journal && record.journal?.state !== view.journal) return false;
  if (view.q) {
    const haystack = [record.id, record.endpoint, record.requestedModel, record.servedModel, record.alias,
      record.errorCode, record.errorMessage, client.identity, client.name, client.ip].join(' ').toLowerCase();
    if (!haystack.includes(String(view.q).toLowerCase())) return false;
  }
  return true;
}

function filterKind(records, kind) {
  if (kind === 'all') return records;
  return records.filter((record) => {
    if (kind === 'prompt') return record.kind === 'prompt';
    if (kind === 'status') return record.kind === 'discovery';
    if (kind === 'errors') return ['error', 'rejected', 'cancelled'].includes(record.outcome);
    return true;
  });
}

export function materialize(bucket, state) {
  if (!bucket) return null;
  const ordered = bucket.serverSorted === false
    ? sortLocally(bucket.records, state.view.sort, state.view.dir)
    : bucket.records;
  bucket.shown = filterKind(ordered, state.view.kind);
  return bucket;
}

export const sortCurrentPage = materialize;

/* Streamed records land in place. The page only accepts a row while it is
   actually viewing the newest end of the filtered list; otherwise it counts
   what arrived and says so, because silently rewriting a page deeper in the
   history is worse than a stale one. */
export function applyStreamedRecord(record, state) {
  const bucket = state.requests;
  if (!bucket || state.paused || !record?.id) return 'ignored';
  const view = state.view;
  if (!matchesPageFilters(record, view)) return 'ignored';
  if (bucket.records.some((entry) => entry.id === record.id)) {
    bucket.records = bucket.records.map((entry) => (entry.id === record.id ? record : entry));
    materialize(bucket, state);
    return 'updated';
  }
  if (view.offset !== 0 || view.sort !== 'ts' || view.dir !== 'desc') {
    bucket.staleCount = (bucket.staleCount || 0) + 1;
    return 'queued';
  }
  if (bucket.page?.total != null) bucket.page = { ...bucket.page, total: bucket.page.total + 1 };
  bucket.records = [record, ...bucket.records].slice(0, Math.max(bucket.page?.limit || view.limit, 1));
  materialize(bucket, state);
  return 'prepended';
}

export function announce(message) {
  const region = q('#requests-live');
  if (!region || region.textContent === message) return;
  region.textContent = message;
}

export function wire(actions) {
  const table = q('#requests');
  table?.addEventListener('click', (event) => {
    const sortButton = event.target.closest('[data-sort]');
    if (sortButton) {
      const key = sortButton.dataset.sort;
      const view = actions.state().view;
      setView({ sort: key, dir: view.sort === key && view.dir === 'desc' ? 'asc' : 'desc', offset: 0 });
      actions.loadRequests();
      return;
    }
    const row = event.target.closest('tr[data-id]');
    if (!row) return;
    const href = row.dataset.href;
    if (event.metaKey || event.ctrlKey) {
      window.open(href, '_blank', 'noopener');
      return;
    }
    actions.openRequest(row.dataset.id);
  });
  table?.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    const row = event.target.closest('tr[data-id]');
    if (!row) return;
    event.preventDefault();
    actions.openRequest(row.dataset.id);
  });

  const binds = [
    ['#filter-model', 'model'], ['#filter-host', 'host'], ['#filter-client', 'client'],
    ['#filter-outcome', 'outcome'], ['#filter-status', 'status'], ['#filter-protocol', 'protocol'],
    ['#filter-journal', 'journal'], ['#filter-window', 'window']
  ];
  for (const [selector, key] of binds) {
    q(selector)?.addEventListener('change', (event) => {
      setView({ [key]: event.target.value, offset: 0 });
      actions.loadRequests();
    });
  }

  q('#filter-chips')?.addEventListener('click', (event) => {
    const button = event.target.closest('[data-clear]');
    if (!button) return;
    clearFilter(button.dataset.clear);
    actions.loadRequests();
  });

  q('#kind-seg')?.addEventListener('click', (event) => {
    const button = event.target.closest('[data-kind]');
    if (!button) return;
    setView({ kind: button.dataset.kind, offset: 0 });
    sortCurrentPage(actions.state());
    actions.invalidate();
  });

  q('#density-seg')?.addEventListener('click', (event) => {
    const button = event.target.closest('[data-density]');
    if (!button) return;
    setView({ density: button.dataset.density });
  });

  q('#requests-foot')?.addEventListener('click', (event) => {
    const button = event.target.closest('[data-page]');
    if (!button) return;
    const page = Number(button.dataset.page);
    if (!Number.isFinite(page)) return;
    setView({ offset: Math.max(0, (page - 1) * actions.state().view.limit), scroll: true });
    actions.loadRequests();
  });
  q('#requests-foot')?.addEventListener('change', (event) => {
    if (event.target.id !== 'page-size') return;
    setView({ limit: Number(event.target.value), offset: 0 });
    actions.loadRequests();
  });
}
