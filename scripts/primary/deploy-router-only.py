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
IMAGE = os.environ.get('ROUTER_PUBLICATION_IMAGE', 'llm-router:latest')
ROUTER_NAME = 'llm-router'
IDENTITY_FILE = 'compose.router-identity.json'
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

def compose_command(*args, identity=False):
    command = ['docker', 'compose', '-f', str(STACK / 'compose.yaml'),
        '-f', str(STACK / 'compose.runtime.yaml')]
    if identity:
        command += ['-f', str(STACK / IDENTITY_FILE)]
    return command + list(args)

def router_identity(config):
    """Rename only the router; retain the controller's old DNS name on every network."""
    router = config['services']['ai-router']
    networks = router.get('networks')
    if router.get('network_mode') or not isinstance(networks, dict) or not networks:
        raise RuntimeError('Router rename requires Compose networks to preserve controller DNS')
    aliases = {'ai-router', ROUTER_NAME, 'local-ai-ollama-router'}
    if router.get('container_name'):
        aliases.add(router['container_name'])
    return {'name': config['name'], 'services': {'ai-router': {
        'container_name': ROUTER_NAME,
        'networks': {name: {'aliases': sorted(aliases | set((options or {}).get('aliases') or []))}
            for name, options in networks.items()}}}}

def check_router_identity(project, image_id=None):
    ids = subprocess.check_output(['docker', 'container', 'ls', '--all', '--quiet',
        '--filter', 'name=^/' + ROUTER_NAME + '$'], text=True).split()
    if not ids:
        if image_id is not None:
            raise RuntimeError('Renamed router container is missing; drain remains enabled')
        return
    container = json.loads(subprocess.check_output(['docker', 'inspect', ROUTER_NAME], text=True))[0]
    labels = container.get('Config', {}).get('Labels') or {}
    if (labels.get('com.docker.compose.project') != project
            or labels.get('com.docker.compose.service') != 'ai-router'):
        raise RuntimeError('Container name llm-router is already owned by another deployment')
    if image_id is not None and (container['Image'] != image_id or not container['State']['Running']):
        raise RuntimeError('Renamed router is not running the reviewed image; drain remains enabled')

def main():
    revision, image_id = reviewed_image()
    publisher = PRIMARY / 'primary.py'
    proposed = SOURCE / 'scripts/primary/primary.py'
    managed = (PRIMARY / 'runtime-owner.json').exists()
    if not managed and digest(publisher) not in [OWNER_PUBLISHER_HASH, digest(proposed)]:
        raise RuntimeError('Publisher changed since server-owner handoff; merge before installation')
    identity_path = STACK / IDENTITY_FILE
    config = json.loads(subprocess.check_output(compose_command('config', '--format', 'json',
        identity=identity_path.exists()), cwd=STACK, text=True))
    identity = router_identity(config)
    check_router_identity(identity['name'])
    # Transport tests use short real timers; avoid CPU contention between files.
    subprocess.run(['docker', 'run', '--rm', IMAGE, 'node', '--test', '--test-concurrency=1'], check=True, stdout=subprocess.DEVNULL)
    before = controller()
    residents = {name: before.inspect(name)['Id'] for name in before.NAMES}
    backup = PRIMARY / 'corrections' / ('router-' + datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ'))
    backup.mkdir(mode=0o700, parents=True)
    for source, name in [(publisher, 'primary.py'), (PRIMARY / 'model-catalog.json', 'model-catalog.json'),
        (STACK / '.env', 'stack.env'), (STACK / 'compose.yaml', 'stack.compose.yaml'),
        (STACK / 'compose.runtime.yaml', 'stack.compose.runtime.yaml'),
        (before.MARKER, 'active-model.json')]:
        shutil.copy2(source, backup / name)
    if identity_path.exists():
        shutil.copy2(identity_path, backup / IDENTITY_FILE)
    before.drain(True)
    before.wait_idle()
    install_runtime_source(publisher, proposed, managed)
    env = STACK / '.env'
    replacements = {'ROUTER_IMAGE': IMAGE, 'ROUTER_CONTAINER_NAME': ROUTER_NAME,
        'OLLAMA_UPSTREAM_TIMEOUT_MS': '30000', 'GENERATION_STALL_TIMEOUT_MS': '120000'}
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
    identity_path.write_text(json.dumps(identity, indent=2) + '\n')
    subprocess.run(compose_command('up', '-d', '--no-deps', '--pull', 'never', 'ai-router', identity=True),
        check=True, cwd=STACK)
    deadline = time.monotonic() + 120
    while True:
        try:
            with urllib.request.urlopen('http://192.168.1.21:11434/health', timeout=3) as response:
                if response.status == 200: break
        except Exception:
            pass
        if time.monotonic() >= deadline: raise RuntimeError('Router readiness failed; drain remains enabled')
        time.sleep(1)
    check_router_identity(identity['name'], image_id)
    after = controller()
    after.publish_marker()
    if residents != {name: after.inspect(name)['Id'] for name in after.NAMES}:
        raise RuntimeError('Unexpected inference service recreation')
    after.drain(False)
    receipt = {'image': IMAGE, 'image_id': image_id, 'source_revision': revision,
        'container_name': ROUTER_NAME, 'compose_project': identity['name'],
        'identity_override': str(identity_path), 'identity_override_sha256': digest(identity_path),
        'runtime_controller': 'local-ai-runtime' if managed else 'legacy-host',
        'source_directory': str(SOURCE), 'backend_container_ids_unchanged': residents,
        'publisher_sha256': digest(publisher), 'source_catalog_sha256': digest(PRIMARY / 'model-catalog.json'),
        'generated_catalog_sha256': digest(after.MARKER), 'backup': str(backup),
        'deployed_at': datetime.datetime.now(datetime.timezone.utc).isoformat()}
    (backup / 'deployment.json').write_text(json.dumps(receipt, indent=2) + '\n')
    print(json.dumps(receipt, indent=2))

if __name__ == '__main__':
    main()
