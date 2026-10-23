// Syntax check for every JavaScript file this project ships.
//
// The npm script used to list each file by name, which quietly went stale the
// moment a module was added - and a portal module that never parses is a blank
// dashboard, not a failing test. So: walk the trees, check everything, and fail
// with the path and the parser's own message. `node --check` is the parser the
// runtime will actually use, and it honours this package's `"type": "module"`.

import { readdir } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TREES = ['src', 'public', 'scripts', 'test', 'docs/clients'];

async function* walk(directory) {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error.code === 'ENOENT') return;
    throw error;
  }
  for (const entry of entries) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) yield* walk(full);
    else if (entry.isFile() && /\.(js|mjs|cjs)$/.test(entry.name)) yield full;
  }
}

function check(file) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['--check', file], { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('close', (code) => resolve(code === 0 ? null : (stderr.split('\n').find((line) => line.includes('Error')) || stderr).trim()));
  });
}

const files = [];
for (const tree of TREES) {
  for await (const file of walk(path.join(root, tree))) files.push(file);
}
files.sort();

const results = await Promise.all(files.map(async (file) => ({ file, error: await check(file) })));
const failures = results.filter((entry) => entry.error);
if (failures.length) {
  console.error(`${failures.length} of ${files.length} files failed to parse:`);
  for (const failure of failures) console.error(`  ${path.relative(root, failure.file)}: ${failure.error}`);
  process.exit(1);
}
console.log(`syntax ok: ${files.length} files`);
