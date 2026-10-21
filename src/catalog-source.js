import fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { readActiveModel } from './active-model.js';
import { LOCAL_HOST_ID } from './config.js';

// One catalog source is one machine's published view of what it runs. The
// deployment this router serves is the merge of every declared host's source,
// so a host is read, reported and repaired on its own: a machine that is
// offline, mid-maintenance or publishing something it should not must never
// take the other machines' models down with it.
//
// `local` is the machine this router runs on and keeps the historical handoff:
// the runtime writes ACTIVE_MODEL_FILE, then calls reload-config. Every other
// host is remote and its catalog arrives over the admin API, stored under
// CATALOG_STORE_DIR. `local` is deliberately not pushable: two writers for one
// file is exactly the ambiguity this split is meant to remove.

export { LOCAL_HOST_ID };

export class CatalogSourceError extends Error {
  constructor(statusCode, code, message, host = null) {
    super(message);
    this.name = 'CatalogSourceError';
    this.statusCode = statusCode;
    this.code = code;
    this.host = host;
  }
}

export const digestText = (value) => createHash('sha256').update(value).digest('hex');

export function hostCatalogFile(config, host) {
  return path.join(config.catalogStoreDir, `${host}.json`);
}

const missingSource = (host, file, reason) => ({
  host,
  file,
  present: false,
  loadedFrom: 'missing',
  raw: null,
  revision: null,
  acceptedAt: null,
  acceptedAtMs: null,
  readError: reason
});

async function readPushedSource(config, host) {
  const file = hostCatalogFile(config, host);
  let text;
  let stat;
  try {
    [text, stat] = await Promise.all([fs.readFile(file, 'utf8'), fs.stat(file)]);
  } catch (error) {
    if (error.code === 'ENOENT') return missingSource(host, file, 'not_published');
    return { ...missingSource(host, file, error.message), loadedFrom: 'error' };
  }
  try {
    return {
      host,
      file,
      present: true,
      loadedFrom: 'pushed',
      raw: JSON.parse(text),
      revision: digestText(text),
      acceptedAt: new Date(stat.mtimeMs).toISOString(),
      acceptedAtMs: stat.mtimeMs,
      readError: null
    };
  } catch (error) {
    return {
      ...missingSource(host, file, `Invalid JSON in the published catalog: ${error.message}`),
      loadedFrom: 'invalid'
    };
  }
}

// `local` keeps the marker contract exactly as every previous release defined
// it — file, then the ACTIVE_MODEL environment fallback, then missing — so a
// single-host deployment reads byte-for-byte what it always read.
async function readLocalSource(config) {
  const active = await readActiveModel(config);
  const raw = active.raw === undefined ? null : active.raw;
  return {
    host: LOCAL_HOST_ID,
    file: active.file || hostCatalogFile(config, LOCAL_HOST_ID),
    present: active.loadedFrom === 'file' || active.loadedFrom === 'env-fallback',
    loadedFrom: active.loadedFrom,
    raw,
    revision: raw === null ? null : digestText(typeof raw === 'string' ? raw : JSON.stringify(raw)),
    acceptedAt: active.file_mtime ?? null,
    acceptedAtMs: Number.isFinite(active.file_mtime_ms) ? active.file_mtime_ms : null,
    readError: active.error ?? null,
    marker: active
  };
}

export async function readHostSource(config, host) {
  return host === LOCAL_HOST_ID ? readLocalSource(config) : readPushedSource(config, host);
}

export async function readHostSources(config) {
  return await Promise.all(config.routerHosts.map((host) => readHostSource(config, host)));
}

// The store is created lazily so a router that has never been pushed to — every
// single-host deployment — needs no directory and no permissions it did not
// need before.
export async function writeHostCatalog(config, host, text) {
  const file = hostCatalogFile(config, host);
  const storedText = text.endsWith('\n') ? text : `${text}\n`;
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o750 });
  const temporary = `${file}.tmp-${process.pid}-${digestText(`${host}${Date.now()}${Math.random()}`).slice(0, 8)}`;
  await fs.writeFile(temporary, storedText, { encoding: 'utf8', mode: 0o640 });
  await fs.rename(temporary, file);
  const stat = await fs.stat(file);
  return { file, revision: digestText(storedText), acceptedAt: new Date(stat.mtimeMs).toISOString(), acceptedAtMs: stat.mtimeMs };
}

export async function removeHostCatalog(config, host) {
  const file = hostCatalogFile(config, host);
  try {
    await fs.unlink(file);
    return { removed: true, file };
  } catch (error) {
    if (error.code === 'ENOENT') return { removed: false, file, reason: 'not_published' };
    throw error;
  }
}
