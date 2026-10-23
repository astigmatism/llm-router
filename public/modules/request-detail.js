/* The request modal. One request in full: the routing decision, the stage
   timings the router measured, the control negotiation, the outcome, the prompt
   as it arrived, and the backend journal it was written to - each tab naming
   the endpoint its data came from. The open request is a URL (?request=<id>),
   so Back closes it and Copy link shares exactly this view. */

import { ago, bytes, dash, DOT, escapeHtml, exactNumber, ms, num, stamp, statusClass, text } from './format.js';
import { icon } from './icons.js';
import { absoluteUrl, load, ROUTES } from './api.js';
import { recordIds, requestUrl, setView } from './state.js';

const q = (selector) => document.querySelector(selector);

const TABS = [
  ['overview', 'Overview', null],
  ['prompt', 'Prompt & payload', 'items'],
  ['journal', 'Backend journal', 'lines'],
  ['raw', 'Raw', null]
];

let current = null;   // { id, tab, record, events, journal, loading, error }
let trapRestore = null;

/* Focus goes back where it came from. A live page may have scrolled that row
   out of the table, so the fallback is the newest row rather than the body. */
function returnFocus(id) {
  const exact = q(`#requests tr[data-id="${CSS.escape(id)}"]`);
  // A live page may have already scrolled that row off the table, and the
  // element that launched the modal can be a bare <body>; neither is a place to
  // put the keyboard back, so the newest row is the fallback.
  const candidate = exact
    || (trapRestore?.isConnected && trapRestore !== document.body && trapRestore.tagName !== 'HTML' ? trapRestore : null)
    || q('#requests tbody tr[data-id]');
  candidate?.focus?.();
}

function announce(message) {
  const region = q('#live-status');
  if (region) region.textContent = message;
}

/* ---- data --------------------------------------------------------------- */

async function loadRequest(id) {
  current = { id, tab: current?.id === id ? current.tab : 'overview', record: null, events: [], journal: null, loading: true, error: null };
  renderModal();
  const recordResult = await load(`${ROUTES.request(id)}`);
  if (!current || current.id !== id) return;
  if (!recordResult.ok) {
    current.loading = false;
    current.error = recordResult.status === 404
      ? { code: 'REQUEST_NOT_FOUND', message: 'This id is not in the retained request window of this router, so there is nothing to show.' }
      : { code: recordResult.code || 'ADMIN_ROUTE_ERROR', message: recordResult.message || 'the router did not answer' };
    renderModal();
    return;
  }
  current.record = recordResult.data.record || null;
  current.events = Array.isArray(recordResult.data.events) ? recordResult.data.events : [];
  const journalState = current.record?.journal || {};
  if (journalState.available || journalState.state === 'archived') {
    const journalResult = await load(`${ROUTES.journal(id)}?events=40&promptBytes=24576`);
    if (current.id === id && journalResult.ok) current.journal = journalResult.data;
  }
  current.loading = false;
  renderModal();
}

/* ---- pieces ------------------------------------------------------------- */

function krow(label, value) {
  return `<div class="krow"><span class="k">${label}</span><span class="v">${value}</span></div>`;
}

function step(index, name, title, detail, tone = '') {
  return `<div class="step ${tone}"><div class="n">${escapeHtml(index)} ${DOT} ${escapeHtml(name)}</div><div class="t">${title}</div><div class="d">${detail}</div></div>`;
}

function journalChip(record) {
  const journal = record?.journal || {};
  if (journal.state === 'archived' && journal.available !== false) {
    const retentionDays = record?.journal?.retentionDays;
    return `<span class="chip on">${icon('archive')} payload archived${retentionDays ? ` ${DOT} ${retentionDays}d left` : ''}</span>`;
  }
  if (journal.state === 'pre_admission') {
    return '<span class="chip mut">no archive ' + DOT + ' refused before admission</span>';
  }
  if (journal.state === 'not_archived') {
    return `<span class="chip warn">no archive ${DOT} ${text(journal.note || 'accepted, and this backend writes no generation archive')}</span>`;
  }
  return '<span class="chip mut">journal state not reported</span>';
}

function overviewTab(record, journal) {
  const client = record.client || {};
  const tokens = record.tokens || {};
  const sampling = record.sampling || {};
  const tools = record.tools || {};
  const phases = journal?.phases || [];
  const admitted = record.outcome !== 'rejected';
  const terminal = journal?.terminal || {};
  const finish = terminal.finishReason ?? record.finishReason;

  const admissionDetail = record.admissionWaitMs == null && record.queueWaitMs == null
    ? dash('this record carries no admission timing (pre-admission reject or an older build)')
    : `+${ms(record.admissionWaitMs ?? 0)} ${DOT} queue ${ms(record.queueWaitMs)}`;
  const upstreamDetail = record.ttftMs == null
    ? dash(record.streaming === false ? 'not a stream, so no first delta exists' : 'no first token measured for this record')
    : `+${ms(record.ttftMs)}${tokens.input == null ? '' : ` ${DOT} ${exactNumber(tokens.input)} tok`}`;
  const streamDetail = record.durationMs == null
    ? dash('no total timing recorded')
    : `+${ms(record.durationMs)}${record.tokensPerSecond == null ? '' : ` ${DOT} ${record.tokensPerSecond.toFixed(1)} tok/s`}`;

  return `<div>
    <div class="blk"><h5>Routing decision</h5>
      ${krow('Requested', `<span class="mono">${text(record.requestedModel || 'omitted')}</span>${record.alias ? ` <span class="faint">${DOT} alias ${escapeHtml(record.alias)} resolved</span>` : ''}`)}
      ${krow('Served', `<span class="mono">${text(record.servedModel || record.activeModel || '\u2014')}</span>`)}
      ${krow('Machine', `${text(record.host || '\u2014')}${record.hostDefault ? ' <span class="faint">default machine</span>' : ''}`)}
      ${krow('Backend', `<span class="mono">${text(record.backendKind || 'not declared')}</span>${record.upstreamUrl ? ` @ <span class="mono">${text(record.upstreamUrl)}</span>` : ''}`)}
      ${krow('Attempts', record.attempts == null ? dash('the router did not count attempts for this record') : exactNumber(record.attempts))}
      ${krow('Rewrite', record.modelRewritten
        ? `<span class="mono">${text(record.requestedModel)} \u2192 ${text(record.servedModel)}</span>`
        : '<span class="faint">off ' + DOT + ' the requested model was forwarded exactly</span>')}
      ${krow('Protocol', `${text(record.protocolLabel || record.protocol || 'other')} ${DOT} <span class="mono">${text(`${record.method || 'GET'} ${record.endpoint || ''}${record.query || ''}`)}</span>`)}
    </div>
    <div class="blk"><h5>Timings</h5>
      <div class="flow">
        ${step('01', 'admission', admitted ? 'Admitted' : 'Refused', admissionDetail, admitted ? 'ok' : 'warn')}
        ${step('02', 'upstream', 'Connect + first delta', upstreamDetail, record.ttftMs == null ? 'warn' : 'ok')}
        ${step('03', 'stream', tokens.output ? `${exactNumber(tokens.output)} tokens streamed` : 'No content', streamDetail, record.outcome === 'success' ? 'ok' : 'warn')}
        ${step('04', 'delivery', record.outcome === 'success' ? 'Complete' : text(record.outcome || 'Unknown'), record.errorCode ? `<span class="mono">${text(record.errorCode)}</span>` : `finish ${text(finish || 'not reported')}`)}
      </div>
      ${phases.length ? `<div class="mini faint" style="margin-top:8px">${phases.length} journal phases ${DOT} see the Backend journal tab for the exact stamps.</div>`
        : `<div class="mini faint" style="margin-top:8px">TTFB, queue wait and admission wait are measured by the router; a dash means this record has no such measurement, never zero.</div>`}
    </div>
    <div class="blk"><h5>Control negotiation</h5>
      ${krow('Thinking', sampling.thinking == null ? '<span class="faint">not sent</span>' : `<span class="mono">${text(sampling.thinking)}</span>`)}
      ${krow('Reasoning effort', sampling.reasoningEffort == null ? '<span class="faint">not sent</span>' : `<span class="mono">${text(sampling.reasoningEffort)}</span>`)}
      ${krow('Output limit', sampling.outputLimitPolicy == null ? dash('no output-limit policy recorded') : `<span class="mono">policy ${text(sampling.outputLimitPolicy)}</span>`)}
      ${krow('Temperature', sampling.temperatureForwarded ? 'forwarded' : '<span class="faint">not forwarded ' + DOT + ' backend default</span>')}
      ${krow('Seed', sampling.seedForwarded ? 'forwarded' : '<span class="faint">not forwarded</span>')}
      ${krow('keep_alive', `in <span class="mono">${text(sampling.keepAlive?.incoming ?? '\u2014')}</span> \u2192 out <span class="mono">${text(sampling.keepAlive?.forwarded ?? '\u2014')}</span>`)}
      ${krow('Tools', `${tools.count == null ? dash('tool count not recorded') : `${exactNumber(tools.count)} declared`}${tools.forwarded != null ? ` ${DOT} ${exactNumber(tools.forwarded)} forwarded` : ''}${tools.dropped ? ` ${DOT} <span class="warn">${exactNumber(tools.dropped)} dropped</span>` : ''}${tools.unsupportedPolicy ? ` <span class="faint">unsupported policy: ${text(tools.unsupportedPolicy)}</span>` : ''}`)}
      ${krow('prompt_cache_key', record.promptCacheKey?.present ? `<span class="mono">${text(record.promptCacheKey.disposition || 'present')}</span>` : 'absent')}
    </div>
  </div>
  <div>
    <div class="blk"><h5>Outcome</h5>
      ${krow('Status', `<span class="st ${statusClass(record.responseStatus ?? record.status)}">${text(record.responseStatus ?? record.status ?? '\u2014')}</span>`)}
      ${krow('Outcome', `<span class="${record.outcome === 'success' ? 'good' : record.outcome === 'pending' ? 'muted' : 'warn'}">${text(record.outcome || 'unknown')}</span>`)}
      ${krow('Finish reason', finish == null ? dash('no finish reason: nothing was generated, or an older build wrote this record') : text(finish))}
      ${krow('Completion state', text(record.completionState || 'not reported'))}
      ${krow('Usage', tokens.total == null ? dash('the backend reported no usage for this request') : (() => {
        // The two figures beside each other are not always addends of the third:
        // a stream's output count is the router's own estimate while the total is
        // what the backend claimed when it finished. Labelling that beats a line
        // that reads like an arithmetic mistake.
        const parts = [tokens.input, tokens.output];
        const sums = typeof tokens.input === 'number' && typeof tokens.output === 'number' && tokens.total === tokens.input + tokens.output;
        return `<span class="mono">${exactNumber(tokens.input)}</span> in ${DOT} <span class="mono">${exactNumber(tokens.output)}</span> out ${DOT} `
          + `<span class="mono">${exactNumber(tokens.total)}</span> total`
          + (sums ? '' : ` <span class="faint" title="This total is the figure that was reported or estimated for the request as a whole, not the sum of the two counts beside it.">${DOT} as reported</span>`);
      })())}
      ${krow('Context transitions', record.contextTransitions == null ? dash('not recorded') : `${exactNumber(record.contextTransitions)}`)}
      ${krow('Stream parse errors', record.streamParseErrors == null ? dash('not recorded') : exactNumber(record.streamParseErrors))}
      ${krow('Client', `<span class="mono">${text(client.identity || client.name || 'unknown')}</span>${client.ip ? ` @ <span class="mono">${text(client.ip)}</span>` : ''}`)}
      ${krow('Payload', `${bytes(record.requestBytes)} in \u2192 ${bytes(record.responseBytes)} out`)}
      ${krow('Error body', record.errorBodyExcerpt
        ? `<span class="mono">${text(record.errorBodyExcerpt)}</span> <span class="faint">${DOT} bounded to 4 KiB</span>`
        : record.errorMessage ? text(record.errorMessage) : dash('no error body: the request succeeded'))}
      ${krow('Record', `<span class="mono">schema ${text(record.schema ?? '?')}</span> ${DOT} written ${escapeHtml(stamp(record.ts))} ${DOT} ${escapeHtml(ago(record.ts))}`)}
    </div>
    <div class="blk"><h5>Payload archive</h5>
      ${journal
        ? krow('Journal', `<span class="mono">${text(journal.journalId || '\u2014')}</span> ${DOT} ${bytes(journal.bytes)} ${DOT} ${exactNumber(journal.lines)} lines`)
          + krow('File', `<span class="mono">${text(journal.file || '\u2014')}</span>`)
          + krow('View limit', journal.truncated
            ? '<span class="warn">truncated</span> ' + DOT + ' the detail view reads a bounded window of the file; Download payload streams the rest'
            : 'read in full')
          + krow('First / last byte', `${ms(journal.events?.firstByteMs)} \u2192 ${ms(journal.events?.lastByteMs)}`)
        : krow('Journal', journalChip(record))}
    </div>
  </div>`;
}

function messageItem(item) {
  const kind = String(item.kind || item.role || 'item');
  const roleClass = ['developer', 'system'].includes(item.role) ? 'dev' : item.role === 'tool' ? 'tool' : item.role || '';
  if (item.kind === 'more_items') {
    return `<details class="msg"><summary><span class="caret closed">${icon('caret')}</span><span class="role">${escapeHtml('input')}</span>`
      + `<span class="prev">${exactNumber(item.count)} more items in the request, not projected into this view (see Raw, or Download payload)</span>`
      + `<span class="len">\u2026</span></summary><div class="body">The detail endpoint returns a bounded projection: a byte-capped window of the body, with images replaced by an elision marker. The untouched line is one link away in the header.</div></details>`;
  }
  if (item.elided || kind === 'input_image') {
    return `<div class="msg image" style="padding:8px 11px;font-size:12px"><span class="mono">${escapeHtml('input_image')}</span> `
      + `<span class="chip mut">${escapeHtml('elided')}</span> <span class="mono faint">${bytes(item.bytes)}</span>`
      + `<span class="faint"> ${DOT} image bytes are never inlined into the detail view</span></div>`;
  }
  const body = String(item.text ?? '');
  const preview = body.split('\n')[0].slice(0, 108) || '(empty)';
  return `<details class="msg ${roleClass}"><summary><span class="caret closed">${icon('caret')}</span>`
    + `<span class="role ${roleClass}">${text(item.role || kind)}</span>`
    + `<span class="prev">${text(preview)}${body.length > preview.length ? '\u2026' : ''}</span>`
    + `<span class="len">${num(body.length)} ch${item.truncated ? ` ${DOT} truncated` : ''}</span></summary>`
    + `<div class="body">${text(body)}${item.truncated ? '\n\n[truncated by the detail view]' : ''}</div></details>`;
}

function promptTab(record, journal) {
  if (!journal) return noJournal(record);
  const prompt = journal.prompt || {};
  const items = (prompt.items || []).map(messageItem).join('');
  const tools = prompt.tools || [];
  const backend = journal.backendRequest;
  const toolsBody = tools.length
    ? `<ul>${tools.map((tool) => `<li><b class="mono">${text(tool.name)}</b> ${DOT} ${text(tool.description || 'no description')}</li>`).join('')}</ul>`
    : '<div class="faint">the router recorded no tool schemas for this request</div>';
  return `<div style="display:flex;gap:8px;align-items:center;margin-bottom:9px;flex-wrap:wrap">
      <span class="chip role">rendered</span>
      <span class="faint" style="font-size:11px">${exactNumber(prompt.itemCount ?? record.bodySummary?.inputCount ?? 0)} input items ${DOT} ${exactNumber(prompt.toolsCount ?? 0)} tools ${DOT} ${exactNumber(prompt.imagesElided ?? 0)} images elided ${DOT} ${bytes(prompt.bytes)}</span>
      <span class="spacer" style="flex:1"></span>
      <span class="faint" style="font-size:11px">${bytes(prompt.bytesShown)} shown of ${bytes(prompt.bytes)} ${DOT} bounded by GENERATION_JOURNAL_VIEW_BYTES</span>
    </div>
    ${items || '<div class="mini faint">this router recorded no prompt items for this request (PROMPT_LOGGING=metadata keeps roles and counts only)</div>'}
    <details class="msg"><summary><span class="caret closed">${icon('caret')}</span><span class="role dev">tools</span>
      <span class="prev">${exactNumber(prompt.toolsCount ?? tools.length)} schemas ${DOT} ${tools.slice(0, 8).map((tool) => text(tool.name)).join(', ') || 'none recorded'}${tools.length > 8 ? ', \u2026' : ''}</span>
      <span class="len">${bytes(prompt.toolsBytes)}</span></summary>
      <div class="body">${toolsBody}</div></details>
    ${backend ? `<details class="msg"><summary><span class="caret closed">${icon('caret')}</span><span class="role">\u2192 backend</span>
      <span class="prev">the translation this router sent to <span class="mono">${text(backend.model || 'the backend')}</span></span></summary>
      <div class="body"><pre class="code">${escapeHtml(JSON.stringify(backend.body ?? backend, null, 1).slice(0, 6000))}</pre></div></details>` : ''}
    <p class="mini faint" style="margin-top:8px">Every item above comes from ${escapeHtml(ROUTES.journal(record.id))}. Prompt text is untrusted input and is escaped before it reaches the DOM.</p>`;
}

function noJournal(record) {
  const state = record?.journal?.state;
  const why = state === 'pre_admission'
    ? 'This router refused the request before admission, so no generation journal was ever opened. The policy decision and the bounded error body are everything that was retained.'
    : state === 'not_archived'
      ? 'The request was accepted but no generation journal survived it: prompt logging may be off, the archive may have been pruned, or an older build wrote the record.'
      : 'This router reported no journal for this request, so there is nothing to render here.';
  return `<div class="notice warn">${icon('warn')}<span><b>No payload archive for this request.</b> ${escapeHtml(why)}</span></div>`;
}

function journalTab(record, journal) {
  if (!journal) return noJournal(record);
  const phases = (journal.phases || []).map((phase) => `<li><span class="off">+${ms(phase.offsetMs)}</span><span class="pip"></span>`
    + `<span><span class="who">${text(phase.label || phase.name)}</span> <span class="faint">${escapeHtml(stamp(phase.at))}</span><br><span class="det">${text(phase.detail || '')}</span></span></li>`).join('');
  const events = journal.events || {};
  const samples = (events.samples || []).map((sample) => `${escapeHtml(String(sample.at || '').slice(11, 23))}  ${escapeHtml(String(sample.type || '').padEnd(15))}${escapeHtml(sample.summary || '')}`).join('\n');
  const byType = Object.entries(events.byType || {}).map(([type, count]) => `${type}: ${exactNumber(count)}`).join('  ');
  return `<div class="blk"><h5>Phases ${DOT} from the journal file</h5>
      ${phases ? `<ul class="phases">${phases}</ul>` : '<div class="mini faint">this journal carries no phase records</div>'}
    </div>
    <div class="blk"><h5>Events ${DOT} aggregated</h5>
      <p class="section-note" style="margin:0 0 8px">${exactNumber(events.total)} journal lines after the request line; this view shows ${exactNumber((events.samples || []).length)} representative samples and aggregates <b>${exactNumber(events.omitted)}</b> further events${byType ? ` ${DOT} ${escapeHtml(byType)}` : ''}.</p>
      <pre class="code">${samples || 'no samples returned'}</pre>
    </div>
    <div class="blk"><h5>Terminal record</h5>
      <pre class="code wrap">${escapeHtml(JSON.stringify(journal.terminal || {}, null, 1))}</pre>
    </div>`;
}

function rawTab(record) {
  return `<p class="section-note" style="margin:0 0 10px">The normalized record exactly as ${escapeHtml(ROUTES.request(record.id))} answered it. The prompt payload itself lives in the journal, not here.</p>
    <pre class="code wrap">${escapeHtml(JSON.stringify(record, null, 2))}</pre>`;
}

function noticeMarkup(journal) {
  if (journal) {
    return `<div class="notice">${icon('archive')}<span><b>Complete payload retained.</b> This request's journal `
      + `(<span class="mono">${escapeHtml(String(journal.journalId || '').slice(0, 12))}\u2026jsonl</span>, `
      + `${bytes(journal.bytes)}, ${exactNumber(journal.lines)} lines) is the source of every tab below.</span></div>`;
  }
  return '<div class="notice">' + icon('warn') + '<span><b>No payload archive.</b> Everything below is the '
    + 'normalized request record; the prompt and journal tabs stay empty because no journal exists for '
    + 'this request.</span></div>';
}


/* ---- shell -------------------------------------------------------------- */

function modalMarkup(record, journal, tab) {
  const ids = recordIds();
  const index = ids.indexOf(current.id);
  const status = record?.responseStatus ?? record?.status;
  const promptCount = journal?.prompt?.itemCount;
  const journalLines = journal?.lines;
  const labels = {
    overview: 'Overview',
    prompt: `Prompt & payload${promptCount ? ` <span class="faint">(${exactNumber(promptCount)} items)</span>` : ''}`,
    journal: `Backend journal${journalLines != null ? ` <span class="faint">(${exactNumber(journalLines)} lines)</span>` : ''}`,
    raw: 'Raw'
  };
  const body = !record ? '' : tab === 'prompt' ? promptTab(record, journal) : tab === 'journal' ? journalTab(record, journal) : tab === 'raw' ? rawTab(record) : overviewTab(record, journal);
  return `<div class="scrim" data-scrim>
    <div class="modal" role="dialog" aria-modal="true" aria-labelledby="modal-title">
      <div class="m-head">
        <div class="m-title">
          <span class="st ${statusClass(status)}"><i class="dot ${record?.outcome === 'success' ? 'ok' : record?.outcome === 'pending' ? '' : 'bad'}"></i>${text(status ?? '\u2014')}</span>
          <h3 id="modal-title">${escapeHtml(current.id)}</h3>
          ${record ? `<span class="chip ${record.outcome === 'success' ? 'on' : record.outcome === 'pending' ? 'mut' : 'warn'}">${text(record.outcome || 'unknown')}</span>` : ''}
          ${record ? journalChip(record) : ''}
          <span class="grow"></span>
          <button class="btn sm ghost" type="button" data-step="-1" ${index <= 0 ? 'disabled' : ''} title="Previous request in this filtered list (Left arrow)">${icon('left')} prev</button>
          <button class="btn sm ghost" type="button" data-step="1" ${index === -1 || index >= ids.length - 1 ? 'disabled' : ''} title="Next request in this filtered list (Right arrow)">next ${icon('right')}</button>
          <button class="btn sm ghost" type="button" data-copy title="Copy this URL; opening it shows exactly this request">${icon('link')} Copy link</button>
          <a class="btn sm ghost" href="${escapeHtml(`${ROUTES.generationRecord}?id=${encodeURIComponent(current.id)}`)}" title="The untouched NDJSON archive line, not the bounded view">${icon('download')} Download journal</a>
          <button class="btn sm ghost" type="button" data-close aria-label="Close this request">Esc ${icon('x')}</button>
        </div>
        <div class="m-sub">
          ${record ? `<span class="mono">${text(`${record.method || 'GET'} ${record.endpoint || ''}`)}</span><span>${text(record.protocolLabel || '')}</span><span>${escapeHtml(stamp(record.ts))}</span>`
    : `<span>${escapeHtml(stamp(new Date().toISOString()))}</span>`}
          ${record ? `<span>${text((record.client || {}).identity || 'unknown client')} <span class="faint">${text((record.client || {}).ip || '')}</span></span>` : ''}
          ${record ? `<span>${ms(record.durationMs)} total${record.ttftMs == null ? '' : ` ${DOT} first token ${ms(record.ttftMs)}`}</span>` : ''}
        </div>
      </div>
      <div class="m-tabs" role="tablist" aria-label="Request detail">
        ${TABS.map(([key, label]) => `<button type="button" role="tab" id="tab-${key}" aria-controls="panel" aria-selected="${tab === key}" tabindex="${tab === key ? '0' : '-1'}" data-tab="${key}">${labels[key]}</button>`).join('')}
      </div>
      <div class="m-body" id="panel" role="tabpanel" aria-labelledby="tab-${tab}" tabindex="0">
        ${current.error ? `<div class="notice warn">${icon('warn')}<span><b>${escapeHtml(current.error.code)}</b> ${escapeHtml(current.error.message)}</span></div>` : ''}
        ${current.loading ? '<p class="section-note">Loading this request from the router.</p>' : ''}
        ${record && !current.loading ? noticeMarkup(journal) : ''}
        <div class="m-grid">${body}</div>
      </div>
      <div class="m-foot">
        <span class="mono faint">${escapeHtml(`${ROUTES.request(current.id)}`)}</span>
        <span class="spacer" style="flex:1"></span>
        <span>${index >= 0 && ids.length ? `request ${index + 1} of ${ids.length} in this list ${DOT} ` : ''}Left and Right walk the filtered list ${DOT} Esc closes</span>
      </div>
    </div>
  </div>`;
}

function renderModal() {
  const root = q('#modal-root');
  if (!root) return;
  if (!current) {
    if (root.childElementCount) {
      root.innerHTML = '';
      q('#main')?.removeAttribute('aria-hidden');
    }
    return;
  }
  // A repaint throws away whatever was focused inside the modal: a record
  // landing, a tab change, anything. Remember it by its data attribute and put
  // it back, or the keyboard loses its place in the middle of a click.
  const held = focusKey(root);
  root.innerHTML = modalMarkup(current.record, current.journal, current.tab);
  q('#main')?.setAttribute('aria-hidden', 'true');
  const target = held ? root.querySelector(held) : null;
  if (target) {
    target.focus();
  } else if (!renderModal.focusPlaced) {
    (root.querySelector('[data-close]') || root.querySelector('.modal'))?.focus?.();
    renderModal.focusPlaced = true;
  }
}

/* Where the keyboard is inside the modal, as a selector that survives a
   repaint. */
function focusKey(root) {
  const active = document.activeElement;
  if (!active || !root.contains(active)) return null;
  for (const attribute of ['data-tab', 'data-step', 'data-close', 'data-copy']) {
    if (!active.hasAttribute?.(attribute)) continue;
    const value = active.getAttribute(attribute);
    return value === '' || value === null ? `[${attribute}]` : `[${attribute}="${CSS.escape(value)}"]`;
  }
  return null;
}

function setTab(tab) {
  if (!current) return;
  current = { ...current, tab };
  renderModal();
  q(`#tab-${tab}`)?.focus();
}

/* Walking the list pushes one history entry per request, so Back retraces the
   requests actually visited rather than dumping the operator out of the modal. */
function walk(delta) {
  const ids = recordIds();
  const index = ids.indexOf(current?.id);
  if (index === -1 || !ids[index + delta]) return false;
  const next = ids[index + delta];
  // Walking the list replaces the entry: opening a request is one history step,
  // leafing through twenty of them must not trap Back behind twenty presses.
  window.history.replaceState({ request: next }, '', requestUrl(next));
  setView({ request: next });
  loadRequest(next);
  return true;
}

export function close() {
  if (!current) return;
  const id = current.id;
  current = null;
  renderModal.focusPlaced = false;
  renderModal();
  // Back already closed it in the common path; only strip the parameter when
  // the modal was opened programmatically without a history entry.
  if (window.history.state?.request) window.history.back();
  else setView({ request: '' });
  returnFocus(id);
  trapRestore = null;
  announce('Request detail closed.');
}

export function open(id) {
  window.history.pushState({ request: id }, '', requestUrl(id));
  setView({ request: id });
  loadRequest(id);
  trapRestore = document.activeElement;
  announce('Request detail opened.');
}

export function sync(state) {
  const wanted = state.view.request;
  if (!wanted) {
    if (current) {
      const id = current.id;
      current = null;
      renderModal.focusPlaced = false;
      renderModal();
      returnFocus(id);
      trapRestore = null;
    }
    return;
  }
  if (current?.id === wanted) {
    // The record may have been updated by the stream while it is open.
    renderModal();
    return;
  }
  loadRequest(wanted);
  renderModal();
}

export function wire() {
  const root = q('#modal-root');
  if (!root) return;

  root.addEventListener('click', (event) => {
    if (event.target.closest('[data-close]')) {
      close();
      return;
    }
    if (event.target.closest('[data-scrim]') && !event.target.closest('.modal')) {
      close();
      return;
    }
    if (event.target.closest('[data-copy]')) {
      const url = absoluteUrl(requestUrl(current?.id || ''));
      navigator.clipboard?.writeText(url)
        .then(() => announce('Link copied to the clipboard.'))
        .catch(() => announce(`Clipboard refused; the link is ${url}`));
      return;
    }
    const tab = event.target.closest('[data-tab]');
    if (tab) {
      setTab(tab.dataset.tab);
      return;
    }
    const step = event.target.closest('[data-step]');
    if (step) walk(Number(step.dataset.step));
  });

  root.addEventListener('keydown', (event) => {
    if (!current) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      close();
      return;
    }
    if (event.key === 'ArrowLeft' && !event.target.closest('textarea, input')) {
      if (walk(-1)) event.preventDefault();
      return;
    }
    if (event.key === 'ArrowRight' && !event.target.closest('textarea, input')) {
      if (walk(1)) event.preventDefault();
      return;
    }
    if (event.key === 'Tab') {
      trap(event);
      return;
    }
    if (event.key.startsWith('Arrow') && event.target.closest('[role="tablist"]')) {
      const tabs = [...event.target.closest('[role="tablist"]').querySelectorAll('[role="tab"]')];
      const index = tabs.indexOf(event.target);
      if (index === -1) return;
      event.preventDefault();
      const offset = event.key === 'ArrowRight' ? 1 : -1;
      tabs[(index + offset + tabs.length) % tabs.length].focus();
      setTab(tabs[(index + offset + tabs.length) % tabs.length].dataset.tab);
    }
  });
}

/* Focus stays inside the dialog while it is open, and returns to the row it was
   opened from when it closes. */
function trap(event) {
  const modal = q('#modal-root .modal');
  if (!modal) return;
  const focusables = modal.querySelectorAll('a[href], button:not([disabled]), details, summary, [tabindex]:not([tabindex="-1"])');
  if (!focusables.length) return;
  const first = focusables[0];
  const last = focusables[focusables.length - 1];
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
}

