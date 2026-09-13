#!/usr/bin/env python3
"""Find Nighttime's allocation and loaded-test ceilings at 4K resolution.

Uses only the existing pinned image, weights, GPU pair, and output policy. The
owner must reserve Nighttime for this experiment. Daytime and router stay running.
Only the final headroom-qualified context is advertised; failed probes are private.
"""
import argparse
import copy
import datetime
import fcntl
import importlib.util
import json
import math
from pathlib import Path
import shutil
import subprocess
import sys
import threading
import time

sys.dont_write_bytecode = True
SOURCE = Path(__file__).resolve().parents[2]
PRIMARY = Path('/home/astigmatism/apps/local-ai-primary')
STEP = 4096
LIMIT = 262144
BEFORE = {
    'primary.py': '3cee57629efcd27c9015895bcadcbe5c32e12a432908ad81e71a00ded29ad3f6',
    'manifest.json': 'be2811b737be301a912591a63cfad144ba0d1e1d5aae37d4e8732d13b58cdd1f',
    'compose.json': 'f3b05de43e39f1b53e0029c5d6a340940e863bb745ba079c114400dbf6623c09',
    'model-catalog.json': 'c06e4a128f6c6a9237ad1badce168174499ed49c996467054141a8a60c6154ce',
}


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


c = load('capacity', Path(__file__).with_name('deploy-nighttime-context.py'))


def proposal(manifest, compose, catalog, target):
    if type(target) is not int or target < 65536 or target > LIMIT or target % STEP:
        raise ValueError('Probe must be 64K–256K in 4K increments')
    manifest, compose, catalog = copy.deepcopy((manifest, compose, catalog))
    night = next(s for s in manifest['services'] if s['role'] == 'everyday')
    cfg = compose['services']['everyday']
    previous = night['context_tokens']
    if night['model_alias'] != c.MODEL or night['parallel_slots'] != 1 or cfg['command'] != night['recommended_argv']:
        raise ValueError('Nighttime model, slots, or argv differ from the reviewed service')
    for flag in ['--ctx-size', '--kv-unified-per-slot']:
        argv = cfg['command']
        if argv.count(flag) != 1 or argv[argv.index(flag) + 1] != str(previous):
            raise ValueError('Nighttime declared capacity differs from its argv')
        argv[argv.index(flag) + 1] = str(target)
    night['recommended_argv'] = copy.deepcopy(cfg['command'])
    night['context_tokens'] = target
    contract = night['qualification_contract']
    contract['runtime'] = contract['runtime'].replace(f'{previous}-token slot', f'{target}-token slot')
    contract['capacity']['allocated_context_tokens']['everyday'] = target
    row = next(row for row in catalog['models'] if row['model'] == c.MODEL)
    row.update(context_length=target, total_context_length=target, display_name=f'Nighttime ({target // 1024}K)')
    return manifest, compose, catalog


def main(accept_context=None):
    if accept_context not in (None, 131072):
        raise ValueError('The explicitly accepted final target is 128K')
    revision = subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=SOURCE, text=True).strip()
    if subprocess.check_output(['git', 'status', '--porcelain'], cwd=SOURCE, text=True).strip():
        raise RuntimeError('Probe from a clean published checkout')
    p = load('primary_probe', SOURCE / 'scripts/primary/primary.py')
    p.ROOT, p.MANIFEST = PRIMARY, PRIMARY / 'manifest.json'
    with (p.HOME_DIR / '.local-ai-profile-switch.lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        for name, expected in BEFORE.items():
            if c.digest(PRIMARY / name) != expected:
                raise RuntimeError(name + ' changed since review')
        qualified = p.read(PRIMARY / 'evidence/qualified.json')
        if qualified['manifest_sha256'] != c.digest(p.MANIFEST):
            raise RuntimeError('Current 64K runtime is not qualified')
        p.validate()
        p.runtime_identity()
        c.require_idle(p)
        baseline = [p.read(PRIMARY / name) for name in ['manifest.json', 'compose.json', 'model-catalog.json']]
        day, router = [c.resident_snapshot(p, name) for name in ['qwen38-daytime', 'local-ai-ollama-router']]
        backup = PRIMARY / 'corrections' / ('nighttime-ceiling-' + datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ'))
        backup.mkdir(parents=True, mode=0o700)
        names = ['manifest.json', 'compose.json', 'model-catalog.json', 'evidence/qualified.json', 'evidence/live-identity.json']
        for name in names:
            (backup / 'before' / name).parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(PRIMARY / name, backup / 'before' / name)
        shutil.copy2(p.MARKER, backup / 'active-model-before.json')
        p.write(backup / 'residents-before.json', {'daytime': day, 'router': router})
        ids = next(s for s in baseline[0]['services'] if s['role'] == 'everyday')['container_contract']['gpu_device_ids']
        floor = baseline[0]['minimum_free_vram_mib_per_gpu']
        results, loaded = [], 65536

        def preserve_other_services():
            if day != c.resident_snapshot(p, 'qwen38-daytime') or router != c.resident_snapshot(p, 'local-ai-ollama-router'):
                raise RuntimeError('Daytime or router changed during the Nighttime experiment')

        def restart(target):
            nonlocal loaded
            preserve_other_services()
            # A failed load may have exited. Router work must still be absent.
            runtime = p.admin('runtime-state')['runtime']
            if runtime['draining'] or runtime.get('active_by_model', {}).get(c.MODEL) or runtime.get('queued_by_model', {}).get(c.MODEL):
                raise RuntimeError('Nighttime router work arrived during the reserved experiment')
            if loaded is not None:
                c.require_idle(p)
            m, spec, catalog = proposal(*baseline, target)
            if accept_context == target:
                contract = next(s for s in m['services'] if s['role'] == 'everyday')['qualification_contract']['capacity']
                contract['previous_minimum_free_vram_mib_per_gpu'] = contract['minimum_free_vram_mib_per_gpu']
                contract['minimum_free_vram_mib_per_gpu'] = None
                contract['headroom_policy'] = 'Owner explicitly accepted 128K with measured GPU headroom in place of the previous 1024 MiB reserve; retain the live acceptance receipt.'
            p.write(PRIMARY / 'manifest.json', m)
            p.write(PRIMARY / 'compose.json', spec)
            p.validate()
            loaded = None
            print(f'Loading Nighttime at {target // 1024}K', flush=True)
            p.compose('up', '-d', '--no-deps', '--pull', 'never', 'everyday')
            p.wait_health(18081, 'qwen38-nighttime', seconds=180)
            p.runtime_identity()
            loaded = target
            preserve_other_services()
            return catalog

        def probe(target, mode='allocation'):
            nonlocal loaded
            directory = backup / f'{target}-{mode}'
            directory.mkdir(mode=0o700, exist_ok=True)
            result = {'context': target, 'mode': mode, 'started_at': p.now()}
            samples, failures, stop = [], [], threading.Event()
            watcher = None
            try:
                catalog = restart(target) if loaded != target else proposal(*baseline, target)[2]
                result['loaded_free_mib'] = {g['uuid']: g['free_mib'] for g in c.memory(p, ids)}
                if mode != 'allocation':
                    def observe():
                        while not stop.is_set():
                            try:
                                samples.append({'utc': p.now(), 'gpus': c.memory(p, ids)})
                            except Exception as exc:
                                failures.append(str(exc))
                            stop.wait(1)
                    watcher = threading.Thread(target=observe, daemon=True)
                    watcher.start()
                    if mode == 'final':
                        result['checks'] = c.qualify(p, directory, catalog)
                    else:
                        body, expected, count = c.long_request(p, target)
                        choice = c.complete(p, directory, 'long-context', body, c.BACKEND)
                        if choice['finish_reason'] != 'stop' or c.parsed_json(choice['message']['content']) != expected:
                            raise RuntimeError('Long-context retrieval did not return all three keys naturally')
                        result['checks'] = {'formatted_input_tokens': count, 'natural_three_key_retrieval': True}
                    stop.set()
                    watcher.join(timeout=10)
                    if failures or not samples or any(len(s['gpus']) != 2 for s in samples):
                        raise RuntimeError('Incomplete GPU memory observation')
                    result['minimum_free_mib'] = {gpu: min(g['free_mib'] for s in samples for g in s['gpus'] if g['uuid'] == gpu) for gpu in ids}
                    result['reserve_passed'] = min(result['minimum_free_mib'].values()) >= floor
                result['ok'] = True
            except Exception as exc:
                # A failed probe is ours; its process/slot may no longer be
                # responsive. The next restart still checks router admission.
                loaded = None
                result.update(ok=False, error=str(exc))
                logs = subprocess.run(['docker', 'logs', '--tail', '300', 'qwen38-nighttime'], capture_output=True, text=True)
                (directory / 'backend-failure.log').write_text(logs.stdout + logs.stderr)
            finally:
                stop.set()
                if watcher is not None:
                    watcher.join(timeout=10)
                if samples or failures:
                    p.write(directory / 'memory.json', {'samples': samples, 'errors': failures})
                result['completed_at'] = p.now()
                results.append(result)
                p.write(directory / 'result.json', result)
                p.write(backup / 'progress.json', results)
                print('PROBE ' + json.dumps(result), flush=True)
            return result

        def restore_baseline():
            print('Restoring qualified 64K Nighttime baseline', flush=True)
            for name in names:
                shutil.copy2(backup / 'before' / name, PRIMARY / name)
            p.compose('up', '-d', '--no-deps', '--pull', 'never', 'everyday')
            p.wait_health(18081, 'qwen38-nighttime')
            p.write(p.MARKER, p.read(backup / 'active-model-before.json'))
            c.publish_nighttime(p, baseline[2])
            p.write(PRIMARY / 'evidence/live-identity.json', p.runtime_identity())
            preserve_other_services()
            p.write(backup / 'rollback.json', {'completed_at': p.now(), 'context': 65536})

        try:
            if accept_context is not None:
                final = probe(accept_context, 'final')
                if not final['ok']:
                    raise RuntimeError('Owner-selected 128K failed functional acceptance')
                preserve_other_services()
                before_marker, after_marker = p.read(backup / 'active-model-before.json'), p.read(p.MARKER)
                for marker in [before_marker, after_marker]:
                    marker['models'] = [r for r in marker['models'] if r['model'] != c.MODEL]
                if before_marker != after_marker:
                    raise RuntimeError('Daytime discovery projection changed')
                receipt = {'completed_at': p.now(), 'source_revision': revision, 'source_directory': str(SOURCE),
                    'final_context': accept_context, 'selection': 'Owner explicitly accepted 128K and ended the ceiling search',
                    'previous_reserve_mib': floor, 'previous_reserve_passed': final['reserve_passed'],
                    'minimum_free_mib': final['minimum_free_mib'], 'checks': final['checks'],
                    'daytime_and_router_unchanged': True, 'manifest_sha256': c.digest(p.MANIFEST)}
                p.write(backup / 'qualification.json', receipt)
                qualified.update(manifest_sha256=c.digest(p.MANIFEST), nighttime_context_selection={
                    'receipt': str(backup / 'qualification.json'), 'completed_at': receipt['completed_at']})
                p.write(PRIMARY / 'evidence/qualified.json', qualified)
                p.write(PRIMARY / 'evidence/live-identity.json', p.runtime_identity())
                print('ACCEPTED CONTEXT ' + json.dumps(receipt), flush=True)
                return
            # First locate the allocation boundary without spending generation
            # time on every point. Then test the upper end under long prefill.
            lower, upper = 65536, None
            for target in range(98304, LIMIT + 1, 32768):
                if probe(target)['ok']:
                    lower = target
                else:
                    upper = target
                    break
            if upper is not None:
                while upper - lower > STEP:
                    target = ((lower + upper) // (2 * STEP)) * STEP
                    if probe(target)['ok']:
                        lower = target
                    else:
                        upper = target
            allocation_ceiling = lower
            while lower >= 65536:
                physical = probe(lower, 'loaded')
                if physical['ok']:
                    break
                lower -= STEP
            else:
                raise RuntimeError('No context passed the loaded retrieval test')
            loaded_ceiling = lower
            # Interpolate from actual cold allocation slopes, then validate the
            # reserve under full tests and also check the adjacent 4K point.
            allocations = [r for r in results if r['mode'] == 'allocation' and r['ok']]
            allocations.sort(key=lambda r: r['context'])
            first, last = allocations[0], allocations[-1]
            predictions = []
            for gpu in ids:
                slope = (first['loaded_free_mib'][gpu] - last['loaded_free_mib'][gpu]) / (last['context'] - first['context'])
                if slope <= 0:
                    raise RuntimeError('Allocation memory slope is not usable')
                predictions.append(loaded_ceiling - max(0, floor - physical['minimum_free_mib'][gpu]) / slope)
            target = max(65536, min(loaded_ceiling, math.floor(min(predictions) / STEP) * STEP))
            final = probe(target, 'final')
            while not (final['ok'] and final['reserve_passed']) and target > 65536:
                target -= STEP
                final = probe(target, 'final')
            if not (final['ok'] and final['reserve_passed']):
                raise RuntimeError('No tested final configuration retained the VRAM reserve')
            best = target
            while best + STEP <= loaded_ceiling:
                adjacent = probe(best + STEP, 'loaded')
                if not (adjacent['ok'] and adjacent['reserve_passed']):
                    break
                best += STEP
            if best != target or loaded != best:
                final = probe(best, 'final')
            if not (final['ok'] and final['reserve_passed']):
                raise RuntimeError('Final acceptance failed')
            preserve_other_services()
            previous, current = p.read(backup / 'active-model-before.json'), p.read(p.MARKER)
            for marker in [previous, current]:
                marker['models'] = [r for r in marker['models'] if r['model'] != c.MODEL]
            if previous != current:
                raise RuntimeError('Daytime discovery projection changed')
            receipt = {'completed_at': p.now(), 'source_revision': revision, 'source_directory': str(SOURCE),
                'allocation_ceiling': allocation_ceiling, 'loaded_retrieval_ceiling': loaded_ceiling,
                'resolution_tokens': STEP, 'final_context': best, 'minimum_free_mib': final['minimum_free_mib'],
                'checks': final['checks'], 'daytime_and_router_unchanged': True, 'probes': results,
                'manifest_sha256': c.digest(p.MANIFEST)}
            p.write(backup / 'qualification.json', receipt)
            qualified.update(manifest_sha256=c.digest(p.MANIFEST), nighttime_ceiling_extension={
                'receipt': str(backup / 'qualification.json'), 'completed_at': receipt['completed_at']})
            p.write(PRIMARY / 'evidence/qualified.json', qualified)
            p.write(PRIMARY / 'evidence/live-identity.json', p.runtime_identity())
            print('CEILING RESULT ' + json.dumps({k:v for k,v in receipt.items() if k != 'probes'}), flush=True)
        except BaseException:
            restore_baseline()
            raise


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--accept-context', type=int, choices=[131072], help='Owner-selected 128K; report measured headroom instead of enforcing the former 1 GiB reserve')
    main(parser.parse_args().accept_context)
