// Tests for scripts/update-and-restart.sh, the Service Portal "Update and
// restart" entry point. The script is driven as a child process against a real
// temporary git repository (a local-path origin, so `git fetch` needs no
// network) with `docker`, `wget` and `bash` replaced by PATH shims. Nothing
// here needs a Docker daemon, a network, or the router host: the shims record
// what was asked for and answer from files this test writes.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const scriptPath = path.join(repoDir, 'scripts', 'update-and-restart.sh');
const gitBin = process.env.PATH.split(path.delimiter)
  .map((dir) => path.join(dir, process.platform === 'win32' ? 'git.exe' : 'git'))
  .find((candidate) => fs.existsSync(candidate)) || 'git';

const GIT_IDENTITY = {
  GIT_AUTHOR_NAME: 'Update Test',
  GIT_AUTHOR_EMAIL: 'update@example.com',
  GIT_COMMITTER_NAME: 'Update Test',
  GIT_COMMITTER_EMAIL: 'update@example.com'
};

function git(args, cwd) {
  const result = spawnSync(gitBin, args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, ...GIT_IDENTITY, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' }
  });
  assert.equal(result.status, 0, `git ${args.join(' ')} failed: ${result.stderr}`);
  return result.stdout.trim();
}

// A path as a literal inside a regular expression.
const re = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const DOCKER_STUB = (stub) => `#!/bin/sh
# Records what update-and-restart.sh asked of Docker and answers from ${stub}.
cmd=''
[ "$#" -gt 0 ] && { cmd=$1; shift; }
case "$cmd" in
  inspect)
    kind=''
    for arg in "$@"; do
      case "$arg" in
        *Config.Labels*) kind=label; break ;;
        *.Config.Env*) kind=env; break ;;
        *11434/tcp*) kind=api; break ;;
        *11435/tcp*) kind=admin; break ;;
      esac
    done
    case "$kind" in
      label) [ -f '${stub}/label.txt' ] && cat '${stub}/label.txt' ;;
      env) [ -f '${stub}/env.txt' ] && cat '${stub}/env.txt' ;;
      api) [ -f '${stub}/api.txt' ] && cat '${stub}/api.txt' ;;
      admin) [ -f '${stub}/admin.txt' ] && cat '${stub}/admin.txt' ;;
    esac
    exit 0
    ;;
  compose)
    printf 'compose %s\\n' "$*" >> '${stub}/calls/docker.log'
    exit 0
    ;;
  run)
    printf 'run %s\\n' "$*" >> '${stub}/calls/docker.log'
    printf '%s\\n' "$@" >> '${stub}/calls/docker-run.log'
    exit 0
    ;;
esac
printf 'docker %s\\n' "$*" >> '${stub}/calls/docker.log'
exit 0
`;

const WGET_STUB = (stub) => `#!/bin/sh
url=''
post=''
for arg in "$@"; do
  case "$arg" in
    http*) url=$arg ;;
    --post-data=*) post=\${arg#--post-data=} ;;
  esac
done
case "$url" in
  *runtime-drain*)
    printf '%s\\n' "$post" >> '${stub}/calls/drain.log'
    [ "\${STUB_DRAIN_FAIL:-0}" = 1 ] && exit 22
    printf '{"ok":true,"runtime":{"draining":true}}\\n'
    exit 0 ;;
  */health*)
    [ "\${STUB_HEALTH_EMPTY:-0}" = 1 ] && exit 4
    cat '${stub}/health.txt'
    exit 0 ;;
  */admin/api/summary*)
    cat '${stub}/summary.txt'
    exit 0 ;;
esac
exit 0
`;

const BASH_STUB = (stub) => `#!/bin/sh
# Stands in for scripts/deploy-router-instance.sh and records what the updater
# handed it. Only ever reached through \`env VAR=... bash <script>\`.
{
  printf 'BIND_IP=%s\\n' "$BIND_IP"
  printf 'BASE=%s\\n' "$BASE"
  printf 'ENV_FILE=%s\\n' "$ENV_FILE"
  printf 'COMPOSE_FILE=%s\\n' "$COMPOSE_FILE"
  printf 'REV=%s\\n' "$REV"
  printf 'ROUTER_HOSTS=%s\\n' "$ROUTER_HOSTS"
  printf 'ROUTER_DEFAULT_HOST=%s\\n' "$ROUTER_DEFAULT_HOST"
  printf 'SOURCE_REVISION=%s\\n' "$SOURCE_REVISION"
  printf 'script=%s\\n' "$1"
} >> '${stub}/calls/deploy.log'
exit 0
`;

// Lay out a fixture the way the router host is laid out: state and credentials
// beside the checkout, never inside it.
function makeFixture(t, { commits = 1, localOnly = 0, originAhead = 0, deployed = 'head' } = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'llm-router-update-')));
  const deploymentBase = path.join(root, 'deployments', 'llm-router');
  const source = path.join(deploymentBase, 'source');
  const origin = path.join(root, 'origin.git');
  const credentialsDir = path.join(root, 'credentials', 'llm-router');
  const stub = path.join(root, 'stub');
  const shim = path.join(root, 'shim');
  fs.mkdirSync(path.join(source, 'scripts'), { recursive: true });
  fs.mkdirSync(path.join(deploymentBase, 'data'), { recursive: true });
  fs.mkdirSync(path.join(deploymentBase, 'runtime'), { recursive: true });
  fs.mkdirSync(path.join(stub, 'calls'), { recursive: true });
  fs.mkdirSync(shim, { recursive: true });
  fs.mkdirSync(credentialsDir, { recursive: true });

  fs.writeFileSync(path.join(credentialsDir, 'router.env'), 'CATALOG_PUSH_TOKEN=push-token\nADMIN_TOKEN=admin-token\n');
  fs.writeFileSync(path.join(stub, 'health.txt'), '{"ok":true,"router":{"runtime":{"active_count":0,"queued_count":0}}}\n');
  fs.writeFileSync(path.join(stub, 'summary.txt'), '{"router":{"runtime":{"active_count":0,"queued_count":0}}}\n');
  fs.writeFileSync(path.join(stub, 'api.txt'), '192.168.1.99 11434\n');
  fs.writeFileSync(path.join(stub, 'admin.txt'), '192.168.1.99 11435\n');
  fs.writeFileSync(path.join(stub, 'label.txt'), 'llm-router-updater:latest\n');
  fs.writeFileSync(path.join(stub, 'env.txt'), 'ROUTER_HOSTS=rosalina,daisy\nROUTER_DEFAULT_HOST=rosalina\nPATH=/usr/bin\n');
  fs.writeFileSync(path.join(shim, 'docker'), DOCKER_STUB(stub));
  fs.writeFileSync(path.join(shim, 'wget'), WGET_STUB(stub));
  fs.writeFileSync(path.join(shim, 'bash'), BASH_STUB(stub));
  for (const file of ['docker', 'wget', 'bash']) fs.chmodSync(path.join(shim, file), 0o755);

  git(['init', '--quiet', '--bare', '-b', 'main', origin]);
  git(['init', '--quiet', '-b', 'main'], source);
  git(['remote', 'add', 'origin', origin], source);
  fs.copyFileSync(scriptPath, path.join(source, 'scripts', 'update-and-restart.sh'));
  fs.writeFileSync(path.join(source, 'scripts', 'deploy-router-instance.sh'), '#!/usr/bin/env bash\necho shipped\n');
  git(['add', '-A'], source);
  git(['commit', '--quiet', '-m', 'router checkout'], source);
  for (let n = 2; n <= commits; n += 1) {
    fs.writeFileSync(path.join(source, `note-${n}.md`), `${n}\n`);
    git(['add', '-A'], source);
    git(['commit', '--quiet', '-m', `commit ${n}`], source);
  }
  git(['push', '--quiet', '-u', 'origin', 'main'], source);
  const pushed = [];
  for (let n = 1; n <= originAhead; n += 1) {
    // A second clone is the only honest way to move origin ahead of the
    // deployment checkout.
    const other = path.join(root, `other-${n}`);
    git(['clone', '--quiet', origin, other]);
    fs.writeFileSync(path.join(other, `origin-${n}.md`), `${n}\n`);
    git(['add', '-A'], other);
    git(['commit', '--quiet', '-m', `origin commit ${n}`, '--date', `2026-01-0${n} 10:00:00 +0000`], other);
    git(['push', '--quiet', 'origin', 'main'], other);
    pushed.push(git(['rev-parse', 'HEAD'], other));
  }
  for (let n = 1; n <= localOnly; n += 1) {
    fs.writeFileSync(path.join(source, `local-${n}.md`), `${n}\n`);
    git(['add', '-A'], source);
    git(['commit', '--quiet', '-m', `local commit ${n}`], source);
  }
  const head = git(['rev-parse', 'HEAD'], source);
  const deployedRevision = deployed === 'head' ? head : deployed === 'none' ? '' : deployed;
  const lockDir = path.join(source, '.git', 'llm-router-update.lock');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const script = path.join(source, 'scripts', 'update-and-restart.sh');
  return {
    root, source, origin, stub, script, head, lockDir,
    calls(name) {
      const file = path.join(stub, 'calls', name);
      return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
    },
    targetTip: originAhead > 0 ? pushed[pushed.length - 1] : head,
    run(args = [], options = {}) {
      const result = spawnSync('/bin/sh', [script, ...args], {
        cwd: options.cwd ?? source,
        encoding: 'utf8',
        env: {
          PATH: `${shim}${path.delimiter}${process.env.PATH}`,
          HOME: root,
          GIT_CONFIG_GLOBAL: '/dev/null',
          GIT_CONFIG_SYSTEM: '/dev/null',
          ROUTER_UPDATE_ALLOWED_ORIGIN: origin,
          ROUTER_UPDATE_DRAIN_WAIT: '5',
          ROUTER_UPDATE_HEALTH_WAIT: '5',
          ROUTER_UPDATE_FETCH_TIMEOUT: '30',
          SERVICE_PORTAL_DEPLOYED_REVISION: deployedRevision,
          ...options.env
        }
      });
      return {
        status: result.status,
        stdout: result.stdout,
        stderr: result.stderr,
        calls(name) {
          const file = path.join(stub, 'calls', name);
          return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
        },
        headNow: git(['rev-parse', 'HEAD'], source),
        dirty: git(['status', '--porcelain'], source)
      };
    }
  };
}

test('a check on an up to date deployment reports current and changes nothing', (t) => {
  const fixture = makeFixture(t);
  const result = fixture.run(['check']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, new RegExp(`service-portal-check: status=current behind=0 deployed=${fixture.head} target=${fixture.head}`));
  assert.doesNotMatch(result.stdout, /service-portal-check-commit:/);
  assert.doesNotMatch(result.stdout + result.stderr, /Error:/);
  assert.equal(fs.existsSync(fixture.lockDir), false, 'the lock is released');
  assert.equal(result.dirty, '', 'the check left the checkout clean');
  assert.equal(result.headNow, fixture.head, 'the check did not move the checkout');
});

test('a check two commits behind reports available with the commits, newest first', (t) => {
  const fixture = makeFixture(t, { commits: 1, originAhead: 2 });
  const result = fixture.run(['check']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, new RegExp(`service-portal-check: status=available behind=2 deployed=${fixture.head} target=${fixture.targetTip}`));
  const commits = result.stdout.split('\n').filter((line) => line.startsWith('service-portal-check-commit:'));
  assert.equal(commits.length, 2);
  assert.match(commits[0], new RegExp(`^service-portal-check-commit: ${fixture.targetTip} \\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}[+-]\\d{2}:\\d{2} origin commit 2$`));
  assert.match(commits[1], /origin commit 1$/);
  // The portal keeps the last summary line it sees, so it has to come last.
  assert.ok(result.stdout.lastIndexOf('service-portal-check-commit:') < result.stdout.lastIndexOf('service-portal-check: status='));
});

test('a check with an unrecorded deployed revision falls back to the checkout HEAD', (t) => {
  const fixture = makeFixture(t, { deployed: 'none' });
  const result = fixture.run(['check']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /service-portal-check-note: The running image does not record its source revision; compared with the checkout HEAD\./);
  assert.match(result.stdout, new RegExp(`service-portal-check: status=current behind=0 deployed=${fixture.head} target=${fixture.head}`));
});

test('a check reports a running revision that is not in the checkout', (t) => {
  const fixture = makeFixture(t, { commits: 1, originAhead: 1, deployed: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef' });
  const result = fixture.run(['check']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /service-portal-check-note: The running revision is not in this checkout\./);
  assert.match(result.stdout, new RegExp(`service-portal-check: status=available behind=unknown deployed=unknown target=${fixture.targetTip}`));
});

test('an unknown argument is refused before any work, with exit code 2', (t) => {
  const fixture = makeFixture(t);
  for (const args of [['boom'], ['check', 'extra'], ['--help']]) {
    const result = fixture.run(args);
    assert.equal(result.status, 2, `${args.join(' ')} exited ${result.status}`);
    assert.equal(result.stderr.trim(), 'Error: usage: update-and-restart.sh [check]');
    assert.equal(result.stdout, '');
  }
  assert.equal(fixture.calls('docker.log'), '');
});

test('a dirty checkout refuses the update and is left alone', (t) => {
  const fixture = makeFixture(t);
  fs.writeFileSync(path.join(fixture.source, 'stray.txt'), 'edited on the deployment host\n');
  const result = fixture.run();
  assert.equal(result.status, 1);
  assert.match(result.stderr, /^Error: refusing to update a checkout with uncommitted changes:/m);
  assert.match(result.stderr, /stray\.txt/);
  assert.doesNotMatch(result.calls('docker.log'), /^compose/m, 'nothing was built or restarted');
  assert.equal(result.headNow, fixture.head);
  assert.equal(fs.existsSync(fixture.lockDir), false, 'the lock is released after a refusal');
});

test('a divergent origin/main is refused instead of merged', (t) => {
  const fixture = makeFixture(t, { localOnly: 1, originAhead: 1 });
  const result = fixture.run();
  assert.equal(result.status, 1);
  assert.match(result.stderr, /^Error: refusing a divergent or rewritten origin\/main history\.$/m);
  assert.equal(result.headNow, fixture.head, 'the checkout was not touched');
  assert.doesNotMatch(result.calls('docker.log'), /^compose/m);
  assert.equal(fs.existsSync(fixture.lockDir), false);
});

test('an update fast-forwards, drains, deploys with the fleet passed through, and reports the pair', (t) => {
  const fixture = makeFixture(t, { commits: 1, originAhead: 2 });
  const result = fixture.run();
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.headNow, fixture.targetTip, 'the checkout fast-forwarded to origin/main');
  assert.match(result.stdout, new RegExp(`Update complete: ${fixture.head} -> ${fixture.targetTip}`));
  assert.match(result.stdout, /keeping the deployed fleet: ROUTER_HOSTS=rosalina,daisy ROUTER_DEFAULT_HOST=rosalina/);

  const deploy = result.calls('deploy.log');
  assert.match(deploy, /^ROUTER_HOSTS=rosalina,daisy$/m, 'the deployed fleet is passed through, not the compose default');
  assert.match(deploy, /^ROUTER_DEFAULT_HOST=rosalina$/m);
  assert.match(deploy, new RegExp(`^SOURCE_REVISION=${fixture.targetTip}$`, 'm'), 'the built image records the revision that is deployed');
  assert.match(deploy, /^BIND_IP=192\.168\.1\.99$/m, 'the published address is read back from the running container');
  assert.match(deploy, new RegExp(`^BASE=${re(path.join(fixture.root, 'deployments', 'llm-router'))}$`, 'm'));
  assert.match(deploy, new RegExp(`^ENV_FILE=${re(path.join(fixture.root, 'credentials', 'llm-router', 'router.env'))}$`, 'm'));
  assert.match(deploy, new RegExp(`^script=${re(path.join(fixture.source, 'scripts', 'deploy-router-instance.sh'))}$`, 'm'));

  const docker = result.calls('docker.log');
  assert.match(docker, /compose -p llm-router .* config --quiet/);
  assert.match(docker, /compose -p llm-router .* up -d --wait --wait-timeout 5/);
  assert.match(docker, /^compose -p llm-router .* ps$/m);
  assert.doesNotMatch(docker, /(^|\s)down(\s|$)/, 'an update never takes the stack down');

  assert.deepEqual(result.calls('drain.log').trim().split('\n'),
    ['{"enabled":true,"reason":"update"}', '{"enabled":false,"reason":"update"}'], 'the drain is opened, then cleared');
  assert.equal(fs.existsSync(fixture.lockDir), false);
});

test('a router that never answers health fails the update and still clears the drain', (t) => {
  const fixture = makeFixture(t);
  const result = fixture.run([], { env: { STUB_HEALTH_EMPTY: '1' } });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /^Error: the updated router is not answering/m);
  assert.match(result.calls('drain.log'), /\{"enabled":true,"reason":"update"\}/);
  assert.match(result.calls('drain.log'), /\{"enabled":false,"reason":"update"\}/);
});

test('a router that will not accept the drain still updates, with a note', (t) => {
  const fixture = makeFixture(t);
  const result = fixture.run([], { env: { STUB_DRAIN_FAIL: '1' } });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /note: the router would not accept the drain/);
  assert.match(result.stdout, /Update complete/);
  assert.doesNotMatch(result.calls('drain.log'), /"enabled":false/);
});

test('a second run refuses while the lock is held, and a stale lock is dropped', (t) => {
  const fixture = makeFixture(t);
  fs.mkdirSync(fixture.lockDir);
  const busy = fixture.run(['check']);
  assert.equal(busy.status, 1);
  assert.match(busy.stderr, /^Error: another update is in progress\.$/m);
  assert.doesNotMatch(busy.stdout, /service-portal-check:/);
  assert.equal(fs.existsSync(fixture.lockDir), true, 'a refused run leaves the held lock alone');

  // A lock left behind by a run that died must not disable the button forever.
  const old = new Date(Date.now() - 7200 * 1000);
  fs.utimesSync(fixture.lockDir, old, old);
  const stale = fixture.run(['check']);
  assert.equal(stale.status, 0, stale.stderr);
  assert.match(stale.stdout, /Dropping an update lock older than/);
  assert.match(stale.stdout, /service-portal-check: status=current/);
});

test('an update inside the portal runner hands off to a maintenance container', (t) => {
  const fixture = makeFixture(t);
  const socket = path.join(fixture.root, 'docker.sock');
  const server = net.createServer();
  server.listen(socket);
  t.after(() => { server.close(); fs.rmSync(socket, { force: true }); });
  for (let waited = 0; waited < 50 && !fs.existsSync(socket); waited += 1) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
  assert.ok(fs.statSync(socket).isSocket(), 'the fixture provides a socket without a Docker daemon');

  const result = fixture.run([], {
    env: {
      SERVICE_PORTAL_UPDATE_DELEGATED: '1',
      SERVICE_PORTAL_UPDATE_JOB_ID: 'a1b2c3d4-0000-4000-8000-000000000001',
      ROUTER_UPDATE_SOCKET: socket
    }
  });
  assert.equal(result.status, 0, result.stderr);
  const run = result.calls('docker-run.log');
  assert.match(run, new RegExp(`--mount\\ntype=bind,source=${re(fixture.source)},target=${re(fixture.source)}`), 'the checkout is bound at its own path');
  assert.match(run, new RegExp(`--mount\\ntype=bind,source=${re(path.join(fixture.root, 'deployments', 'llm-router'))},target=`), 'the state beside the checkout is bound');
  assert.match(run, new RegExp(`--mount\\ntype=bind,source=${re(path.join(fixture.root, 'credentials', 'llm-router'))},target=.*,readonly`), 'the secrets directory is bound read-only');
  assert.match(run, new RegExp(`--mount\\ntype=bind,source=${re(socket)},target=`), 'the socket is bound');
  assert.match(run, /--label\nio\.service-portal\.maintenance=true/);
  assert.match(run, /--label\nio\.service-portal\.maintenance\.job=a1b2c3d4-0000-4000-8000-000000000001/);
  assert.match(run, /^--network=host$/m, 'the published router ports are reachable from stage 2');
  assert.match(run, /^--env\nLLM_ROUTER_MAINTENANCE_RUNNER=1$/m);
  assert.match(run, /^--env\nSERVICE_PORTAL_UPDATE_DELEGATED=1$/m);
  assert.match(run, /^--env\nSERVICE_PORTAL_UPDATE_JOB_ID=a1b2c3d4-0000-4000-8000-000000000001$/m);
  assert.match(run, /^--workdir\n/m);
  assert.match(run, /--group-add\n\d+/);
  assert.match(run, /^--entrypoint\n\/bin\/sh$/m);
  assert.match(run, /^llm-router-updater:latest$/m, 'the image recorded on the running container is the one used');
  assert.match(run, new RegExp(`${re(fixture.script)}$`, 'm'), 'stage 2 is this same script');
  assert.doesNotMatch(result.calls('docker.log'), /^compose/m, 'nothing is built from the runner');
  assert.equal(fs.existsSync(fixture.lockDir), false, 'stage 1 does not hold the lock stage 2 needs');
});
