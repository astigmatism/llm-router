/* Static checks on the portal bundle. The portal has no build step, so these
   assertions are the build: every asset the shell references exists, every
   import resolves, the stylesheet carries the design tokens and the phone
   breakpoint, the app only speaks routes docs/PORTAL_API.md documents, and no
   file leans on a glyph the deployment image cannot render (its font coverage
   is almost empty, so icons are inline SVG and text is ASCII plus a handful of
   dashes, quotes, the middle dot, the ellipsis and the two arrows). */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC = path.join(ROOT, 'public');
const CONTRACT = path.join(ROOT, 'docs', 'PORTAL_API.md');

function read(file) {
  return fs.readFileSync(file, 'utf8');
}

function walk(dir, filter = () => true) {
  const found = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) found.push(...walk(full, filter));
    else if (filter(full)) found.push(full);
  }
  return found;
}

const sourceFiles = walk(PUBLIC, (file) => /\.(js|css|html)$/.test(file));
const moduleFiles = sourceFiles.filter((file) => file.endsWith('.js'));
const indexHtml = read(path.join(PUBLIC, 'index.html'));

test('the shell references only files that exist under public/', () => {
  const references = [...indexHtml.matchAll(/(?:href|src)\s*=\s*"([^"]+)"/g)].map((match) => match[1]);
  assert.ok(references.length > 0, 'expected the shell to reference its stylesheet and entry module');
  for (const reference of references) {
    if (/^(https?:)?\/\//.test(reference) || reference.startsWith('#') || reference.startsWith('mailto:')) continue;
    const clean = reference.split(/[?#]/)[0];
    if (!clean) continue;
    const target = path.resolve(PUBLIC, clean);
    assert.ok(target.startsWith(PUBLIC + path.sep), `${reference} escapes public/`);
    assert.ok(fs.existsSync(target), `${reference} is referenced by index.html but does not exist at ${target}`);
  }
});

test('the shell has no inline handlers and only module scripts', () => {
  const offenders = [...indexHtml.matchAll(/<[^>]+>/g)]
    .map((match) => match[0])
    .filter((tag) => /\son[a-z-]+\s*=\s*["']/i.test(tag));
  assert.deepEqual(offenders, [], 'index.html must bind behaviour from modules, not inline on* attributes');

  const scripts = [...indexHtml.matchAll(/<script\b[^>]*>/gi)].map((match) => match[0]);
  assert.ok(scripts.length > 0, 'expected the shell to load an entry module');
  for (const script of scripts) {
    assert.match(script, /type\s*=\s*["']module["']/, `script tag is not a module: ${script}`);
  }
});

test('every module imported under public/ resolves', () => {
  const specifiers = [];
  for (const file of moduleFiles) {
    const source = read(file);
    for (const match of source.matchAll(/(?:^|[\s;}])import\s[^;]*?from\s*['"]([^'"]+)['"]/g)) {
      specifiers.push([file, match[1]]);
    }
    for (const match of source.matchAll(/import\s*\(\s*['"]([^'"]+)['"]\s*\)/g)) {
      specifiers.push([file, match[1]]);
    }
  }
  assert.ok(specifiers.length > 0, 'expected the portal to be modular');
  for (const [file, specifier] of specifiers) {
    if (!specifier.startsWith('.')) {
      assert.fail(`${path.relative(ROOT, file)} imports "${specifier}": the portal has no dependencies and no import map`);
    }
    const target = path.resolve(path.dirname(file), specifier);
    assert.ok(fs.existsSync(target), `${path.relative(ROOT, file)} imports ${specifier}, which does not exist`);
  }
});

test('the stylesheet carries the design tokens and the phone breakpoint', () => {
  const css = read(path.join(PUBLIC, 'style.css'));
  const tokens = ['--bg', '--panel', '--panel-2', '--text', '--muted', '--faint', '--border', '--accent',
    '--good', '--warn', '--danger', '--mono', '--row', '--pad'];
  for (const token of tokens) {
    assert.match(css, new RegExp(`${token}\\s*:`), `style.css lost the ${token} token`);
  }
  assert.match(css, /@media[^{]*max-width:\s*860px/, 'style.css must keep the 860px card-per-row layout');
  assert.match(css, /prefers-reduced-motion/, 'the pulse has to stop for users who asked for no motion');
  assert.match(css, /:focus-visible/, 'keyboard focus must stay visible');
});

test('the app only calls routes documented in docs/PORTAL_API.md', () => {
  const contract = read(CONTRACT);
  const documented = new Set(contract.match(/\/admin\/api\/(?:[a-z0-9_-]+|:id)(?:\/(?:[a-z0-9_-]+|:id))*/g) || []);
  assert.ok(documented.has('/admin/api/portal/state'), 'the contract should document the portal state route');

  const used = new Set();
  for (const file of sourceFiles) {
    for (const match of read(file).matchAll(/\/admin\/api\/(?:[a-z0-9_-]+|:id)(?:\/(?:[a-z0-9_-]+|:id))*/g)) {
      used.add(match[0]);
    }
  }
  for (const route of used) {
    const known = [...documented].some((entry) => entry === route
      || entry.startsWith(`${route}/`)
      || route.startsWith(`${entry}/`)
      || route === entry.replace(/\/:id$/, ''));
    assert.ok(known, `${route} is called by the portal but is not in docs/PORTAL_API.md`);
  }
  assert.ok(used.has('/admin/api/portal/state'), 'the portal should read the aggregated state route');
  assert.ok(used.has('/admin/api/stream'), 'the portal should subscribe to the stream route');
});

test('nothing depends on a glyph the deployment image cannot render', () => {
  const allowed = new Set([0x2013, 0x2014, 0x2018, 0x2019, 0x201c, 0x201d, 0x2026, 0x00b7, 0x2192, 0x2190]);
  const offenders = [];
  for (const file of sourceFiles) {
    const lines = read(file).split('\n');
    lines.forEach((line, index) => {
      for (const character of line) {
        const code = character.codePointAt(0);
        if (code <= 0x7f || allowed.has(code)) continue;
        offenders.push(`${path.relative(ROOT, file)}:${index + 1} U+${code.toString(16).toUpperCase().padStart(4, '0')} (${character})`);
      }
    });
  }
  assert.deepEqual(offenders, [], 'non-ASCII glyphs outside the allow-list will render as boxes on the router host');
});
