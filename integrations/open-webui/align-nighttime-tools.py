"""Explicitly align nighttime preset tools with their daytime counterparts."""
import copy
import datetime
import json
from pathlib import Path
import re
import sqlite3
import sys
import urllib.parse
import urllib.request

PAIRS = [('bear-castle-ai', 'bear-castle-ai-nighttime'),
         ('bear-castle-ai-deep-thinking', 'bear-castle-ai-nighttime-deep-thinking')]
TOOL_FIELDS = ('defaultFeatureIds', 'toolIds', 'builtinTools', 'filterIds', 'actionIds', 'knowledge')

def align_tools(source, target, capabilities):
    if 'tools' not in capabilities:
        raise ValueError('Nighttime backend must be qualified for native tools first')
    result = copy.deepcopy(target)
    meta = result['meta']
    meta['capabilities'] = copy.deepcopy(source['meta']['capabilities'])
    meta['capabilities']['vision'] = 'vision' in capabilities
    for field in TOOL_FIELDS:
        if field in source['meta']:
            meta[field] = copy.deepcopy(source['meta'][field])
        else:
            meta.pop(field, None)
    return result

def main():
    from open_webui.utils.auth import create_token
    db = sqlite3.connect('file:/app/backend/data/webui.db?mode=ro', uri=True)
    uid = db.execute("select id from user where role='admin' order by created_at limit 1").fetchone()[0]
    token = create_token({'id': uid}, expires_delta=datetime.timedelta(minutes=10))
    def api(path, body=None):
        req = urllib.request.Request('http://127.0.0.1:8080' + path,
            data=None if body is None else json.dumps(body).encode(),
            headers={'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json'})
        with urllib.request.urlopen(req, timeout=90) as response:
            return json.load(response)
    def model(mid):
        return api('/api/v1/models/model?' + urllib.parse.urlencode({'id': mid}))
    mode = sys.argv[1]
    if mode == 'snapshot':
        if api('/api/tasks')['tasks']:
            raise RuntimeError('Open WebUI has active tasks; retry deployment after they finish')
        settings = api('/api/v1/configs/namespace/web.search')
        print(json.dumps({'models': [model(mid) for pair in PAIRS for mid in pair] + [model('qwen3.8-27b-abliterated-q6_k')],
            'config': {key: settings[key] for key in ['web.search.ddgs_backend','web.search.concurrent_requests']}}))
        return
    if mode == 'apply-search':
        api('/api/v1/configs/import', {'config': {'web.search.ddgs_backend':'duckduckgo,yandex,brave','web.search.concurrent_requests':1}})
        settings = api('/api/v1/configs/namespace/web.search')
        assert settings['web.search.ddgs_backend'] == 'duckduckgo,yandex,brave'
        assert settings['web.search.concurrent_requests'] == 1
        print('Verified deployed three-provider search fallback configuration')
        return
    label_daytime = mode == 'daytime-labels'
    selected_alias = 'daytime' if label_daytime else 'nighttime'
    selected_label = 'Daytime' if label_daytime else 'Nighttime'
    with urllib.request.urlopen(urllib.request.Request('http://ai-router:11434/api/show',
            data=json.dumps({'model': selected_alias}).encode(), headers={'Content-Type':'application/json'}), timeout=30) as response:
        info = json.load(response)
    capabilities = info['capabilities']
    context = info['model_info']['context_length']
    if type(context) is not int or context <= 0 or context % 1024:
        raise ValueError('Model discovery did not provide a valid context size')
    context_label = f'{context // 1024}K'
    if mode in ('labels', 'daytime-labels'):
        targets = [day if label_daytime else night for day, night in PAIRS]
        base_ids = [info['model'], selected_alias, *(['local-active'] if label_daytime else [])]
        identifiers = list(dict.fromkeys([*base_ids, *targets]))
        before = [model(mid) for mid in identifiers]
        other_presets = [model(night if label_daytime else day) for day, night in PAIRS]
        payload_fields = ('id', 'name', 'base_model_id', 'params', 'meta', 'access_grants', 'is_active')
        def payload(value):
            return {key: copy.deepcopy(value[key]) for key in payload_fields if key in value}
        proposed = []
        for original in before:
            result = payload(original)
            if result['id'] in base_ids:
                result['name'] = f'{selected_label} ({context_label})'
            elif re.search(r'\b\d+K\b', result['name'], re.I):
                result['name'] = re.sub(r'\b\d+K\b', context_label, result['name'], flags=re.I)
            elif result['name'].endswith(')'):
                result['name'] = result['name'][:-1] + f', {context_label})'
            else:
                result['name'] += f' ({context_label})'
            description = result['meta'].get('description')
            if description:
                result['meta']['description'] = re.sub(r'\b\d+K(?=\s+context\b|,\s+one\s+slot\b)', context_label, description, flags=re.I)
            proposed.append(result)
        backup = Path('/app/backend/data/context-label-migrations')
        backup.mkdir(mode=0o700, exist_ok=True)
        stamp = datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ')
        (backup / (stamp + '-before.json')).write_text(json.dumps(before, indent=2) + '\n')
        applied = []
        try:
            for original, result in zip(before, proposed):
                if payload(model(result['id'])) != payload(original):
                    raise RuntimeError('Preset changed during label preparation: ' + result['id'])
                # Omitted grants retain their existing records. Posting even
                # identical grants recreates their IDs in Open WebUI.
                api('/api/v1/models/model/update', {key: value for key, value in result.items() if key != 'access_grants'})
                applied.append(original)
                if payload(model(result['id'])) != result:
                    raise RuntimeError('Preset label verification failed: ' + result['id'])
            for original in other_presets:
                if payload(model(original['id'])) != payload(original):
                    raise RuntimeError('Other preset changed during label update')
            refreshed = {row['id']: row for row in api('/api/models?refresh=true')['data']}
            for result in proposed:
                if refreshed[result['id']]['name'] != result['name']:
                    raise RuntimeError('Visible context label did not refresh')
                print(json.dumps({'id': result['id'], 'name': result['name']}))
        except BaseException:
            for original in reversed(applied):
                api('/api/v1/models/model/update', {key: value for key, value in payload(original).items() if key != 'access_grants'})
            api('/api/models?refresh=true')
            raise
        return
    if mode == 'apply':
        # Prepare every model before any writes, including backend qualification.
        proposed = [align_tools(model(day), model(night), capabilities) for day,night in PAIRS]
        for result in proposed:
            api('/api/v1/models/model/update', result)
            print('Aligned tools:', result['id'])
        base = model(info['model'])
        for key in ['builtin_tools','web_search','code_interpreter','terminal','image_generation']:
            base['meta']['capabilities'][key] = True
        base['meta']['capabilities']['vision'] = 'vision' in capabilities
        features = 'text, images, tools and reasoning' if 'vision' in capabilities else 'text, tools and reasoning'
        base['meta']['description'] = f'Nighttime; {features}; {context_label} context, one active request.'
        api('/api/v1/models/model/update', base)
        api('/api/v1/configs/import', {'config': {'web.search.ddgs_backend':'duckduckgo,yandex,brave','web.search.concurrent_requests':1}})
        api('/api/models?refresh=true')
    elif mode != 'verify':
        raise ValueError(mode)
    for day,night in PAIRS:
        source,target = model(day),model(night)
        expected = align_tools(source,target,capabilities)
        assert target['meta'] == expected['meta'], 'Tool parity failed: ' + night
        assert target['base_model_id'] == 'nighttime'
        print('Verified tool parity:', night)
    settings = api('/api/v1/configs/namespace/web.search')
    assert settings['web.search.ddgs_backend'] == 'duckduckgo,yandex,brave'
    assert settings['web.search.concurrent_requests'] == 1
    print('Verified search backend and concurrency settings')

if __name__ == '__main__':
    main()
