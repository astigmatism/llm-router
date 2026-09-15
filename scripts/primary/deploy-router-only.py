#!/usr/bin/env python3
"""Publish the router correction without recreating either inference service."""
import datetime
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import time
import urllib.request

STACK = Path('/home/astigmatism/apps/local-ai-ollama-stack')
PRIMARY = Path('/home/astigmatism/apps/local-ai-primary')
SOURCE = Path(__file__).resolve().parents[2]
IMAGE = os.environ.get('ROUTER_PUBLICATION_IMAGE', 'local-ai-ollama-router:unrestricted-20260912')
OWNER_PUBLISHER_HASH = 'ecb9f08c52a560a825e24e115e077577ca7f659bcaf259626e248e93f8134689'

class ManagedController:
    """Runtime keeps launch/catalog ownership across a router-only release."""
    NAMES = ['qwen38-daytime', 'qwen38-nighttime']
    MARKER = STACK / 'runtime/router/active-model.json'

    def command(self, action):
        subprocess.run(['docker', 'exec', 'local-ai-runtime', 'python3', '-m', 'runtime', action], check=True)

    def inspect(self, name):
        return json.loads(subprocess.check_output(['docker', 'inspect', name], text=True))[0]

    def drain(self, enabled):
        self.command('router-maintenance-begin' if enabled else 'router-maintenance-end')

    def wait_idle(self):
        # begin reserves the configuration, drains, and checks both direct slots.
        pass

    def publish_marker(self):
        self.command('publish')

def install_runtime_source(publisher, proposed, managed):
    if managed:
        return
    for source, destination in [(proposed, publisher), (SOURCE / 'runtime/primary-model-catalog.json', PRIMARY / 'model-catalog.json')]:
        temporary = destination.with_suffix('.router-new')
        shutil.copy2(source, temporary)
        if destination == publisher:
            temporary.chmod(0o755)
        os.replace(temporary, destination)

def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()

def controller():
    if (PRIMARY / 'runtime-owner.json').exists():
        return ManagedController()
    spec = importlib.util.spec_from_file_location('primary_router_publication', PRIMARY / 'primary.py')
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module

def reviewed_image():
    revision = subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=SOURCE, text=True).strip()
    changes = subprocess.check_output(['git', 'status', '--porcelain', '--untracked-files=normal'], cwd=SOURCE, text=True)
    if changes.strip():
        raise RuntimeError('Publish from a clean checkout of reviewed, committed router source')
    image = json.loads(subprocess.check_output(['docker', 'image', 'inspect', IMAGE], text=True))[0]
    if (image.get('Config', {}).get('Labels') or {}).get('org.opencontainers.image.revision') != revision:
        raise RuntimeError('Router image revision does not match the committed source checkout')
    return revision, image['Id']

def main():
    revision, image_id = reviewed_image()
    publisher = PRIMARY / 'primary.py'
    proposed = SOURCE / 'scripts/primary/primary.py'
    managed = (PRIMARY / 'runtime-owner.json').exists()
    if not managed and digest(publisher) not in [OWNER_PUBLISHER_HASH, digest(proposed)]:
        raise RuntimeError('Publisher changed since server-owner handoff; merge before installation')
    # Transport tests use short real timers; avoid CPU contention between files.
    subprocess.run(['docker', 'run', '--rm', IMAGE, 'node', '--test', '--test-concurrency=1'], check=True, stdout=subprocess.DEVNULL)
    before = controller()
    residents = {name: before.inspect(name)['Id'] for name in before.NAMES}
    backup = PRIMARY / 'corrections' / ('router-' + datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ'))
    backup.mkdir(mode=0o700, parents=True)
    for source, name in [(publisher, 'primary.py'), (PRIMARY / 'model-catalog.json', 'model-catalog.json'),
        (STACK / '.env', 'stack.env'), (STACK / 'compose.yaml', 'stack.compose.yaml'),
        (before.MARKER, 'active-model.json')]:
        shutil.copy2(source, backup / name)
    before.drain(True)
    before.wait_idle()
    install_runtime_source(publisher, proposed, managed)
    env = STACK / '.env'
    replacements = {'ROUTER_IMAGE': IMAGE, 'OLLAMA_UPSTREAM_TIMEOUT_MS': '30000', 'GENERATION_STALL_TIMEOUT_MS': '120000'}
    lines = []
    for line in env.read_text().splitlines():
        key = line.split('=', 1)[0]
        lines.append(key + '=' + replacements.pop(key) if key in replacements else line)
    lines += [key + '=' + value for key, value in replacements.items()]
    env.write_text('\n'.join(lines) + '\n')
    compose = STACK / 'compose.yaml'
    text = compose.read_text().replace('${OLLAMA_UPSTREAM_TIMEOUT_MS:-900000}', '${OLLAMA_UPSTREAM_TIMEOUT_MS:-30000}')
    if 'GENERATION_STALL_TIMEOUT_MS:' not in text:
        text = text.replace('      OLLAMA_UPSTREAM_TIMEOUT_MS:', '      GENERATION_STALL_TIMEOUT_MS: "${GENERATION_STALL_TIMEOUT_MS:-120000}"\n      OLLAMA_UPSTREAM_TIMEOUT_MS:')
    compose.write_text(text)
    subprocess.run(['docker', 'compose', '-f', str(compose), '-f', str(STACK / 'compose.runtime.yaml'),
        'up', '-d', '--no-deps', '--pull', 'never', 'ai-router'], check=True, cwd=STACK)
    deadline = time.monotonic() + 120
    while True:
        try:
            with urllib.request.urlopen('http://192.168.1.21:11434/health', timeout=3) as response:
                if response.status == 200: break
        except Exception:
            pass
        if time.monotonic() >= deadline: raise RuntimeError('Router readiness failed; drain remains enabled')
        time.sleep(1)
    after = controller()
    after.publish_marker()
    if residents != {name: after.inspect(name)['Id'] for name in after.NAMES}:
        raise RuntimeError('Unexpected inference service recreation')
    after.drain(False)
    receipt = {'image': IMAGE, 'image_id': image_id, 'source_revision': revision,
        'runtime_controller': 'local-ai-runtime' if managed else 'legacy-host',
        'source_directory': str(SOURCE), 'backend_container_ids_unchanged': residents,
        'publisher_sha256': digest(publisher), 'source_catalog_sha256': digest(PRIMARY / 'model-catalog.json'),
        'generated_catalog_sha256': digest(after.MARKER), 'backup': str(backup),
        'deployed_at': datetime.datetime.now(datetime.timezone.utc).isoformat()}
    (backup / 'deployment.json').write_text(json.dumps(receipt, indent=2) + '\n')
    print(json.dumps(receipt, indent=2))

if __name__ == '__main__':
    main()
