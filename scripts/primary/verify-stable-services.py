#!/usr/bin/env python3
"""Production discovery checks and small synthetic requests; no configuration writes."""
import argparse
import copy
import datetime
import importlib.util
import json
import requests

spec = importlib.util.spec_from_file_location('installed_primary', '/home/astigmatism/apps/local-ai-primary/primary.py')
primary = importlib.util.module_from_spec(spec)
spec.loader.exec_module(primary)
BASE = 'http://192.168.1.4:11434'


def main(generate=False):
    identity = primary.runtime_identity()
    data = primary.http(BASE + '/v1/models')['data']
    canonical = [row for row in data if not row['x_ollama_router']['alias']]
    assert len(canonical) == 2
    ids = [row['id'] for row in data]
    assert len(ids) == len(set(ids))
    tags = primary.http(BASE + '/api/tags')['models']
    assert [row['model'] for row in tags] == ids
    lookup = {row['id']: row for row in data}
    aliases = {}
    for service in ['daytime', 'nighttime', 'local-active']:
        row = lookup[service]
        meta = row['x_ollama_router']
        aliases[service] = meta['upstream_model']
        expected = copy.deepcopy(lookup[meta['upstream_model']])
        expected['id'] = service
        expected['x_ollama_router']['alias'] = True
        assert row == expected
        assert primary.http(BASE + '/v1/models/' + service) == row
        assert next(row for row in tags if row['model'] == service)['x_ollama_router'] == meta
        show = primary.http(BASE + '/api/show', {'model': service})
        assert show['model'] == meta['upstream_model']
        assert show['model_info']['context_length'] == meta['context_window']
        assert show['capabilities'] == meta['capabilities']
        assert meta['complete'] and meta['warnings'] == [] and meta['health']['available']
        assert meta['active_request_limit'] == 1 and meta['output_policy'] == 'unrestricted'
        assert meta['max_output_tokens'] is None and meta['default_output_tokens'] is None
    assert aliases['local-active'] == aliases['daytime'] != aliases['nighttime']
    for route in ['runtime-state', 'summary']:
        assert [row['id'] for row in primary.admin(route)['models']] == [row['id'] for row in canonical]
    assert [row['model'] for row in primary.http(BASE + '/api/ps')['models']] == [row['id'] for row in canonical]
    generations = []
    if generate:
        cases = [(service, think) for service in ['daytime', 'nighttime'] for think in [False, 'max']]
        cases += [(row['id'], False) for row in canonical] + [('local-active', False)]
        for model, think in cases:
            response = requests.post(BASE + '/api/chat', json={'model': model, 'think': think, 'stream': False,
                'messages': [{'role': 'user', 'content': 'Reply with exactly SERVICE_ROUTE_OK.'}]}, timeout=(10, 300))
            response.raise_for_status()
            body = response.json()
            assert body['model'] == aliases.get(model, model)
            assert body['done'] is True and body['done_reason'] == 'stop'
            assert 'SERVICE_ROUTE_OK' in body['message']['content']
            generations.append({'route': '/api/chat', 'requested_model': model, 'think': think,
                'resolved_model': body['model'], 'status': response.status_code, 'done_reason': body['done_reason']})
        for service in ['daytime', 'nighttime']:
            response = requests.post(BASE + '/v1/responses', json={'model': service, 'reasoning': {'effort': 'none'},
                'input': 'Reply with exactly SERVICE_ROUTE_OK.', 'stream': False}, timeout=(10, 300))
            response.raise_for_status()
            body = response.json()
            assert body['model'] == aliases[service] and body['status'] == 'completed'
            generations.append({'route': '/v1/responses', 'requested_model': service,
                'resolved_model': body['model'], 'status': response.status_code, 'terminal': body['status']})
    assert primary.runtime_identity() == identity
    state = primary.admin('runtime-state')['runtime']
    assert not state['draining'] and state['queue_policy'] == 'fifo-per-backend'
    print(json.dumps({'verified_at': datetime.datetime.now(datetime.timezone.utc).isoformat(),
        'identifiers': ids, 'aliases': aliases, 'native_and_openai_metadata_equal': True,
        'resident_count': len(canonical), 'backend_identity_unchanged': True, 'generations': generations,
        'runtime': state}, indent=2))


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--generate', action='store_true', help='Run coordinated synthetic inference acceptance')
    main(parser.parse_args().generate)
