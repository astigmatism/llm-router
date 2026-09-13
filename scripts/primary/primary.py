#!/usr/bin/env python3
"""Own the two primary backends; preserve the existing router's coding alias."""
import contextlib
import datetime
import fcntl
import hashlib
import json
import os
from pathlib import Path
import shlex
import shutil
import subprocess
import sys
import time
import urllib.request
import urllib.parse

ROOT = Path(__file__).resolve().parent
HOME_DIR = Path('/home/astigmatism')
STACK = HOME_DIR / 'apps/local-ai-ollama-stack'
MARKER = STACK / 'runtime/router/active-model.json'
STATE = HOME_DIR / '.local-ai-selected-profile.json'
BACKUP = ROOT / 'rollback'
NAMES = ['qwen38-daytime', 'qwen38-nighttime']
OLD = 'local-ai-llama-cpp'
UNIT = 'local-ai-primary.service'
MANIFEST = ROOT / 'manifest.json'

def read(p):
    return json.loads(Path(p).read_text())

def now():
    return datetime.datetime.now(datetime.timezone.utc).isoformat()

def write(p, obj):
    p = Path(p)
    tmp = p.with_name(p.name + '.tmp')
    tmp.write_text(json.dumps(obj, indent=2) + '\n')
    os.replace(tmp, p)

def run(*args, check=True, timeout=900):
    r = subprocess.run(list(args), text=True, capture_output=True, timeout=timeout)
    if check and r.returncode:
        raise RuntimeError(f'{args[0]} {args[1:3]} failed: {r.stderr[-2500:]}')
    return r.stdout.strip()

def docker(*args, **kw):
    return run('docker', *args, **kw)

def inspect(name):
    raw = docker('inspect', name, check=False)
    return json.loads(raw)[0] if raw and raw != '[]' else None

def http(url, body=None, headers=None, timeout=30):
    req = urllib.request.Request(url, data=None if body is None else json.dumps(body).encode(),
        headers={'Content-Type': 'application/json', **(headers or {})})
    with urllib.request.urlopen(req, timeout=timeout) as response:
        return json.load(response)

def admin(path, body=None):
    env = {}
    for line in (STACK / '.env').read_text().splitlines():
        if line.strip() and not line.lstrip().startswith('#') and '=' in line:
            k, v = line.split('=', 1)
            parts = shlex.split(v, comments=True)
            env[k.strip()] = parts[0] if parts else ''
    return http('http://' + env.get('ROUTER_BIND_IP', '192.168.1.21') + ':' +
        env.get('ADMIN_PUBLIC_PORT', '11435') + '/admin/api/' + path, body,
        {env.get('ADMIN_SESSION_HEADER', 'X-Admin-Token'): env['ADMIN_TOKEN']})

def drain(enabled):
    return admin('runtime-drain', {'enabled': enabled, 'reason': 'primary runtime maintenance' if enabled else 'primary ready'})

def wait_idle():
    deadline = time.monotonic() + 300
    while time.monotonic() < deadline:
        s = admin('runtime-state')['runtime']
        if s['active_count'] == 0 and s.get('queued_count', 0) == 0:
            return
        time.sleep(2)
    raise RuntimeError('Active requests did not finish; no backend has been stopped')

def wait_health(port, name, seconds=420):
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        ci = inspect(name)
        if not ci or not ci['State']['Running']:
            raise RuntimeError(f'{name} exited: ' + docker('logs', '--tail', '20', name, check=False))
        try:
            if http(f'http://127.0.0.1:{port}/health', timeout=3).get('status') == 'ok':
                return
        except Exception:
            pass
        time.sleep(2)
    raise RuntimeError(name + ' readiness timeout')

def compose(*args):
    return docker('compose', '-f', str(ROOT / 'compose.json'), *args)

def validate():
    m = read(MANIFEST)
    spec = read(ROOT / 'compose.json')['services']
    receipts = {x['path']: x for x in read(ROOT / 'evidence/artifacts.json')}
    gpu_ids = []
    for s in m['services']:
        cfg = spec[s['role']]
        contract = s['container_contract']
        if cfg['command'] != s['recommended_argv'] or cfg['deploy']['resources']['reservations']['devices'][0]['device_ids'] != contract['gpu_device_ids']:
            raise RuntimeError(s['role'] + ' compose differs from qualified argument/GPU manifest')
        if {(x['source'], x['target']) for x in cfg['volumes']} != {(x['source'], x['target']) for x in contract['read_only_mounts']}:
            raise RuntimeError(s['role'] + ' compose differs from artifact manifest')
        gpu_ids += s['container_contract']['gpu_device_ids']
        for mount in s['container_contract']['read_only_mounts']:
            p = Path(mount['source'])
            expected = next(x for x in m['models'] if x['persistent_path'] == str(p))
            receipt = receipts.get(str(p), {})
            if not p.is_file() or p.stat().st_size != expected['bytes'] or receipt.get('sha256') != expected['sha256'] or not receipt.get('ok'):
                raise RuntimeError('Artifact validation failed: ' + str(p))
    if len(gpu_ids) != 4 or len(set(gpu_ids)) != 4:
        raise RuntimeError('Primary services must own four distinct GPUs')
    available = docker('info', '--format', '{{.ServerVersion}}')
    if not available:
        raise RuntimeError('Docker unavailable')
    expected_image = read(ROOT / 'evidence/engine.json')['image_id']
    actual_image = json.loads(docker('image', 'inspect', m['engine']['proposed_persistent_image_tag']))[0]
    if actual_image['Id'] != expected_image or actual_image['Config']['Labels'].get('org.opencontainers.image.revision') != m['engine']['revision']:
        raise RuntimeError('Pinned engine identity mismatch')
    compose('config', '--quiet')
    return {'ok': True, 'image_id': expected_image, 'artifacts': 4, 'gpu_ids': gpu_ids}

def configured_context(role, cfg=None):
    cfg = cfg or read(ROOT / 'compose.json')['services'][role]
    service = next(s for s in read(MANIFEST)['services'] if s['role'] == role)
    expected = service['context_tokens']
    argv = cfg['command']
    for flag, value in [('--ctx-size', expected), ('--kv-unified-per-slot', expected), ('--parallel', 1)]:
        if argv.count(flag) != 1 or argv.index(flag) + 1 >= len(argv) or argv[argv.index(flag) + 1] != str(value):
            raise RuntimeError(role + ' declared context/slot arguments differ from manifest')
    if type(expected) is not int or expected <= 0 or service['parallel_slots'] != 1:
        raise RuntimeError(role + ' invalid context/slot manifest')
    return expected


def service_label(role):
    service = next(s for s in read(MANIFEST)['services'] if s['role'] == role)
    return ('Daytime' if role == 'coding' else 'Nighttime') + f" ({service['context_tokens'] // 1024}K)"


def runtime_identity():
    spec = read(ROOT / 'compose.json')['services']
    image_id = read(ROOT / 'evidence/engine.json')['image_id']
    results = {}
    for role, cfg in spec.items():
        ci = inspect(cfg['container_name'])
        if not ci or not ci['State']['Running']:
            raise RuntimeError(role + ' is not running')
        requests = ci['HostConfig']['DeviceRequests']
        mounts = {(x['Source'], x['Destination'], x['RW']) for x in ci['Mounts'] if x['Type'] == 'bind'}
        expected_mounts = {(x['source'], x['target'], False) for x in cfg['volumes']}
        if ci['Image'] != image_id or ci['Config']['Cmd'] != cfg['command']:
            raise RuntimeError(role + ' image/argument drift')
        if len(requests) != 1 or requests[0]['DeviceIDs'] != cfg['deploy']['resources']['reservations']['devices'][0]['device_ids']:
            raise RuntimeError(role + ' GPU assignment drift')
        if mounts != expected_mounts or not ci['HostConfig']['ReadonlyRootfs']:
            raise RuntimeError(role + ' mount drift')
        port = 18080 if role == 'coding' else 18081
        bindings = ci['HostConfig']['PortBindings'].get('8080/tcp')
        if bindings != [{'HostIp': '127.0.0.1', 'HostPort': str(port)}]:
            raise RuntimeError(role + ' host binding drift')
        slots = http(f'http://127.0.0.1:{port}/slots')
        expected_ctx = configured_context(role, cfg)
        if len(slots) != 1 or slots[0]['n_ctx'] != expected_ctx:
            raise RuntimeError(role + ' context or slot drift')
        results[role] = {'container_id': ci['Id'], 'pid': ci['State']['Pid'], 'image_id': ci['Image'],
            'restart_policy': ci['HostConfig']['RestartPolicy']['Name'], 'restart_count': ci['RestartCount'],
            'port': port, 'context': expected_ctx, 'slots': len(slots), 'gpu_device_ids': requests[0]['DeviceIDs']}
    if inspect(OLD) and inspect(OLD)['State']['Running']:
        raise RuntimeError('Legacy backend is running alongside primary')
    return results

def publish_marker():
    m = read(MANIFEST)
    catalog = read(ROOT / 'model-catalog.json')
    services = read(ROOT / 'compose.json')['services']
    for entry in catalog['models']:
        policy = entry.get('reasoning_policy', {})
        if (entry.get('output_policy') != 'unrestricted'
            or entry.get('default_output_tokens') is not None
            or entry.get('max_output_tokens') is not None
            or entry.get('server_default_output_tokens') != -1
            or policy.get('schema_version') != 2
            or policy.get('default_level') != 'default'
            or any(level.get('default_output_tokens') is not None
                or level.get('max_output_tokens') is not None
                or (level.get('enabled') and level.get('reasoning_budget_tokens') != -1)
                for level in policy.get('levels', {}).values())):
            raise RuntimeError('Refusing to publish inherited output/thinking limits for ' + entry['model'])
        service = next((service for service in m['services']
            if entry['model'] in (service['model_alias'], service.get('fallback', {}).get('model_alias'))), None)
        if service is None:
            raise RuntimeError('Catalog model is absent from primary manifest: ' + entry['model'])
        name = service['container_name']
        # A compatibility DNS alias is not a Docker container name. Resolve the
        # actual container through its model identity, and constrain the URL to
        # that same service's declared network names before attesting its argv.
        allowed_hosts = {name, service['role'], *services[service['role']]['networks']['router'].get('aliases', [])}
        if urllib.parse.urlparse(entry['backend_url']).hostname not in allowed_hosts:
            raise RuntimeError('Backend URL is not a declared alias of ' + name)
        running = inspect(name)
        argv = running['Config']['Cmd']
        for flag, expected in [('--n-predict', '-1'), ('--reasoning-budget', '-1'), ('--reasoning-effort', 'default'), ('--alias', entry['model'])]:
            if flag not in argv or argv[argv.index(flag) + 1] != expected:
                raise RuntimeError('Running backend policy differs: ' + name + ' ' + flag)
        entry['runtime_output_policy'] = {
            'n_predict': -1, 'reasoning_budget': -1, 'reasoning_effort': 'default',
            'verification': 'docker-inspect-argv', 'verified_at': now(),
            'container_id': running['Id'], 'started_at': running['State']['StartedAt'],
            'argv_sha256': hashlib.sha256(json.dumps(argv).encode()).hexdigest()
        }
    # The root coding projection is derived from the same authoritative row.
    coding = next(entry for entry in catalog['models'] if entry['model'] == catalog['default_model'])
    catalog.update(coding)
    catalog['updated_at'] = now()
    catalog['source'] = 'local-ai-primary/primary.py'
    for entry in catalog['models']:
        entry['updated_at'] = catalog['updated_at']
        entry['backend_revision'] = m['engine']['revision']
    write(MARKER, catalog)
    admin('reload-config', {})
    state = admin('runtime-state')
    entries = state.get('models', [])
    if (state['active_model']['profile'] != 'primary'
        or {entry['id'] for entry in entries} != {entry['model'] for entry in catalog['models']}
        or not all(entry['x_ollama_router']['health']['available'] for entry in entries)):
        raise RuntimeError('Router resident catalog/readiness verification failed')
    if not all(entry['x_ollama_router'].get('output_policy') == 'unrestricted'
        and entry['x_ollama_router'].get('default_output_tokens') is None
        and entry['x_ollama_router'].get('max_output_tokens') is None for entry in entries):
        raise RuntimeError('Router discovery restored an inherited output quota')


def install_entrypoints():
    for name in ['primary', 'daytime', 'nighttime', 'daytime-256', 'nighttime-256']:
        path = HOME_DIR / name
        path.write_text('#!/usr/bin/env bash\nset -euo pipefail\nif (( $# == 0 )); then set -- apply; fi\nexec /home/astigmatism/apps/local-ai-primary/primary.py "$@"\n')
        path.chmod(0o755)
    shutil.copy2(ROOT / 'manager.sh', HOME_DIR / 'local-ai-config.sh')
    registry = read(BACKUP / 'files/local-ai-configs.json')
    retired = {k: v for k, v in registry['configurations'].items() if k.startswith(('daytime-', 'nighttime-'))}
    registry['retired_configurations'] = retired
    registry['configurations'] = {k: v for k, v in registry['configurations'].items() if k not in retired}
    if 'brains' in registry['configurations']:
        registry['configurations']['brains']['availability'] = 'historical profile; automatic restoration retired'
    registry['configurations']['primary'] = {
        'description': f"Resident {service_label('coding')} and {service_label('everyday')}; one slot each",
        'controller': str(ROOT / 'primary.py'), 'manifest': str(MANIFEST), 'boot_default': True,
        'services': ['coding', 'everyday']}
    write(HOME_DIR / 'local-ai-configs.json', registry)
    unit_path = HOME_DIR / '.config/systemd/user' / UNIT
    shutil.copy2(ROOT / UNIT, unit_path)
    run('systemctl', '--user', 'daemon-reload')
    run('systemctl', '--user', 'enable', UNIT)

def reject_historical_restore(action):
    raise RuntimeError(
        f"Historical '{action}' is retired: it can restore capped preconversion "
        "settings and overwrite the current router. Use 'primary apply' to "
        "ensure the qualified primary pair is running. Historical backups "
        "are retained as evidence, not an active recovery profile.")


def rollback():
    reject_historical_restore('rollback')


def start_pair():
    docker('stop', '-t', '30', OLD)
    compose('up', '-d', 'coding', 'everyday')
    wait_health(18080, NAMES[0])
    wait_health(18081, NAMES[1])
    return runtime_identity()

def apply(deploy=False):
    if deploy:
        reject_historical_restore('deploy')
    if not (ROOT / 'evidence/qualified.json').exists():
        raise RuntimeError('Primary qualification has not completed')
    if read(ROOT / 'evidence/qualified.json').get('manifest_sha256') != hashlib.sha256(MANIFEST.read_bytes()).hexdigest():
        raise RuntimeError('Primary manifest changed since qualification')
    validate()
    try:
        live = runtime_identity()
        s = admin('runtime-state')
        if read(STATE)['selected_profile'] == 'primary' and s['active_model']['profile'] == 'primary' and not s['runtime']['draining'] and s['backend']['health']['ok'] and read(MARKER).get('schema_version') == 3 and len(s.get('models', [])) == 2:
            print('primary is already healthy', flush=True)
            return
    except Exception:
        pass
    drain(True)
    try:
        wait_idle()
    except Exception:
        drain(False)
        raise
    try:
        start_pair()
        publish_marker()
        write(STATE, {'schema_version': 1, 'selected_profile': 'primary', 'updated_at': now()})
        write(ROOT / 'evidence/live-identity.json', runtime_identity())
        drain(False)
        print(f"primary ready: {service_label('coding')} + {service_label('everyday')}", flush=True)
    except BaseException:
        print('Primary startup failed; router remains drained for the next supervised retry', flush=True)
        raise


def status():
    result = {'selected': read(STATE), 'services': {}, 'boot_enabled': run('systemctl', '--user', 'is-enabled', UNIT, check=False)}
    for role, port, name in [('coding', 18080, NAMES[0]), ('everyday', 18081, NAMES[1])]:
        ci = inspect(name)
        result['services'][role] = {'running': bool(ci and ci['State']['Running']), 'port': port,
            'container_name': name, 'display_name': service_label(role)}
        with contextlib.suppress(Exception):
            result['services'][role]['health'] = http(f'http://127.0.0.1:{port}/health')
    with contextlib.suppress(Exception):
        result['router'] = admin('runtime-state')
    return result

def main():
    os.environ.setdefault('XDG_RUNTIME_DIR', '/run/user/1000')
    action = sys.argv[1] if len(sys.argv) > 1 else 'apply'
    if action == 'status':
        print(json.dumps(status(), indent=2)); return
    if action in ('plan', 'show'):
        print(MANIFEST.read_text()); return
    if action in ('deploy', 'rollback'):
        reject_historical_restore(action)
    with (HOME_DIR / '.local-ai-profile-switch.lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        if action == 'validate':
            print(json.dumps(validate(), indent=2))
        elif action == 'active-check':
            print(json.dumps(runtime_identity(), indent=2))
        elif action == 'apply':
            apply()
        else:
            raise SystemExit('Usage: primary [apply|status|validate|plan|show|active-check]')

if __name__ == '__main__':
    main()
