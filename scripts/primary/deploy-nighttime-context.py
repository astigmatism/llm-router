#!/usr/bin/env python3
"""Qualify 64K on the existing Nighttime service, preserving Daytime and router.

Run only from a clean published release during an owner-approved Nighttime idle
window. No global drain, router restart, image build, or Daytime workload occurs.
Any failed acceptance restores this migration's immediate Nighttime predecessor.
"""
import argparse
import copy
import csv
import datetime
import fcntl
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import secrets
import shutil
import subprocess
import sys
import threading
import time
import urllib.error

sys.dont_write_bytecode = True
SOURCE = Path(__file__).resolve().parents[2]
PRIMARY = Path('/home/astigmatism/apps/local-ai-primary')
MODEL = 'qwen3.8-27b-abliterated-q6_k'
BACKEND = 'http://127.0.0.1:18081'
ROUTER = 'http://192.168.1.21:11434'
CONTEXT = 65536
BEFORE = {
    'manifest.json': '3760fa0748fcdb7f774c83839e10b3e92a255a81986f626a5d3ce17b3d2e8f1f',
    'compose.json': 'b23f29a3bd92e5b5435a2579769cd26aa1eb6f834cbfdd1feb7b28a959f337ca',
    'model-catalog.json': '4eeb0bbe0f144e0f0faabdc928e83b899cc4f7b8e51f55bb6f314eb637103774',
    'primary.py': 'ecb9f08c52a560a825e24e115e077577ca7f659bcaf259626e248e93f8134689',
}


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def proposal(manifest, compose, catalog):
    manifest, compose, catalog = copy.deepcopy((manifest, compose, catalog))
    night = next(s for s in manifest['services'] if s['role'] == 'everyday')
    cfg = compose['services']['everyday']
    if (night['model_alias'] != MODEL or cfg['container_name'] != 'qwen38-nighttime'
            or night['context_tokens'] != 32768 or night['parallel_slots'] != 1
            or cfg['command'] != night['recommended_argv']):
        raise ValueError('Nighttime differs from the reviewed single-slot 32K service')
    for flag in ['--ctx-size', '--kv-unified-per-slot']:
        argv = cfg['command']
        if argv.count(flag) != 1 or argv[argv.index(flag) + 1] != '32768':
            raise ValueError('Unexpected Nighttime capacity arguments')
        argv[argv.index(flag) + 1] = str(CONTEXT)
    night['recommended_argv'] = copy.deepcopy(cfg['command'])
    night['context_tokens'] = CONTEXT
    contract = night['qualification_contract']
    contract['runtime'] = contract['runtime'].replace('32768-token slot', '65536-token slot')
    contract['capacity']['allocated_context_tokens']['everyday'] = CONTEXT
    row = next(e for e in catalog['models'] if e['model'] == MODEL)
    row.update(context_length=CONTEXT, total_context_length=CONTEXT, display_name='Nighttime (64K)')
    return manifest, compose, catalog


def resident_snapshot(p, name):
    ci = p.inspect(name)
    return {k: ci[k] for k in ['Id', 'Image', 'Config', 'HostConfig', 'RestartCount']} | {
        'pid': ci['State']['Pid'], 'started_at': ci['State']['StartedAt']}


def cancelled_zero_output_slot(slot, task_id, logs):
    return (task_id is not None and slot.get('id_task') == task_id
            and slot.get('params', {}).get('n_predict') == 0
            and bool(slot.get('next_token'))
            and all(t.get('n_decoded') == 0 and t.get('has_next_token') is False for t in slot['next_token'])
            and f'cancel task, id_task = {task_id}\n' in logs)


def require_idle(p, cancelled_task=None):
    state = p.admin('runtime-state')['runtime']
    if state['draining']:
        raise RuntimeError('Another operation has drained the router')
    if (state.get('active_by_model', {}).get(MODEL, 0)
            or state.get('queued_by_model', {}).get(MODEL, 0)):
        raise RuntimeError('Nighttime is busy; no service has been stopped')
    for slot in p.http(BACKEND + '/slots'):
        if not slot.get('is_processing'):
            continue
        logs = ''
        if cancelled_task is not None:
            result = subprocess.run(['docker', 'logs', '--tail', '2000', 'qwen38-nighttime'],
                                    capture_output=True, text=True, check=True, timeout=30)
            logs = result.stdout + result.stderr
        if not cancelled_zero_output_slot(slot, cancelled_task, logs):
            raise RuntimeError('Nighttime is busy; no service has been stopped')
        print(f'Verified cancelled zero-output slot {cancelled_task}; no router work remains', flush=True)


def publish_nighttime(p, catalog):
    """Preserve the Daytime marker row and root projection byte-for-byte as data."""
    marker = p.read(p.MARKER)
    entry = copy.deepcopy(next(e for e in catalog['models'] if e['model'] == MODEL))
    ci = p.inspect('qwen38-nighttime')
    argv = ci['Config']['Cmd']
    for flag, value in [('--ctx-size', str(entry['context_length'])),
                        ('--n-predict', '-1'), ('--reasoning-budget', '-1'),
                        ('--reasoning-effort', 'default')]:
        if argv[argv.index(flag) + 1] != value:
            raise RuntimeError('Nighttime publication does not match running ' + flag)
    entry['runtime_output_policy'] = {
        'n_predict': -1, 'reasoning_budget': -1, 'reasoning_effort': 'default',
        'verification': 'docker-inspect-argv', 'verified_at': p.now(),
        'container_id': ci['Id'], 'started_at': ci['State']['StartedAt'],
        'argv_sha256': hashlib.sha256(json.dumps(argv).encode()).hexdigest()}
    entry['updated_at'] = p.now()
    entry['backend_revision'] = p.read(p.MANIFEST)['engine']['revision']
    marker['models'] = [entry if row['model'] == MODEL else row for row in marker['models']]
    p.write(p.MARKER, marker)
    p.admin('reload-config', {})


def memory(p, ids):
    raw = p.run('nvidia-smi', '--query-gpu=uuid,name,memory.used,memory.free', '--format=csv,noheader,nounits')
    return [{'uuid': row[0].strip(), 'name': row[1].strip(), 'used_mib': int(row[2]), 'free_mib': int(row[3])}
            for row in csv.reader(raw.splitlines()) if row[0].strip() in ids]


def token_count(p, body):
    prompt = p.http(BACKEND + '/apply-template', body)['prompt']
    return len(p.http(BACKEND + '/tokenize', {'content': prompt, 'add_special': False})['tokens'])


def long_request(p):
    expected = {name: secrets.token_hex(6) for name in ['ALPHA', 'BRAVO', 'CHARLIE']}
    filler = ''.join(f'Inventory record {i:04d}: copper bracket, shelf north, inspected and retained.\n' for i in range(160))
    def make(repeats):
        text = ('Read this synthetic inventory. Return only a JSON object with the exact values of '
                'ALPHA, BRAVO, and CHARLIE. The three KEY lines are authoritative.\n'
                + 'KEY ALPHA=' + expected['ALPHA'] + '\n' + filler * repeats
                + 'KEY BRAVO=' + expected['BRAVO'] + '\n' + filler * repeats
                + 'KEY CHARLIE=' + expected['CHARLIE'] + '\n'
                + 'Return the three key values as JSON. Do not summarize the inventory.')
        return {'model': MODEL, 'stream': False, 'temperature': 0,
                'messages': [{'role': 'user', 'content': text}]}
    unit = token_count(p, make(1))
    repeats = max(1, int(58500 / unit))
    body = make(repeats)
    count = token_count(p, body)
    if not 50000 < count < 62000:
        raise RuntimeError(f'Synthetic long-context fixture outside test range: {count}')
    return body, expected, count


def complete(p, evidence, name, body, endpoint):
    print('Starting ' + name, flush=True)
    start = time.monotonic()
    result = p.http(endpoint + '/v1/chat/completions', body, timeout=1200)
    receipt = {'request': body, 'response': result, 'seconds': round(time.monotonic() - start, 2)}
    p.write(evidence / (name + '.json'), receipt)
    choice = result['choices'][0]
    print(json.dumps({'test': name, 'seconds': receipt['seconds'], 'usage': result.get('usage'),
                      'finish_reason': choice['finish_reason']}), flush=True)
    return choice


def parsed_json(content):
    content = content.strip()
    if content.startswith('```'):
        content = content.split('\n', 1)[1].rsplit('```', 1)[0].strip()
    return json.loads(content)


def qualify(p, evidence, catalog):
    body, expected, count = long_request(p)
    choice = complete(p, evidence, 'backend-long-context', body, BACKEND)
    if choice['finish_reason'] != 'stop' or parsed_json(choice['message']['content']) != expected:
        raise RuntimeError('Long-context retrieval did not finish naturally with all three correct keys')
    if p.http(BACKEND + '/props')['modalities']['vision'] is not True:
        raise RuntimeError('Existing Nighttime vision capability was lost')
    p.write(PRIMARY / 'model-catalog.json', catalog)
    publish_nighttime(p, catalog)
    entries = p.http(ROUTER + '/v1/models')['data']
    live = next(row for row in entries if row['id'] == MODEL)['x_ollama_router']
    if live['context_window'] != CONTEXT or live['max_output_tokens'] is not None:
        raise RuntimeError('Router did not publish unrestricted 64K Nighttime')
    choice = complete(p, evidence, 'router-long-context', body, ROUTER)
    if choice['finish_reason'] != 'stop' or parsed_json(choice['message']['content']) != expected:
        raise RuntimeError('Router long-context retrieval failed')
    tools = [{'type': 'function', 'function': {'name': 'lookup_inventory', 'description': 'Find a synthetic inventory item.',
        'parameters': {'type': 'object', 'properties': {'item': {'type': 'string'}}, 'required': ['item']}}}]
    request = {'model': MODEL, 'stream': False, 'temperature': 0, 'tools': tools,
        'messages': [{'role': 'user', 'content': 'Use lookup_inventory to find item amber-42. After the tool replies, report its exact location in one sentence.'}]}
    choice = complete(p, evidence, 'router-tool-call', request, ROUTER)
    calls = choice['message'].get('tool_calls', [])
    if (choice['finish_reason'] != 'tool_calls' or len(calls) != 1
            or calls[0]['function']['name'] != 'lookup_inventory'
            or json.loads(calls[0]['function']['arguments']) != {'item': 'amber-42'}):
        raise RuntimeError('Nighttime tool handoff failed')
    request['messages'].extend([choice['message'], {'role': 'tool', 'tool_call_id': calls[0]['id'],
        'content': '{"item":"amber-42","location":"vault-C19"}'}])
    choice = complete(p, evidence, 'router-tool-result', request, ROUTER)
    if choice['finish_reason'] != 'stop' or 'vault-C19' not in choice['message']['content']:
        raise RuntimeError('Nighttime tool-result continuation failed')
    oversized = copy.deepcopy(body)
    oversized['messages'][0]['content'] *= 2
    try:
        p.http(ROUTER + '/v1/chat/completions', oversized, timeout=60)
    except urllib.error.HTTPError as exc:
        rejection = json.load(exc)
        p.write(evidence / 'overflow-rejection.json', {'status': exc.code, 'response': rejection})
        if exc.code != 400 or rejection.get('error', {}).get('code') != 'context_length_exceeded':
            raise RuntimeError('Unexpected oversized-context rejection')
    else:
        raise RuntimeError('Router admitted a prompt larger than the context')
    choice = complete(p, evidence, 'router-after-overflow', {'model': MODEL, 'stream': False,
        'messages': [{'role': 'user', 'content': 'Reply with exactly: READY'}]}, ROUTER)
    if choice['finish_reason'] != 'stop' or choice['message']['content'].strip() != 'READY':
        raise RuntimeError('Recovery after oversized-context rejection failed')
    return {'formatted_long_input_tokens': count, 'context': CONTEXT, 'natural_completion': True,
        'three_key_retrieval_backend_and_router': True, 'tool_round_trip': True,
        'overflow_rejection_and_next_request': True, 'vision_projector_still_loaded': True,
        'harness_compaction_recovery_tested': False, 'matched_performance_benchmark': False}


def main(cancelled_task=None):
    revision = subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=SOURCE, text=True).strip()
    if subprocess.check_output(['git', 'status', '--porcelain'], cwd=SOURCE, text=True).strip():
        raise RuntimeError('Deploy from a clean published checkout')
    spec = importlib.util.spec_from_file_location('context_primary', SOURCE / 'scripts/primary/primary.py')
    p = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(p)
    p.ROOT, p.MANIFEST = PRIMARY, PRIMARY / 'manifest.json'
    with (p.HOME_DIR / '.local-ai-profile-switch.lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        for name, expected in BEFORE.items():
            if digest(PRIMARY / name) != expected:
                raise RuntimeError(name + ' changed since review')
        qualified = p.read(PRIMARY / 'evidence/qualified.json')
        if qualified['manifest_sha256'] != digest(p.MANIFEST):
            raise RuntimeError('Existing manifest is not qualified')
        p.validate()
        p.runtime_identity()
        require_idle(p, cancelled_task)
        day = resident_snapshot(p, 'qwen38-daytime')
        router = resident_snapshot(p, 'local-ai-ollama-router')
        old_m, old_c, old_catalog = [p.read(PRIMARY / name) for name in ['manifest.json', 'compose.json', 'model-catalog.json']]
        manifest, compose, catalog = proposal(old_m, old_c, old_catalog)
        if catalog != p.read(SOURCE / 'runtime/primary-model-catalog.json'):
            raise RuntimeError('Source catalog includes changes beyond Nighttime capacity')
        backup = PRIMARY / 'corrections' / ('nighttime-context-' + datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ'))
        backup.mkdir(parents=True, mode=0o700)
        names = [*BEFORE, 'evidence/qualified.json', 'evidence/live-identity.json']
        for name in names:
            (backup / 'before' / name).parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(PRIMARY / name, backup / 'before' / name)
        shutil.copy2(p.MARKER, backup / 'active-model-before.json')
        p.write(backup / 'residents-before.json', {'daytime': day, 'router': router})
        ids = next(s for s in manifest['services'] if s['role'] == 'everyday')['container_contract']['gpu_device_ids']
        samples, errors, stop = [], [], threading.Event()
        def observe():
            while not stop.is_set():
                try:
                    samples.append({'utc': p.now(), 'gpus': memory(p, ids)})
                except Exception as exc:
                    errors.append(str(exc))
                stop.wait(2)
        watcher = threading.Thread(target=observe, daemon=True)
        changed = False
        try:
            require_idle(p, cancelled_task)
            changed = True
            p.write(PRIMARY / 'manifest.json', manifest)
            p.write(PRIMARY / 'compose.json', compose)
            shutil.copy2(SOURCE / 'scripts/primary/primary.py', PRIMARY / 'primary.py.tmp')
            os.replace(PRIMARY / 'primary.py.tmp', PRIMARY / 'primary.py')
            p.validate()
            watcher.start()
            print('Recreating only Nighttime at 64K; evidence: ' + str(backup), flush=True)
            p.compose('up', '-d', '--no-deps', '--pull', 'never', 'everyday')
            p.wait_health(18081, 'qwen38-nighttime')
            p.runtime_identity()
            checks = qualify(p, backup, catalog)
            stop.set()
            watcher.join(timeout=10)
            p.write(backup / 'memory.json', {'samples': samples, 'errors': errors})
            if errors or not samples or any(len(s['gpus']) != 2 for s in samples):
                raise RuntimeError('GPU memory observations were incomplete')
            minimum = {gpu: min(g['free_mib'] for s in samples for g in s['gpus'] if g['uuid'] == gpu) for gpu in ids}
            if min(minimum.values()) < manifest['minimum_free_vram_mib_per_gpu']:
                raise RuntimeError('Nighttime fell below the qualified GPU headroom minimum')
            if day != resident_snapshot(p, 'qwen38-daytime') or router != resident_snapshot(p, 'local-ai-ollama-router'):
                raise RuntimeError('Daytime or router container changed during the trial')
            before_marker = p.read(backup / 'active-model-before.json')
            after_marker = p.read(p.MARKER)
            for value in [before_marker, after_marker]:
                value['models'] = [r for r in value['models'] if r['model'] != MODEL]
            if before_marker != after_marker:
                raise RuntimeError('Daytime marker or root projection changed')
            identity = p.runtime_identity()
            receipt = {'completed_at': p.now(), 'source_revision': revision, 'source_directory': str(SOURCE),
                'checks': checks, 'minimum_free_vram_mib': minimum, 'daytime_and_router_unchanged': True,
                'cancelled_zero_output_slot_recovered': cancelled_task,
                'manifest_sha256': digest(p.MANIFEST), 'identity': identity}
            p.write(backup / 'qualification.json', receipt)
            qualified.update(manifest_sha256=digest(p.MANIFEST), nighttime_context_extension={
                'receipt': str(backup / 'qualification.json'), 'completed_at': receipt['completed_at']})
            p.write(PRIMARY / 'evidence/qualified.json', qualified)
            p.write(PRIMARY / 'evidence/live-identity.json', identity)
            print('64K Nighttime passed: ' + json.dumps(receipt), flush=True)
        except BaseException:
            stop.set()
            if watcher.is_alive():
                watcher.join(timeout=10)
            p.write(backup / 'memory.json', {'samples': samples, 'errors': errors})
            if changed:
                print('Restoring the immediately preceding 32K Nighttime configuration', flush=True)
                for name in names:
                    shutil.copy2(backup / 'before' / name, PRIMARY / name)
                p.compose('up', '-d', '--no-deps', '--pull', 'never', 'everyday')
                p.wait_health(18081, 'qwen38-nighttime')
                p.write(p.MARKER, p.read(backup / 'active-model-before.json'))
                publish_nighttime(p, old_catalog)
                p.write(PRIMARY / 'evidence/live-identity.json', p.runtime_identity())
                if day != resident_snapshot(p, 'qwen38-daytime') or router != resident_snapshot(p, 'local-ai-ollama-router'):
                    raise RuntimeError('Daytime or router changed externally during rollback')
                p.write(backup / 'rollback.json', {'completed_at': p.now(), 'context': 32768})
            raise


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--recover-cancelled-slot', type=int, help='Explicitly reviewed stale task ID; requires cancellation in backend logs, zero output, and no router work')
    main(parser.parse_args().recover_cancelled_slot)
