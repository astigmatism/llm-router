"""Publish the error-details overlay while preserving the current UI and inference configuration."""
import datetime
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import time
import urllib.request

SOURCE = Path(__file__).resolve().parents[2]
ROOT = Path('/home/astigmatism/apps/open-webui')


def run(args):
    return subprocess.check_output(args, text=True).strip()


def inspect(name):
    return json.loads(run(['docker', 'inspect', name]))[0]


def main():
    revision = run(['git', '-C', str(SOURCE), 'rev-parse', 'HEAD'])
    if run(['git', '-C', str(SOURCE), 'status', '--porcelain', '--untracked-files=normal']):
        raise RuntimeError('Deploy from a clean published source checkout')
    image = os.environ['OPENWEBUI_PUBLICATION_IMAGE']
    expected_base = os.environ['OPENWEBUI_EXPECTED_BASE_IMAGE_ID']
    info = inspect(image)
    if info['Config'].get('Labels', {}).get('org.opencontainers.image.revision') != revision:
        raise RuntimeError('Image and source revision differ')
    current = inspect('open-webui')
    if current['Image'] != expected_base:
        raise RuntimeError('Installed Open WebUI image changed during review')
    other_ids = {name: inspect(name)['Id'] for name in ['local-ai-ollama-router', 'qwen38-daytime', 'qwen38-nighttime']}
    compose = ROOT / 'compose.yml'
    original = compose.read_text()
    pattern = r'^(\s+image:)\s*' + re.escape(current['Config']['Image']) + r'\s*$'
    updated, count = re.subn(pattern, lambda m: m[1] + ' ' + image, original, flags=re.M)
    if count != 1:
        raise RuntimeError('Expected one matching Open WebUI image declaration')
    backup = ROOT / 'backups' / ('error-details-' + datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ'))
    backup.mkdir(mode=0o700, parents=True)
    shutil.copy2(compose, backup / 'compose.yml')
    temporary = compose.with_suffix('.error-details-new.yml')
    temporary.write_text(updated)
    temporary.chmod(compose.stat().st_mode & 0o777)
    subprocess.run(['docker', 'compose', '-f', str(temporary), 'config', '--quiet'], cwd=ROOT, check=True)
    os.replace(temporary, compose)
    try:
        subprocess.run(['docker', 'compose', 'up', '-d', '--no-deps', '--pull', 'never', 'open-webui'], cwd=ROOT, check=True)
        deadline = time.monotonic() + 120
        while True:
            try:
                with urllib.request.urlopen('http://192.168.1.21:3000/health', timeout=3) as response:
                    if response.status == 200:
                        break
            except Exception:
                pass
            if time.monotonic() > deadline:
                raise RuntimeError('Open WebUI did not become ready')
            time.sleep(1)
        after = inspect('open-webui')
        # Docker Compose may reorder Env entries when recreating a container.
        # Compare the actual variable mapping, not its serialization order.
        environment = lambda container: dict(value.split('=', 1) for value in container['Config']['Env'])
        if environment(after) != environment(current):
            raise RuntimeError('Unexpected Open WebUI environment change')
        for key in ['Cmd', 'Entrypoint']:
            if after['Config'][key] != current['Config'][key]:
                raise RuntimeError('Unexpected Open WebUI configuration change: ' + key)
        if after['Mounts'] != current['Mounts']:
            raise RuntimeError('Open WebUI mounts changed')
        if other_ids != {name: inspect(name)['Id'] for name in other_ids}:
            raise RuntimeError('Another service was recreated')
    except Exception:
        shutil.copy2(backup / 'compose.yml', compose)
        subprocess.run(['docker', 'compose', 'up', '-d', '--no-deps', '--pull', 'never', 'open-webui'], cwd=ROOT, check=True)
        raise
    receipt = {'source_revision': revision, 'image': image, 'image_id': info['Id'],
               'previous_image_id': current['Image'], 'other_container_ids_unchanged': other_ids,
               'backup': str(backup), 'environment_and_mounts_preserved': True}
    (backup / 'deployment.json').write_text(json.dumps(receipt, indent=2) + '\n')
    print(json.dumps(receipt, indent=2))


if __name__ == '__main__':
    main()
