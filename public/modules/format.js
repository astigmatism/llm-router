/* Formatting is the honest layer of the portal: a value the router does not
   report must render as an em dash carrying the reason, never as a zero, and
   every number keeps its unit. Everything here is pure so it can be reused by
   the table, the modal and the live chip.
   Glyph policy: ASCII plus the small allow-list in test/portal-ui.test.js
   (en/em dash, curly quotes, ellipsis, middle dot, arrows). */

export function escapeHtml(value) {
  return String(value ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;');
}

export { escapeHtml as h };

const DASH = '\u2014';

/* An em dash with a reason. `why` is what the operator needs to know about the
   missing value ("pre-admission rejects carry no timing"), so it belongs in the
   title attribute rather than in the row. */
export function dash(why = 'not reported by the router') {
  return `<span class="faint" title="${escapeHtml(why)}">${DASH}</span>`;
}

export function orDash(value, render, why) {
  if (value === null || value === undefined || value === '') return dash(why);
  return render(value);
}

export function text(value, fallback = DASH) {
  if (value === null || value === undefined || value === '') return fallback;
  return escapeHtml(value);
}

export function numberText(value, fallback = DASH) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return String(value);
}

/* Durations: milliseconds below a second, seconds to two decimals up to a
   minute, then minutes. Units are always printed. */
export function ms(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return DASH;
  if (value < 1000) return `${Math.round(value)} ms`;
  if (value < 60000) return `${(value / 1000).toFixed(value < 10000 ? 2 : 1)} s`;
  const minutes = Math.floor(value / 60000);
  const seconds = Math.round((value % 60000) / 1000);
  return `${minutes}m ${seconds}s`;
}

export function uptime(seconds) {
  if (typeof seconds !== 'number' || !Number.isFinite(seconds)) return DASH;
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (hours >= 24) return `${Math.floor(hours / 24)}d ${hours % 24}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

/* Counts and token totals in the compact form the tables use; the exact value
   stays in the title so nothing is approximated away. */
export function num(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return DASH;
  const exact = exactNumber(value);
  const compact = Math.abs(value) >= 1e6
    ? `${(value / 1e6).toFixed(Math.abs(value) < 1e7 ? 2 : 1)}M`
    : Math.abs(value) >= 1000
      ? `${(value / 1000).toFixed(Math.abs(value) < 10000 ? 1 : 0)}k`
      : String(Math.round(value));
  return `<span class="nowrap" title="${exact} exact">${compact}</span>`;
}

export function exactNumber(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return DASH;
  return value.toLocaleString('en-US', { maximumFractionDigits: 3 });
}

export function bytes(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return DASH;
  if (value >= 1073741824) return `${(value / 1073741824).toFixed(1)} GiB`;
  if (value >= 1048576) return `${(value / 1048576).toFixed(value >= 10485760 ? 0 : 2)} MiB`;
  if (value >= 1024) return `${Math.round(value / 1024)} KiB`;
  return `${Math.round(value)} B`;
}

export function pct(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return DASH;
  return `${value.toFixed(1)} %`;
}

/* Context windows are always powers of two tokens; the rounded K is readable
   and the exact count goes in the title. */
export function ctxSize(tokens) {
  if (typeof tokens !== 'number' || !Number.isFinite(tokens) || tokens <= 0) return DASH;
  return `<span title="${exactNumber(tokens)} tokens">${Math.round(tokens / 1024)}K</span>`;
}

export function clock(value) {
  const date = toDate(value);
  return date ? `${date.toISOString().slice(11, 19)}Z` : DASH;
}

export function day(value) {
  const date = toDate(value);
  return date ? date.toISOString().slice(5, 10) : DASH;
}

export function stamp(value) {
  const date = toDate(value);
  return date ? date.toISOString().replace('.000Z', 'Z') : DASH;
}

export function toDate(value) {
  if (!value) return null;
  const date = new Date(typeof value === 'number' ? value : String(value));
  return Number.isNaN(date.getTime()) ? null : date;
}

export function ago(value) {
  const date = toDate(value);
  if (!date) return 'never';
  const minutes = Math.round((Date.now() - date.getTime()) / 60000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ${minutes % 60}m ago`;
  return `${Math.floor(hours / 24)}d ${hours % 24}h ago`;
}

/* Status colour classes follow the response class; 499 (client closed) reads as
   a warning, not as an upstream failure. */
export function statusClass(status) {
  const code = Number(status);
  if (!Number.isFinite(code) || code <= 0) return '';
  if (code === 499) return 'c4';
  if (code >= 500) return 'c5';
  if (code >= 400) return 'c4';
  if (code >= 300) return 'c3';
  return 'c2';
}

export function outcomeTone(outcome) {
  if (outcome === 'success') return 'good';
  if (outcome === 'cancelled') return 'warn';
  if (outcome === 'rejected' || outcome === 'error') return 'danger';
  return 'muted';
}

export function shortId(value, length = 12) {
  if (!value) return DASH;
  return escapeHtml(String(value).slice(0, length));
}

export function joinDots(parts) {
  return parts.filter((part) => part !== null && part !== undefined && part !== '')
    .map((part) => escapeHtml(part)).join(` ${DOT} `);
}

export const DOT = '\u00b7';

/* Query strings for the API: only keys with a value, so an unset filter is
   absent rather than empty. */
export function query(params) {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params || {})) {
    if (value === null || value === undefined || value === '') continue;
    search.set(key, String(value));
  }
  const qs = search.toString();
  return qs ? `?${qs}` : '';
}

export function plural(count, singular, pluralForm) {
  return `${exactNumber(count)} ${count === 1 ? singular : pluralForm || `${singular}s`}`;
}
