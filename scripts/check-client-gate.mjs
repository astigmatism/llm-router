#!/usr/bin/env node
// Read a router the way a client does, with the client's own code.
//
// A curl proves the router answered. This proves a client would act correctly:
// it evaluates every service through the discovery plugin's own verdicts and
// checks that the model picker would find one label per row. When a deployment
// "works" and a client still refuses it, the difference is here.
//
//   node scripts/check-client-gate.mjs --base http://192.168.1.23:11434 \
//        [--plugin /path/to/dsh-router-model-discovery.js]
//
// The plugin defaults to the DSH checkout beside this repository; point it at a
// box's deployed copy (`…/data/dsh/.dsh-plugins/…`) to read that box's view.
// Exits 1 when a resident service a client needs is blocking, or when two
// published rows would be labelled alike.

import path from 'node:path';
import { pathToFileURL } from 'node:url';

const argv = process.argv.slice(2);
const arg = (name, fallback) => {
  const index = argv.indexOf(`--${name}`);
  return index === -1 ? fallback : argv[index + 1];
};
const base = arg('base', 'http://192.168.1.23:11434');
const plugin = arg('plugin', new URL(
  '../../dsh-container/deployments/deepseek-harness/data/dsh/.dsh-plugins/dsh-router-model-discovery.js',
  import.meta.url
).pathname);

const { fetchCapabilities, residentStatus, isBlockingStatus, residentCapabilities, RESIDENT_SERVICES }
  = await import(pathToFileURL(path.resolve(plugin)).href);

const { document } = await fetchCapabilities(base);
console.log(base);
console.log(`  document complete=${document.complete} warnings=${JSON.stringify(document.warnings ?? [])}`
  + ` hosts=${(document.hosts ?? []).map((host) => host.id).join(',') || '(single)'}`);

let failed = false;
for (const service of [...new Set(Object.values(RESIDENT_SERVICES))]) {
  const status = residentStatus(document, service);
  const blocking = isBlockingStatus(status.status);
  // Note: isBlockingStatus takes the status STRING. Passing the record returns
  // false and reports a blocking verdict as fine.
  let label = '';
  if (status.status === 'available') {
    const limits = residentCapabilities({ model: status.model, metadata: status.metadata });
    // Label by the SERVICE being asked about. A model answering two service names
    // has one `model.service`, so reading it from the row gives the wrong name for
    // the second service.
    const perName = status.metadata.alias_display_names?.[service];
    label = `  "${limits.displayName}" ctx=${limits.contextWindow} slots=${limits.maxConcurrency}`
      + (perName ? ` label-for-service="${perName}"` : ' (no per-name title: two services on one model label alike)');
  }
  if (blocking && !isOptIn(document, service)) failed = true;
  console.log(`  ${service.padEnd(10)} ${status.status.padEnd(11)} ${blocking ? 'BLOCKING' : 'ok      '} ${status.reason ?? ''}${label}`);
}

const rows = (await (await fetch(`${base}/v1/models`)).json()).data;
const titles = rows.map((row) => row.x_ollama_router?.display_name ?? row.id);
const duplicates = titles.filter((title, index) => titles.indexOf(title) !== index);
console.log(`  listing: ${rows.map((row, index) => `${row.id}="${titles[index]}"`).join('   ')}`);
console.log(`  duplicate labels a picker would collide on: ${duplicates.length ? duplicates.join(', ') : 'none'}`);
if (duplicates.length) failed = true;
process.exit(failed ? 1 : 0);

// `trial` is opt-in: its absence is a correct answer, not a deployment failure.
function isOptIn(capabilitiesDocument, service) {
  return service === 'trial' && !(capabilitiesDocument.models ?? [])
    .some((model) => model.service === service || model.aliases?.includes(service));
}
