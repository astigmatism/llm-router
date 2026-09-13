#!/usr/bin/env python3
"""Try the owner-selected 160K Daytime context, falling back to 144K.

Run from a clean published release in a reserved Daytime idle window. Retain
the existing 1024 MiB reserve, MTP, engine, artifacts, and generation policy.
Only the coding service is recreated; Nighttime and router stay resident.
"""
import copy
import datetime
import fcntl
import hashlib
import importlib.util
import json
from pathlib import Path
import re
import shutil
import subprocess
import sys
import threading
import time

sys.dont_write_bytecode = True
SOURCE = Path(__file__).resolve().parents[2]
PRIMARY = Path('/home/astigmatism/apps/local-ai-primary')
MODEL = 'qwen3.8-27b-q8_0'
BACKEND = 'http://127.0.0.1:18080'
TARGETS = (163840, 147456)
BEFORE = {
    'manifest.json': '1a275269785957517e9225580a953b7776ea3377e85f154b60f6c98e2b745d56',
    'compose.json': '11ded7aba751478d356190595d78c4194cbe8d15d752ac9ea7af2ca14bc21a02',
    'model-catalog.json': '772547d4fd26e09cbb53f1f1e5eed34477044d27ca0e74599efbf64386f8ea72',
    'primary.py': '3cee57629efcd27c9015895bcadcbe5c32e12a432908ad81e71a00ded29ad3f6',
}


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


c = load('daytime_capacity_helpers', Path(__file__).with_name('deploy-nighttime-context.py'))


def proposal(manifest, compose, catalog, target):
    if type(target) is not int or target not in TARGETS:
        raise ValueError('Only the owner-selected 160K and 144K trials are authorized')
    manifest, compose, catalog = copy.deepcopy((manifest, compose, catalog))
    day = next(s for s in manifest['services'] if s['role'] == 'coding')
    cfg = compose['services']['coding']
    if (day['model_alias'] != MODEL or day['context_tokens'] != 131072
            or day['parallel_slots'] != 1 or cfg['container_name'] != 'qwen38-daytime'
            or cfg['command'] != day['recommended_argv']):
        raise ValueError('Daytime differs from the reviewed 128K single-slot baseline')
    argv = cfg['command']
    for flag, expected in [('--ctx-size', '131072'), ('--kv-unified-per-slot', '131072'),
                           ('--spec-type', 'draft-mtp'), ('--spec-draft-n-max', '3'),
                           ('--n-predict', '-1'), ('--reasoning-budget', '-1')]:
        if argv.count(flag) != 1 or argv[argv.index(flag) + 1] != expected:
            raise ValueError('Unexpected Daytime argument: ' + flag)
    for flag in ['--ctx-size', '--kv-unified-per-slot']:
        argv[argv.index(flag) + 1] = str(target)
    day['recommended_argv'] = copy.deepcopy(argv)
    day['context_tokens'] = target
    for row in [catalog, *catalog['models']]:
        if row['model'] == MODEL:
            row.update(context_length=target, total_context_length=target,
                       display_name=f'Daytime ({target // 1024}K)')
    return manifest, compose, catalog


def require_idle(p, backend=True):
    state = p.admin('runtime-state')['runtime']
    if (state['draining'] or state.get('active_by_model', {}).get(MODEL, 0)
            or state.get('queued_by_model', {}).get(MODEL, 0)):
        raise RuntimeError('Daytime router work is active/queued or router is drained')
    if backend and any(s.get('is_processing') for s in p.http(BACKEND + '/slots')):
        raise RuntimeError('Daytime backend is busy; no service has been stopped')


def wait_for_quiet(p, seconds=90):
    """Avoid mistaking a gap between tool calls for a completed workflow."""
    since, previous = None, None
    print(f'Waiting for {seconds} seconds without Daytime activity', flush=True)
    while True:
        try:
            require_idle(p)
            tasks = [s.get('id_task') for s in p.http(BACKEND + '/slots')]
            if since is None or tasks != previous:
                since = time.monotonic()
            previous = tasks
            if time.monotonic() - since >= seconds:
                return
        except RuntimeError:
            since = None
        time.sleep(5)


def publish_daytime(p, catalog):
    """Replace Daytime and its default root projection, preserving Nighttime."""
    marker = p.read(p.MARKER)
    entry = copy.deepcopy(next(row for row in catalog['models'] if row['model'] == MODEL))
    ci = p.inspect('qwen38-daytime')
    argv = ci['Config']['Cmd']
    for flag, value in [('--ctx-size', str(entry['context_length'])),
                        ('--kv-unified-per-slot', str(entry['context_length'])),
                        ('--n-predict', '-1'), ('--reasoning-budget', '-1'),
                        ('--reasoning-effort', 'default'), ('--spec-type', 'draft-mtp'),
                        ('--spec-draft-n-max', '3')]:
        if argv.count(flag) != 1 or argv[argv.index(flag) + 1] != value:
            raise RuntimeError('Daytime publication differs from running ' + flag)
    entry['runtime_output_policy'] = {
        'n_predict': -1, 'reasoning_budget': -1, 'reasoning_effort': 'default',
        'verification': 'docker-inspect-argv', 'verified_at': p.now(),
        'container_id': ci['Id'], 'started_at': ci['State']['StartedAt'],
        'argv_sha256': hashlib.sha256(json.dumps(argv).encode()).hexdigest()}
    entry['updated_at'] = p.now()
    entry['backend_revision'] = p.read(p.MANIFEST)['engine']['revision']
    marker['models'] = [entry if row['model'] == MODEL else row for row in marker['models']]
    if marker['default_model'] != MODEL:
        raise RuntimeError('Unexpected default model')
    marker.update(entry)
    p.write(p.MARKER, marker)
    p.admin('reload-config', {})


def main():
    revision = subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=SOURCE, text=True).strip()
    if subprocess.check_output(['git', 'status', '--porcelain'], cwd=SOURCE, text=True).strip():
        raise RuntimeError('Deploy from a clean published checkout')
    p = load('daytime_primary', SOURCE / 'scripts/primary/primary.py')
    p.ROOT, p.MANIFEST = PRIMARY, PRIMARY / 'manifest.json'
    with (p.HOME_DIR / '.local-ai-profile-switch.lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        for name, expected in BEFORE.items():
            if c.digest(PRIMARY / name) != expected:
                raise RuntimeError(name + ' changed since review')
        qualified = p.read(PRIMARY / 'evidence/qualified.json')
        if qualified['manifest_sha256'] != c.digest(p.MANIFEST):
            raise RuntimeError('Current runtime is not qualified')
        p.validate()
        p.runtime_identity()
        wait_for_quiet(p)
        baseline = [p.read(PRIMARY / name) for name in ['manifest.json', 'compose.json', 'model-catalog.json']]
        others = {name: c.resident_snapshot(p, name) for name in ['qwen38-nighttime', 'local-ai-ollama-router']}
        marker_before = p.read(p.MARKER)
        backup = PRIMARY / 'corrections' / ('daytime-context-' + datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ'))
        backup.mkdir(parents=True, mode=0o700)
        names = ['manifest.json', 'compose.json', 'model-catalog.json', 'evidence/qualified.json', 'evidence/live-identity.json']
        for name in names:
            (backup / 'before' / name).parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(PRIMARY / name, backup / 'before' / name)
        p.write(backup / 'active-model-before.json', marker_before)
        p.write(backup / 'residents-before.json', others)
        day = next(s for s in baseline[0]['services'] if s['role'] == 'coding')
        ids = day['container_contract']['gpu_device_ids']
        floor = baseline[0]['minimum_free_vram_mib_per_gpu']
        results, changed, backend_ok = [], False, True

        def preserve_others():
            if any(snapshot != c.resident_snapshot(p, name) for name, snapshot in others.items()):
                raise RuntimeError('Nighttime or router changed during the Daytime trial')
            night = lambda marker: [row for row in marker['models'] if row['model'] != MODEL]
            if night(marker_before) != night(p.read(p.MARKER)):
                raise RuntimeError('Nighttime discovery changed during the Daytime trial')

        try:
            for target in TARGETS:
                preserve_others()
                require_idle(p, backend=backend_ok)
                evidence = backup / str(target)
                evidence.mkdir(mode=0o700)
                result = {'context': target, 'started_at': p.now()}
                samples, errors, stop = [], [], threading.Event()
                def observe():
                    while not stop.is_set():
                        try:
                            samples.append({'utc': p.now(), 'gpus': c.memory(p, ids)})
                        except Exception as exc:
                            errors.append(str(exc))
                        stop.wait(1)
                watcher = threading.Thread(target=observe, daemon=True)
                accepted = False
                try:
                    manifest, compose, catalog = proposal(*baseline, target)
                    changed, backend_ok = True, False
                    p.write(PRIMARY / 'manifest.json', manifest)
                    p.write(PRIMARY / 'compose.json', compose)
                    p.validate()
                    print(f'Loading Daytime {target // 1024}K; evidence: {evidence}', flush=True)
                    p.compose('up', '-d', '--no-deps', '--pull', 'never', 'coding')
                    p.wait_health(18080, 'qwen38-daytime')
                    p.runtime_identity()
                    backend_ok = True
                    result['loaded_free_mib'] = {g['uuid']: g['free_mib'] for g in c.memory(p, ids)}
                    print('Loaded free MiB: ' + json.dumps(result['loaded_free_mib']), flush=True)
                    watcher.start()
                    if len(result['loaded_free_mib']) != 2 or min(result['loaded_free_mib'].values()) < floor:
                        raise RuntimeError('Loaded Daytime is below its existing 1024 MiB reserve')
                    result['checks'] = c.qualify(p, evidence, catalog, MODEL, BACKEND, publish_daytime)
                    log_result = subprocess.run(['docker', 'logs', 'qwen38-daytime'], capture_output=True, text=True, check=True)
                    logs = log_result.stdout + log_result.stderr
                    (evidence / 'backend.log').write_text(logs)
                    if not re.search(r'draft acceptance = [0-9.]+ \(\s*[1-9][0-9]* accepted', logs):
                        raise RuntimeError('No accepted MTP draft tokens were observed')
                    if re.search(r'CUDA error|out of memory|failed to allocate|GGML_ASSERT', logs, re.I):
                        raise RuntimeError('Backend reported an allocation or CUDA failure')
                    result['checks']['mtp_accepted_tokens_observed'] = True
                    preserve_others()
                    accepted = True
                except Exception as exc:
                    result['error'] = str(exc)
                    # Only a failed request launched by this trial may remain.
                    # Router admission is rechecked before any subsequent stop.
                    backend_ok = False
                    logs = subprocess.run(['docker', 'logs', '--tail', '300', 'qwen38-daytime'], capture_output=True, text=True)
                    (evidence / 'backend-failure.log').write_text(logs.stdout + logs.stderr)
                finally:
                    stop.set()
                    if watcher.is_alive():
                        watcher.join(timeout=10)
                    p.write(evidence / 'memory.json', {'samples': samples, 'errors': errors})
                if accepted:
                    if errors or not samples or any(len(s['gpus']) != 2 for s in samples):
                        accepted = False
                        result['error'] = 'GPU memory observation was incomplete'
                    else:
                        result['minimum_free_mib'] = {gpu: min(g['free_mib'] for s in samples for g in s['gpus'] if g['uuid'] == gpu) for gpu in ids}
                        if min(result['minimum_free_mib'].values()) < floor:
                            accepted = False
                            result['error'] = 'Loaded testing fell below the existing 1024 MiB reserve'
                result.update(ok=accepted, completed_at=p.now())
                results.append(result)
                p.write(evidence / 'result.json', result)
                p.write(backup / 'progress.json', results)
                print('TRIAL ' + json.dumps(result), flush=True)
                if accepted:
                    receipt = {'completed_at': p.now(), 'source_revision': revision,
                        'source_directory': str(SOURCE), 'final_context': target, 'trials': results,
                        'minimum_free_vram_mib_per_gpu': floor, 'nighttime_and_router_unchanged': True,
                        'manifest_sha256': c.digest(p.MANIFEST)}
                    p.write(backup / 'qualification.json', receipt)
                    qualified.update(manifest_sha256=c.digest(p.MANIFEST), daytime_context_selection={
                        'receipt': str(backup / 'qualification.json'), 'completed_at': receipt['completed_at']})
                    p.write(PRIMARY / 'evidence/qualified.json', qualified)
                    p.write(PRIMARY / 'evidence/live-identity.json', p.runtime_identity())
                    print('ACCEPTED ' + json.dumps(receipt), flush=True)
                    return
            raise RuntimeError('Neither 160K nor 144K passed; restoring the qualified 128K baseline')
        except BaseException:
            if changed:
                require_idle(p, backend=False)
                print('Restoring Daytime 128K', flush=True)
                for name in names:
                    shutil.copy2(backup / 'before' / name, PRIMARY / name)
                p.compose('up', '-d', '--no-deps', '--pull', 'never', 'coding')
                p.wait_health(18080, 'qwen38-daytime')
                publish_daytime(p, baseline[2])
                p.write(PRIMARY / 'evidence/live-identity.json', p.runtime_identity())
                preserve_others()
                p.write(backup / 'rollback.json', {'completed_at': p.now(), 'context': 131072})
            raise


if __name__ == '__main__':
    main()
