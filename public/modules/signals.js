/* 03 - Signals. Only what /admin/api/stats (section 6) computes from the retained
   request window, so a card can never disagree with the requests table. The
   series is drawn from the router's own buckets (including the empty ones), and
   anything the router does not measure stays an em dash. When the route is
   missing this section collapses to one honest line instead of showing shapes
   it invented. */

import { clock, DOT, escapeHtml, ms, num, pct, text } from './format.js';
import { icon } from './icons.js';
import { ROUTES } from './api.js';
import { viewUrl } from './state.js';

const q = (selector) => document.querySelector(selector);

const WIDTH = 150;
const HEIGHT = 34;

function linePath(values, width, height) {
  if (values.length < 2) return '';
  const max = Math.max(...values, 1);
  const x = (index) => (index / (values.length - 1)) * (width - 2) + 1;
  const y = (value) => height - 2 - (value / max) * (height - 5);
  return values.map((value, index) => `${index ? 'L' : 'M'}${x(index).toFixed(1)} ${y(value).toFixed(1)}`).join(' ');
}

function sparkline(values, { color = 'var(--accent)' } = {}) {
  const path = linePath(values, WIDTH, HEIGHT);
  if (!path) return `<div class="mini faint">no buckets in this window</div>`;
  const last = values[values.length - 1] || 0;
  const max = Math.max(...values, 1);
  const cx = WIDTH - 1;
  const cy = (HEIGHT - 2 - (last / max) * (HEIGHT - 5)).toFixed(1);
  const area = `${path} L ${cx} ${HEIGHT} L 1 ${HEIGHT} Z`;
  return `<svg class="spark" width="${WIDTH}" height="${HEIGHT}" viewBox="0 0 ${WIDTH} ${HEIGHT}" role="img" aria-label="trend across the window">`
    + `<path d="${area}" fill="${color}" opacity=".13"/><path d="${path}" fill="none" stroke="${color}" stroke-width="1.4" stroke-linejoin="round" stroke-linecap="round"/>`
    + `<circle cx="${cx}" cy="${cy}" r="1.9" fill="${color}"/></svg>`;
}

/* Stacked outcome buckets: the shape of a window is "how much of it failed",
   which three separate sparklines cannot show. */
function stacked(series, { colorLabels = [] } = {}) {
  const length = series[0]?.values.length || 0;
  if (length < 2) return `<div class="mini faint">no buckets in this window</div>`;
  const totals = Array.from({ length }, (_, index) => series.reduce((sum, entry) => sum + (entry.values[index] || 0), 0));
  const max = Math.max(...totals, 1);
  const barWidth = (WIDTH - 2) / length;
  const accumulated = new Array(length).fill(0);
  let rects = '';
  series.forEach((entry, seriesIndex) => {
    for (let index = 0; index < length; index += 1) {
      const value = entry.values[index] || 0;
      const y0 = HEIGHT - 2 - (accumulated[index] / max) * (HEIGHT - 4);
      const y1 = HEIGHT - 2 - ((accumulated[index] + value) / max) * (HEIGHT - 4);
      accumulated[index] += value;
      if (value <= 0) continue;
      rects += `<rect x="${(1 + index * barWidth).toFixed(1)}" y="${y1.toFixed(1)}" width="${Math.max(1, barWidth - 0.9).toFixed(1)}" `
        + `height="${Math.max(0, y0 - y1).toFixed(1)}" fill="${entry.color}" opacity=".9" rx=".6" `
        + `aria-label="${escapeHtml(`${colorLabels[seriesIndex] || entry.label} ${value} at bucket ${index + 1} of ${length}`)}"/>`;
    }
  });
  const peak = Math.max(...totals);
  return `<svg class="spark" width="${WIDTH}" height="${HEIGHT}" viewBox="0 0 ${WIDTH} ${HEIGHT}" role="img" `
    + `aria-label="outcomes per bucket, peak ${peak}"><title>Peak ${peak} requests in one bucket</title>${rects}</svg>`;
}

function card({ title, value, unit, body, footLeft, footRight, titleAttr }) {
  return `<div class="card"><h4${titleAttr ? ` title="${escapeHtml(titleAttr)}"` : ''}>${title}</h4>`
    + `<div class="big"><b>${value}</b><span>${unit}</span></div>${body}`
    + `<div class="foot"><span>${footLeft}</span><span>${footRight}</span></div></div>`;
}

function listRows(entries, total, href) {
  if (!entries.length) return '<div class="mini faint">nothing in this window</div>';
  return entries.map((entry) => {
    const share = total ? (100 * entry.requests / total) : 0;
    const hrefAttr = href ? ` href="${escapeHtml(href(entry))}"` : '';
    return `<div class="li"><a${hrefAttr} class="nm mono" style="color:inherit" title="${escapeHtml(entry.key)}">${text(entry.key)}</a>`
      + `<span class="bar2" title="${share.toFixed(1)} % of the window"><i style="width:${share.toFixed(1)}%"></i></span>`
      + `<span class="ct">${num(entry.requests)} ${DOT} ${share.toFixed(1)}%</span></div>`;
  }).join('');
}

function outcomeRows(byStatus) {
  const entries = Object.entries(byStatus || {});
  const total = entries.reduce((sum, [, count]) => sum + count, 0);
  if (!entries.length) return '<div class="mini faint">no responses in this window</div>';
  return entries.sort((a, b) => b[1] - a[1]).map(([status, count]) => {
    const width = total ? (100 * count) / total : 0;
    const colour = String(status)[0] === '2' ? 'var(--good)' : String(status) === '499' ? 'var(--warn)' : 'var(--danger)';
    const tone = String(status)[0] === '2' ? 'c2' : String(status) === '499' ? 'c4' : 'c5';
    return `<div class="li" style="grid-template-columns:58px 1fr 74px 46px">`
      + `<span class="st ${tone}">${text(status)}</span>`
      + `<span class="bar2" style="width:auto"><i style="width:${width.toFixed(1)}%;background:${colour}"></i></span>`
      + `<span class="ct">${num(count)}</span><span class="mini faint">${width.toFixed(1)}%</span></div>`;
  }).join('');
}

function eventLine(event) {
  const type = String(event.type || 'event');
  const tone = /fail|reject|error/i.test(type) ? 'bad' : /drain|maintenance/i.test(type) ? 'warn' : 'mut';
  const configuration = event.configuration || {};
  const parts = [
    event.host ? `<b>${text(event.host)}</b>` : '',
    event.revision ? `catalog <span class="mono">${escapeHtml(String(event.revision).slice(0, 12))}</span>` : '',
    configuration.id ? `configuration <span class="mono">${escapeHtml(configuration.id)}</span>${configuration.runtime_revision ? ` rev ${escapeHtml(String(configuration.runtime_revision).slice(0, 8))}` : ''}` : '',
    typeof event.enabled === 'boolean' ? `drain ${event.enabled ? 'on' : 'off'}${event.reason ? ` ${DOT} ${text(event.reason)}` : ''}` : '',
    Array.isArray(event.models) && event.models.length ? event.models.map((model) => text(model)).join(', ') : '',
    event.code ? `<span class="mono">${text(event.code)}</span>` : '',
    event.message ? text(String(event.message).slice(0, 110)) : '',
    event.alias ? `alias ${text(event.alias)}` : '',
    Array.isArray(event.warnings) && event.warnings.length ? text(event.warnings.join(', ')) : ''
  ].filter(Boolean);
  return `<div class="ev"><span class="t">${text(`${clock(event.ts).slice(0, 5)}`)}</span>`
    + `<span class="chip ${tone}">${text(type.replace(/_/g, ' '))}</span>`
    + `<span class="w">${parts.join(` ${DOT} `) || '<span class="faint">no detail</span>'}</span></div>`;
}

function renderTimeline(state) {
  const events = state.events;
  const limit = 40;
  const rows = (events || []).slice(0, limit).map(eventLine).join('');
  return `<div class="card"><h4>Configuration and lifecycle timeline ${icon('clock')} ${text(`${ROUTES.events}`)}</h4>
    <div class="tl" style="margin-top:9px">${rows || '<div class="mini faint">no events recorded by this router yet</div>'}</div>
    <div class="mini faint" style="margin-top:8px">${events && events.length > limit ? `${events.length - limit} older events are not shown; ` : ''}the feed is ${ROUTES.events}; a catalog publish carries configuration.id.</div>
  </div>`;
}

export function render(state) {
  const section = q('#sec-signals');
  const content = q('#sig-content');
  const note = q('#sig-note');
  const grid = q('#signals');
  const cards2 = q('#cards2');
  const legend = q('#sig-legend');
  if (!section || !grid) return;

  if (state.stats === null && state.notes.stats) {
    content.hidden = true;
    note.hidden = false;
    note.textContent = `${state.notes.stats} This router computes no time series yet, so there is nothing to draw here; `
      + 'the requests table below still streams live.';
    return;
  }
  const stats = state.stats;
  if (!stats) {
    content.hidden = true;
    note.hidden = false;
    note.textContent = 'Loading the aggregates for this window.';
    return;
  }
  content.hidden = false;
  note.hidden = true;

  const buckets = stats.series?.buckets || [];
  const bucketSeconds = stats.series?.bucketSeconds || stats.bucket?.seconds || 60;
  const totals = stats.totals || {};
  const latency = stats.latencyMs || {};
  const tokens = stats.tokens || {};
  const rate = stats.tokensPerSecond || {};
  const queue = stats.queueWaitMs || {};
  const ttft = stats.ttftMs || {};
  const windowLabel = state.view.window === 'all' ? 'since start' : state.view.window;

  if (legend) {
    legend.innerHTML = `<span><i style="background:var(--good)"></i>2xx</span>`
      + `<span><i style="background:var(--warn)"></i>499 client closed</span>`
      + `<span><i style="background:var(--danger)"></i>5xx and rejected</span>`
      + `<span><i style="background:var(--accent)"></i>output tokens</span>`;
  }

  const okSeries = buckets.map((bucket) => bucket.ok || 0);
  const cancelledSeries = buckets.map((bucket) => bucket.cancelled || 0);
  const rejectedSeries = buckets.map((bucket) => bucket.rejected || 0);
  const errorSeries = buckets.map((bucket) => bucket.errors || 0);
  const tokenSeries = buckets.map((bucket) => bucket.outputTokens || 0);
  const p50Series = buckets.map((bucket) => bucket.p50Ms || 0);
  const p95Series = buckets.map((bucket) => bucket.p95Ms || 0);
  const queuedSeries = buckets.map((bucket) => bucket.queued || 0);
  const peak = buckets.reduce((max, bucket) => Math.max(max, (bucket.requests || 0)), 0);

  const bucketLabel = bucketSeconds >= 60 ? `${Math.round(bucketSeconds / 60)} min` : `${bucketSeconds} s`;

  grid.innerHTML = [
    card({
      title: `Requests per ${bucketSeconds >= 60 ? 'minute' : 'bucket'}`,
      value: num(totals.requests),
      unit: `handled in ${escapeHtml(windowLabel)}${typeof totals.successRate === 'number' ? ` ${DOT} ${pct(totals.successRate)} ok` : ''}`,
      body: stacked([
        { label: '2xx', values: okSeries, color: 'var(--good)' },
        { label: 'cancelled', values: cancelledSeries, color: 'var(--warn)' },
        { label: 'rejected', values: rejectedSeries, color: 'var(--danger)' },
        { label: 'errors', values: errorSeries, color: 'var(--danger)' }
      ], { colorLabels: ['2xx', 'cancelled', 'rejected', 'errors'] }),
      footLeft: `peak ${num(peak)}/${bucketSeconds >= 60 ? 'min' : 'bucket'}`,
      footRight: `buckets ${escapeHtml(bucketLabel)} ${DOT} ${stats.bucket?.kept == null ? 'n/a' : `${stats.bucket.kept} kept`}`,
      titleAttr: `${ROUTES.stats}?window=${state.view.window}&bucket=${bucketSeconds}s - stacked by outcome`
    }),
    card({
      title: 'Latency p50 / p95',
      value: ms(latency.p95),
      unit: `p95${typeof latency.p50 === 'number' ? ` ${DOT} p50 ${ms(latency.p50)}` : ''}`,
      body: (() => {
        const p95 = linePath(p95Series, WIDTH, HEIGHT);
        const p50 = linePath(p50Series, WIDTH, HEIGHT);
        if (!p95 && !p50) return '<div class="mini faint">no latency samples in this window</div>';
        return `<svg class="spark" width="${WIDTH}" height="${HEIGHT}" viewBox="0 0 ${WIDTH} ${HEIGHT}" role="img" aria-label="latency p50 and p95 across the window">`
          + `<path d="${p95}" fill="none" stroke="var(--warn)" stroke-width="1.3"/>`
          + `<path d="${p50}" fill="none" stroke="var(--good)" stroke-width="1.3"/></svg>`;
      })(),
      footLeft: `p99 ${ms(latency.p99)}`,
      footRight: latency.samples == null ? 'no samples' : `${latency.samples} samples`,
      titleAttr: `TTFB p50 ${ms(ttft.p50)} over ${ttft.samples == null ? 0 : ttft.samples} streamed responses`
    }),
    card({
      title: 'Output tokens',
      value: num(tokens.output),
      unit: `tokens${typeof tokens.input === 'number' ? ` ${DOT} ${num(tokens.input)} in` : ''}`,
      body: sparkline(tokenSeries),
      footLeft: rate.avg == null ? 'no tokens/s: backend silent' : `avg ${rate.avg.toFixed(1)} tok/s`,
      footRight: rate.samples == null ? 'backend reports no timing' : `${rate.samples} samples`,
      titleAttr: 'The router measures tokens/s itself as output tokens / (duration - first token); it is not a backend figure.'
    }),
    card({
      title: 'Queue wait',
      value: queue.max == null ? '\u2014' : ms(queue.max),
      unit: `worst in ${escapeHtml(windowLabel)}${queue.samples == null ? '' : ` ${DOT} ${queue.samples} samples`}`,
      body: sparkline(queuedSeries, { color: 'var(--info)' }),
      footLeft: queue.avg == null ? 'no wait recorded' : `avg ${ms(queue.avg)} ${DOT} p95 ${ms(queue.p95)}`,
      footRight: `in flight now ${state.portal?.state?.inFlight?.queued == null ? '\u2014' : state.portal.state.inFlight.queued} queued`,
      titleAttr: 'Admission-queue wait measured by the router (stats.queueWaitMs); 0 is only shown when it was measured.'
    })
  ].join('');

  const byClient = (stats.byClient || []).slice(0, 8);
  const clientTotal = byClient.reduce((sum, entry) => sum + entry.requests, 0);
  const byEndpoint = (stats.byEndpoint || []).slice(0, 8);
  const endpointTotal = byEndpoint.reduce((sum, entry) => sum + entry.requests, 0);
  const byError = stats.byError || [];

  cards2.innerHTML = `<div class="card"><h4>Outcomes, clients and endpoints <span class="faint" style="font-weight:400">${DOT} ${escapeHtml(ROUTES.stats)}</span></h4>
    <div class="list" style="margin-top:9px">${outcomeRows(stats.byStatus)}</div>
    ${byError.length ? `<div class="mini faint" style="margin-top:6px">error codes: ${byError.map((entry) => `<span class="mono">${text(entry.code)}</span> ${num(entry.count)}`).join(` ${DOT} `)}</div>` : ''}
    <h4 style="margin-top:16px">Top clients <span class="faint" style="font-weight:400">${DOT} client identity, click to filter</span></h4>
    <div class="list" style="margin-top:6px">${listRows(byClient, clientTotal, (entry) => viewUrl({ client: entry.key, offset: 0 }))}</div>
    <h4 style="margin-top:16px">Endpoints</h4>
    <div class="list" style="margin-top:6px">${listRows(byEndpoint, endpointTotal, null)}</div>
  </div>${renderTimeline(state)}`;

  const hint = q('#sig-hint');
  if (hint) {
    hint.textContent = `${buckets.length} buckets of ${bucketLabel} held by the router ${DOT} empty buckets included ${DOT} `
      + `window ${escapeHtml(windowLabel)}${stats.window?.from ? ` (${clock(stats.window.from).slice(0, 5)} to ${clock(stats.window.to).slice(0, 5)} UTC)` : ''}`;
  }}
