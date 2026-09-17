#!/usr/bin/env python3
"""Try the owner-selected 160K Daytime context, falling back to 144K.

Run from a clean published release in a reserved Daytime idle window.
--accept-160 tests from the qualified 144K baseline using the owner-authorized
measured-headroom policy and matched performance checks. Retain MTP, engine,
artifacts, and generation policy.
Only the coding service is recreated; Nighttime and router stay resident.
"""
import argparse
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

ACCEPT_160_BEFORE = {
    'manifest.json': 'ddf8fd48dc13ee329ade0454340f6416dbdf6a4278eb35f79f0972acfc0362b0',
    'compose.json': 'be76f09de9717d9884cefcb93a7f141af424b3edce33cca11c48caf6f00a23d8',
    'model-catalog.json': '5d34d1a86d5ed7e011d1d18139eabcbb1c46ca068532e77ba9faf1dfb7167c6e',
    'primary.py': BEFORE['primary.py'],
}


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


c = load('daytime_capacity_helpers', Path(__file__).with_name('deploy-nighttime-context.py'))


def proposal(manifest, compose, catalog, target, from_context=131072, measured_headroom=False):
    if type(target) is not int or target not in TARGETS:
        raise ValueError('Only the owner-selected 160K and 144K trials are authorized')
    if from_context not in (131072, 147456) or (measured_headroom and (from_context, target) != (147456, 163840)):
        raise ValueError('Unexpected capacity or measured-headroom selection')
    manifest, compose, catalog = copy.deepcopy((manifest, compose, catalog))
    day = next(s for s in manifest['services'] if s['role'] == 'coding')
    cfg = compose['services']['coding']
    if (day['model_alias'] != MODEL or day['context_tokens'] != from_context
            or day['parallel_slots'] != 1 or cfg['container_name'] != 'qwen38-daytime'
            or cfg['command'] != day['recommended_argv']):
        raise ValueError('Daytime differs from the reviewed single-slot baseline')
    argv = cfg['command']
    for flag, expected in [('--ctx-size', str(from_context)), ('--kv-unified-per-slot', str(from_context)),
                           ('--spec-type', 'draft-mtp'), ('--spec-draft-n-max', '3'),
                           ('--n-predict', '-1'), ('--reasoning-budget', '-1')]:
        if argv.count(flag) != 1 or argv[argv.index(flag) + 1] != expected:
            raise ValueError('Unexpected Daytime argument: ' + flag)
    for flag in ['--ctx-size', '--kv-unified-per-slot']:
        argv[argv.index(flag) + 1] = str(target)
    day['recommended_argv'] = copy.deepcopy(argv)
    day['context_tokens'] = target
    if measured_headroom:
        day['qualification_contract'] = {'capacity': {
            'allocated_context_tokens': {'coding': target},
            'minimum_free_vram_mib_per_gpu': None,
            'previous_minimum_free_vram_mib_per_gpu': manifest['minimum_free_vram_mib_per_gpu'],
            'headroom_policy': 'Owner accepts measured headroom at 160K; retain only after natural long-context, tool, memory-stability and matched performance checks. The former 1024 MiB reserve is informational, not an acceptance gate.',
        }}
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


def checked_completion(p, directory, name, body, expected):
    choice = c.complete(p, directory, name, body, BACKEND)
    if choice['finish_reason'] != 'stop' or c.parsed_json(choice['message']['content']) != expected:
        raise RuntimeError(name + ' failed natural three-key retrieval')


def performance_comparison(reference, candidate):
    """Compare the same uncapped prompt, including actual cache and MTP timing."""
    before, after = reference['response'], candidate['response']
    if reference['request'] != candidate['request']:
        raise RuntimeError('Performance requests differ')
    if before['usage']['prompt_tokens'] != after['usage']['prompt_tokens']:
        raise RuntimeError('Performance prompt lengths differ')
    old, new = before['timings'], after['timings']
    if max(old['cache_n'], new['cache_n']) > before['usage']['prompt_tokens'] * .01:
        raise RuntimeError('Performance comparison reused substantial prompt cache')
    result = {'input_tokens': before['usage']['prompt_tokens'], 'reference_144K': old,
              'candidate_160K': new, 'single_matched_sample': True}
    for field in ['prompt_per_second', 'predicted_per_second']:
        ratio = new[field] / old[field]
        result[field + '_ratio'] = ratio
        # A pronounced slowdown is a reason to investigate/restore, unlike
        # crossing the former VRAM reserve by a few MiB.
        if ratio < .75:
            raise RuntimeError(f'Matched {field} fell more than 25%: ratio={ratio:.3f}')
    return result


def main(retry_144=False, accept_160=False):
    if (PRIMARY / 'runtime-owner.json').exists():
        raise RuntimeError('Runtime settings are owned by local-ai-runtime; edit and deploy its profile definitions')
    revision = subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=SOURCE, text=True).strip()
    if subprocess.check_output(['git', 'status', '--porcelain'], cwd=SOURCE, text=True).strip():
        raise RuntimeError('Deploy from a clean published checkout')
    p = load('daytime_primary', SOURCE / 'scripts/primary/primary.py')
    p.ROOT, p.MANIFEST = PRIMARY, PRIMARY / 'manifest.json'
    with (p.HOME_DIR / '.local-ai-profile-switch.lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        for name, expected in (ACCEPT_160_BEFORE if accept_160 else BEFORE).items():
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
        previous_context = day['context_tokens']
        targets = (163840,) if accept_160 else ((147456,) if retry_144 else TARGETS)
        results, changed, backend_ok = [], False, True

        def preserve_others():
            if any(snapshot != c.resident_snapshot(p, name) for name, snapshot in others.items()):
                raise RuntimeError('Nighttime or router changed during the Daytime trial')
            night = lambda marker: [row for row in marker['models'] if row['model'] != MODEL]
            if night(marker_before) != night(p.read(p.MARKER)):
                raise RuntimeError('Nighttime discovery changed during the Daytime trial')

        try:
            matched_body = matched_expected = None
            if accept_160:
                reference = backup / '144K-reference'
                reference.mkdir(mode=0o700)
                matched_body, matched_expected, matched_count = c.long_request(p, previous_context, MODEL, BACKEND)
                checked_completion(p, reference, 'matched-reference', matched_body, matched_expected)
                require_idle(p)
            for target in targets:
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
                    manifest, compose, catalog = proposal(*baseline, target, previous_context, accept_160)
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
                    if len(result['loaded_free_mib']) != 2:
                        raise RuntimeError('Missing GPU memory observations')
                    if not accept_160 and min(result['loaded_free_mib'].values()) < floor:
                        raise RuntimeError('Loaded Daytime is below its existing 1024 MiB reserve')
                    if accept_160:
                        checked_completion(p, evidence, 'matched-candidate', matched_body, matched_expected)
                        result['matched_performance'] = performance_comparison(
                            p.read(reference / 'matched-reference.json'),
                            p.read(evidence / 'matched-candidate.json'))
                        print('Matched performance: ' + json.dumps(result['matched_performance']), flush=True)
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
                        result['previous_reserve_passed'] = min(result['minimum_free_mib'].values()) >= floor
                        if not accept_160 and not result['previous_reserve_passed']:
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
                        'minimum_free_vram_mib_per_gpu': None if accept_160 else floor,
                        'headroom_policy': 'Owner accepted measured headroom; tested stability and matched performance' if accept_160 else '1024 MiB reserve',
                        'nighttime_and_router_unchanged': True,
                        'manifest_sha256': c.digest(p.MANIFEST)}
                    p.write(backup / 'qualification.json', receipt)
                    qualified.update(manifest_sha256=c.digest(p.MANIFEST), daytime_context_selection={
                        'receipt': str(backup / 'qualification.json'), 'completed_at': receipt['completed_at']})
                    p.write(PRIMARY / 'evidence/qualified.json', qualified)
                    p.write(PRIMARY / 'evidence/live-identity.json', p.runtime_identity())
                    print('ACCEPTED ' + json.dumps(receipt), flush=True)
                    return
            raise RuntimeError(f'Capacity acceptance failed; restoring the qualified {previous_context // 1024}K baseline')
        except BaseException:
            if changed:
                # A rejected publication can also make the admin discovery
                # endpoint fail. Restore valid metadata before querying idle.
                p.write(p.MARKER, marker_before)
                p.admin('reload-config', {})
                require_idle(p, backend=False)
                print(f'Restoring Daytime {previous_context // 1024}K', flush=True)
                for name in names:
                    shutil.copy2(backup / 'before' / name, PRIMARY / name)
                p.compose('up', '-d', '--no-deps', '--pull', 'never', 'coding')
                p.wait_health(18080, 'qwen38-daytime')
                publish_daytime(p, baseline[2])
                p.write(PRIMARY / 'evidence/live-identity.json', p.runtime_identity())
                preserve_others()
                p.write(backup / 'rollback.json', {'completed_at': p.now(), 'context': previous_context})
            raise


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--retry-144', action='store_true',
                        help='Retry 144K after a completed 160K trial and restored 128K baseline')
    parser.add_argument('--accept-160', action='store_true', help='Owner-authorized 160K from 144K; judge measured performance and stability, not the former VRAM reserve')
    args = parser.parse_args()
    if args.retry_144 and args.accept_160:
        parser.error('Choose one context workflow')
    main(args.retry_144, args.accept_160)
