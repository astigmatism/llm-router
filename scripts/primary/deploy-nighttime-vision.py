#!/usr/bin/env python3
"""Deploy the omitted pinned Nighttime projector from a clean published release.

This is a separate, narrowly scoped inference migration, not a router-only update.
The existing service configuration is preserved except for the CPU projector.
"""
import base64
import copy
import datetime
import fcntl
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import shutil
import struct
import subprocess
import sys
import time
import urllib.request
import zlib

sys.dont_write_bytecode = True
SOURCE = Path(__file__).resolve().parents[2]
PRIMARY = Path('/home/astigmatism/apps/local-ai-primary')
MODEL = 'qwen3.8-27b-abliterated-q6_k'
REVISION = 'efb07baa690a1bc7beb53ee067b4b57c7025b5e7'
REPOSITORY = 'windowsxp811203/Qwen3.8-27B-Abliterated-GGUF'
FILENAME = 'mmproj-Qwen3.8-27B-Abliterated-F16.gguf'
ARTIFACT = {
    'file': FILENAME, 'repository': REPOSITORY, 'revision': REVISION,
    'bytes': 927607328,
    'sha256': 'b73b89b52c21e90468f0c61d1190cb22c3f229f9ddd2792e9eafd55302fabdd4',
    'persistent_path': f'/home/astigmatism/ai/models/llm/{REPOSITORY}/revisions/{REVISION}/{FILENAME}',
    'download_url': f'https://huggingface.co/{REPOSITORY}/resolve/{REVISION}/{FILENAME}',
    'deployment_role': 'nighttime_vision_projector_cpu',
}
PROJECTOR_ARGS = ['--mmproj', '/weights/projector.gguf', '--no-mmproj-offload', '--mmproj-device', 'none']
REVIEWED_BEFORE = {
    'manifest.json': '32423a6233f626339e0bcbd99667cd7fc9b273c0b7f7bea9c2719976c6402102',
    'compose.json': 'c56cb6ff4013bd09e93c8ae49caa4576150c7be429690c269dd1db3cfef69b05',
    'model-catalog.json': '943398e7e73cbb3130b62305c62676f28e43603ce8ae2f8ccf1ed11fe0d23beb',
}


def read(path):
    return json.loads(path.read_text())


def digest(path):
    result = hashlib.sha256()
    with path.open('rb') as source:
        for chunk in iter(lambda: source.read(8 * 1024 * 1024), b''):
            result.update(chunk)
    return result.hexdigest()


def now():
    return datetime.datetime.now(datetime.timezone.utc).isoformat()


def proposal(manifest, compose):
    manifest, compose = copy.deepcopy(manifest), copy.deepcopy(compose)
    service = next(s for s in manifest['services'] if s['role'] == 'everyday')
    cfg = compose['services']['everyday']
    if service['model_alias'] != MODEL or cfg['container_name'] != 'qwen38-nighttime':
        raise ValueError('This migration only applies to the reviewed Nighttime model')
    if cfg['command'] != service['recommended_argv'] or '--mmproj' in cfg['command']:
        raise ValueError('Nighttime arguments changed or already contain a projector')
    if service['recommended_model']['revision'] != REVISION:
        raise ValueError('Nighttime model revision differs from the matching projector')
    cfg['command'].extend(PROJECTOR_ARGS)
    mount = {'source': ARTIFACT['persistent_path'], 'target': '/weights/projector.gguf'}
    cfg['volumes'].append({'type': 'bind', **mount, 'read_only': True, 'bind': {'create_host_path': False}})
    service['recommended_argv'] = copy.deepcopy(cfg['command'])
    service['container_contract']['read_only_mounts'].append(mount)
    service['qualification_contract']['runtime'] = (
        'One 32768-token slot, all target transformer layers and KV on the assigned GPUs, '
        'q8_0 K/V, 60:40 split, no speculation; matching F16 vision projector on CPU.')
    service['vision_projector'] = {'path': ARTIFACT['persistent_path'], 'revision': REVISION, 'offload': 'cpu'}
    manifest['models'].append(copy.deepcopy(ARTIFACT))
    return manifest, compose


def image_fixture(reverse=False):
    """Three distinctly colored shapes; neither labels nor answers enter the prompt."""
    colors = {'red': (230, 20, 20), 'green': (0, 180, 0), 'blue': (20, 40, 240)}
    shapes = [('red', 'triangle'), ('green', 'square'), ('blue', 'circle')]
    if reverse:
        shapes = [('blue', 'square'), ('red', 'circle'), ('green', 'triangle')]
    width, height = 384, 160
    rows = []
    for y in range(height):
        row = bytearray([0])
        for x in range(width):
            color = (255, 255, 255)
            for i, (name, shape) in enumerate(shapes):
                dx, dy = x - (64 + i * 128), y - 80
                inside = ((abs(dx) <= 40 and abs(dy) <= 40) if shape == 'square'
                    else (dx * dx + dy * dy <= 42 * 42) if shape == 'circle'
                    else (-45 <= dy <= 40 and abs(dx) <= (dy + 45) * .5))
                if inside:
                    color = colors[name]
            row.extend(color)
        rows.append(row)
    def chunk(kind, data):
        return struct.pack('>I', len(data)) + kind + data + struct.pack('>I', zlib.crc32(kind + data) & 0xffffffff)
    png = (b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', width, height, 8, 2, 0, 0, 0))
           + chunk(b'IDAT', zlib.compress(b''.join(rows))) + chunk(b'IEND', b''))
    return base64.b64encode(png).decode(), [f'{color} {shape}' for color, shape in shapes]


def recognized_shapes(content):
    content = content.strip().lower()
    if content.startswith('```'):
        content = content.split('\n', 1)[1].rsplit('```', 1)[0].strip()
    value = json.loads(content)
    if not isinstance(value, list) or len(value) != 3:
        raise ValueError('Expected three ordered shape descriptions')
    # Both ["red triangle"] and [{"red": "triangle"}] describe the same image.
    # Evaluate visual content, not a formatting preference in the test prompt.
    return [' '.join(next(iter(item.items()))) if isinstance(item, dict) and len(item) == 1
            else item for item in value]


def verify_images(controller, evidence):
    props = controller.http('http://127.0.0.1:18081/props')
    if props['modalities']['vision'] is not True:
        raise RuntimeError('Nighttime did not load its vision projector')
    results = []
    for thinking in [False, True]:
        png, expected = image_fixture(reverse=thinking)
        body = {'model': MODEL, 'stream': False, 'temperature': 0,
            'n_predict': -1, **({'reasoning_effort': 'xhigh'} if thinking else {}),
            'chat_template_kwargs': {'enable_thinking': thinking},
            'messages': [{'role': 'user', 'content': [
                {'type': 'text', 'text': 'Identify the three shapes from left to right. Return only a JSON array of three strings, each containing its color and shape.'},
                {'type': 'image_url', 'image_url': {'url': 'data:image/png;base64,' + png}}]}]}
        started = time.monotonic()
        result = controller.http('http://127.0.0.1:18081/v1/chat/completions', body, timeout=300)
        controller.write(evidence / f'image-thinking-{thinking}.json', {'request': body, 'response': result})
        choice = result['choices'][0]
        content = choice['message']['content'].strip()
        if choice['finish_reason'] != 'stop' or recognized_shapes(content) != expected:
            raise RuntimeError('Nighttime image recognition failed; see private qualification output')
        results.append({'thinking': thinking, 'answer': content, 'seconds': round(time.monotonic() - started, 2),
                        'finish_reason': choice['finish_reason']})
        print('Passed image recognition:', results[-1], flush=True)
    return results


def download_projector():
    path = Path(ARTIFACT['persistent_path'])
    if not path.exists():
        partial = path.with_name(path.name + '.download-' + str(os.getpid()))
        try:
            with urllib.request.urlopen(ARTIFACT['download_url'], timeout=90) as response, partial.open('xb') as out:
                shutil.copyfileobj(response, out, length=8 * 1024 * 1024)
            if partial.stat().st_size != ARTIFACT['bytes'] or digest(partial) != ARTIFACT['sha256']:
                raise RuntimeError('Downloaded projector failed pinned size/SHA256 verification')
            os.replace(partial, path)
        finally:
            partial.unlink(missing_ok=True)
    if path.stat().st_size != ARTIFACT['bytes'] or digest(path) != ARTIFACT['sha256']:
        raise RuntimeError('Existing projector failed pinned size/SHA256 verification')
    return {'path': str(path), 'bytes': path.stat().st_size, 'sha256': ARTIFACT['sha256'], 'ok': True}


def main():
    if (PRIMARY / 'runtime-owner.json').exists():
        raise RuntimeError('Runtime settings are owned by local-ai-runtime; edit and deploy its profile definitions')
    revision = subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=SOURCE, text=True).strip()
    if subprocess.check_output(['git', 'status', '--porcelain'], cwd=SOURCE, text=True).strip():
        raise RuntimeError('Deploy from a clean, published Git release')
    if digest(PRIMARY / 'primary.py') != digest(SOURCE / 'scripts/primary/primary.py'):
        raise RuntimeError('Controller changed; review before deployment')
    spec = importlib.util.spec_from_file_location('nighttime_primary', PRIMARY / 'primary.py')
    p = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(p)
    with (p.HOME_DIR / '.local-ai-profile-switch.lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        for name, expected in REVIEWED_BEFORE.items():
            if digest(PRIMARY / name) != expected:
                raise RuntimeError(name + ' changed since review; inspect before migration')
        qualified = read(PRIMARY / 'evidence/qualified.json')
        if qualified['manifest_sha256'] != digest(PRIMARY / 'manifest.json'):
            raise RuntimeError('Existing manifest is not qualified')
        if p.admin('runtime-state')['runtime']['draining']:
            raise RuntimeError('Another maintenance operation has already drained the router')
        p.validate()
        before_identity = p.runtime_identity()
        manifest, compose = proposal(read(PRIMARY / 'manifest.json'), read(PRIMARY / 'compose.json'))
        catalog = read(SOURCE / 'runtime/primary-model-catalog.json')
        # The only catalog changes are the matching projector and vision declaration.
        expected_catalog = read(PRIMARY / 'model-catalog.json')
        night = next(e for e in expected_catalog['models'] if e['model'] == MODEL)
        night.update(mmproj_path=ARTIFACT['persistent_path'], mmproj_revision=REVISION,
                     mmproj_offload='cpu', input_modalities=['text', 'image'])
        night['capability_profile'].update(vision=True, name='qwen38-27b-abliterated-vision-tools-reasoning')
        if catalog != expected_catalog:
            raise RuntimeError('Catalog contains changes outside this vision migration')
        print('Downloading and verifying pinned projector before maintenance', flush=True)
        receipt = download_projector()
        backup = PRIMARY / 'corrections' / ('nighttime-vision-' + datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ'))
        backup.mkdir(parents=True, mode=0o700)
        names = ['manifest.json', 'compose.json', 'model-catalog.json', 'evidence/artifacts.json', 'evidence/qualified.json']
        for name in names:
            (backup / 'before' / name).parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(PRIMARY / name, backup / 'before' / name)
        shutil.copy2(p.MARKER, backup / 'active-model.json')
        p.write(backup / 'proposed-manifest.json', manifest)
        p.write(backup / 'proposed-compose.json', compose)
        subprocess.run(['docker', 'compose', '-f', str(backup / 'proposed-compose.json'), 'config', '--quiet'], check=True)
        # Recheck after the download; do not overwrite concurrent configuration work.
        for name, expected in REVIEWED_BEFORE.items():
            if digest(PRIMARY / name) != expected:
                raise RuntimeError(name + ' changed during preparation')
        p.drain(True)
        changed = False
        try:
            p.wait_idle()
            for port in [18080, 18081]:
                if any(s.get('is_processing') for s in p.http(f'http://127.0.0.1:{port}/slots')):
                    raise RuntimeError('A direct inference slot is busy; no service has been stopped')
            changed = True
            p.write(PRIMARY / 'manifest.json', manifest)
            p.write(PRIMARY / 'compose.json', compose)
            p.write(PRIMARY / 'evidence/artifacts.json', read(PRIMARY / 'evidence/artifacts.json') + [receipt])
            p.validate()
            print('Recreating Nighttime with the CPU projector; Daytime stays running', flush=True)
            p.compose('up', '-d', '--no-deps', 'everyday')
            p.wait_health(18081, 'qwen38-nighttime')
            identity = p.runtime_identity()
            if identity['coding']['container_id'] != before_identity['coding']['container_id']:
                raise RuntimeError('Daytime container changed during Nighttime-only migration')
            checks = verify_images(p, backup)
            p.write(PRIMARY / 'model-catalog.json', catalog)
            p.publish_marker()
            live = p.http('http://192.168.1.21:11434/api/show', {'model': 'nighttime'})
            if 'vision' not in live['capabilities']:
                raise RuntimeError('Router did not publish Nighttime vision')
            delta = {'source_revision': revision, 'completed_at': now(), 'projector': receipt,
                'before_manifest_sha256': REVIEWED_BEFORE['manifest.json'],
                'manifest_sha256': digest(PRIMARY / 'manifest.json'), 'images': checks,
                'runtime_identity': identity, 'prior_acceptance': str(backup / 'before/evidence/qualified.json'),
                'scope': 'Adds CPU image encoding; prior text/tool/context qualification retained. No new throughput or interference benchmark claimed.'}
            p.write(backup / 'qualification.json', delta)
            qualified['manifest_sha256'] = delta['manifest_sha256']
            qualified['vision_extension'] = {'receipt': str(backup / 'qualification.json'), 'completed_at': now()}
            p.write(PRIMARY / 'evidence/qualified.json', qualified)
            p.write(PRIMARY / 'evidence/live-identity.json', identity)
            p.drain(False)
            print('Nighttime vision deployed and qualified:', str(backup), flush=True)
        except BaseException:
            if changed:
                print('Qualification failed; restoring this migration’s immediately preceding configuration', flush=True)
                for name in names:
                    shutil.copy2(backup / 'before' / name, PRIMARY / name)
                p.compose('up', '-d', '--no-deps', 'everyday')
                p.wait_health(18081, 'qwen38-nighttime')
                p.publish_marker()
                p.write(PRIMARY / 'evidence/live-identity.json', p.runtime_identity())
            p.drain(False)
            raise


if __name__ == '__main__':
    main()
