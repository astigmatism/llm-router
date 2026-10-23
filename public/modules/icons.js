/* Inline SVG icon set. The deployment image has almost no font coverage, so the
   portal carries no icon font and no emoji: every glyph in the UI is either a
   letter, a digit, or one of these paths (see the glyph test). */

const PATHS = {
  search: '<circle cx="7" cy="7" r="5"/><path d="M11 11l4 4"/>',
  pause: '<path d="M5 3v12M12 3v12"/>',
  play: '<path d="M5 3l9 5-9 5z"/>',
  refresh: '<path d="M13 6a5.5 5.5 0 1 0 1.6 3.9"/><path d="M13 2.5V6H9.5"/>',
  chev: '<path d="M4 6l4 4 4-4"/>',
  caret: '<path d="M6 4l4 4-4 4"/>',
  up: '<path d="M4 10l4-4 4 4"/>',
  x: '<path d="M4 4l8 8M12 4l-8 8"/>',
  left: '<path d="M9 3L4 8l5 5"/>',
  right: '<path d="M5 3l5 5-5 5"/>',
  download: '<path d="M8 2v8M4.5 7L8 10.5 11.5 7"/><path d="M3 13h10"/>',
  link: '<path d="M7 9a3 3 0 0 0 4 0l2-2a3 3 0 0 0-4-4l-1 1"/><path d="M9 7a3 3 0 0 0-4 0L3 9a3 3 0 0 0 4 4l1-1"/>',
  warn: '<path d="M8 2l6.5 11H1.5z"/><path d="M8 6.5v3.2M8 11.4v.1"/>',
  archive: '<path d="M2 4h12v3H2z"/><path d="M3.5 7v7h9V7"/><path d="M6.5 10h3"/>',
  live: '<path d="M8 8m-2 0a2 2 0 1 0 4 0a2 2 0 1 0-4 0"/><path d="M3.4 3.4a6.5 6.5 0 0 0 0 9.2M12.6 3.4a6.5 6.5 0 0 1 0 9.2"/>',
  polling: '<circle cx="8" cy="8" r="6"/><path d="M8 4.6V8l2.4 1.6"/>',
  clock: '<circle cx="8" cy="8" r="6"/><path d="M8 4.6V8l2.4 1.6"/>',
  arrow: '<path d="M3 8h9M9 5l3 3-3 3"/>',
  bolt: '<path d="M9 1.5L4 9h3l-1 5.5L12 7H9z"/>',
  wrench: '<path d="M10.5 2.5a3.4 3.4 0 0 0 3 5.6L13.5 10H10l-1.4 3.4L3.5 8l3.4-1.4z"/>',
  model: '<path d="M8 2l5.5 3v6L8 14l-5.5-3V5z"/><path d="M8 7.4L11 5.8M8 7.4v3.4M8 7.4L5 5.8"/>',
  power: '<path d="M8 2v6"/><path d="M4.6 4.2a5 5 0 1 0 6.8 0"/>'
};

export const iconNames = Object.keys(PATHS);

export function icon(name, size = 13, extraClass = '') {
  const path = PATHS[name];
  if (!path) return '';
  return `<svg class="ico ${extraClass}" width="${size}" height="${size}" viewBox="0 0 16 16" fill="none" `
    + 'stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">'
    + `${path}</svg>`;
}
