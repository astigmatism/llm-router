import asyncio
import json
from types import SimpleNamespace
from open_webui.utils.response import convert_response_ollama_to_openai, convert_streaming_response_ollama_to_openai
from open_webui.utils.router_completion import finalize_items, incomplete_fields

MODEL = 'qwen3.8-27b-q8_0'
TEXT = ('Full Unicode output: café 雪 🌲\n' * 4000) + 'NATURAL-END'

def payload(**fields):
    return {'model': MODEL, 'message': {'content': TEXT, 'thinking': '完整 reasoning'}, **fields}

async def collect(rows, broken=False):
    async def source():
        for row in rows: yield json.dumps(row).encode()
        if broken: raise ConnectionError('test stream disconnected')
    lines = [line async for line in convert_streaming_response_ollama_to_openai(SimpleNamespace(body_iterator=source()))]
    return [json.loads(line[6:]) for line in lines if line.startswith('data: {')]

async def main():
    for reason in ['stop', 'length', 'error']:
        p = payload(done=True, done_reason=reason)
        result = convert_response_ollama_to_openai(p)
        assert result['choices'][0]['message']['content'] == TEXT
        assert result['choices'][0]['finish_reason'] == reason
        assert bool(result.get('error')) == (reason != 'stop')
        chunks = await collect([payload(done=False), {'model': MODEL, 'done': True, 'done_reason': reason}])
        assert ''.join(c.get('choices', [{}])[0].get('delta', {}).get('content', '') or '' for c in chunks) == TEXT
        assert chunks[-1]['x_router']['status'] == ('completed' if reason == 'stop' else 'incomplete')
    for broken in [False, True]:
        chunks = await collect([payload(done=False)], broken)
        assert chunks[-1]['error'] and chunks[-1]['x_router']['status'] == 'incomplete'
    timeout_message = 'Response incomplete: No upstream bytes or inference progress for 120000 ms.'
    for retained in ['', TEXT]:
        chunks = await collect([
            {'model': MODEL, 'message': {'content': retained}, 'done': False, 'x_router': {'status': 'in_progress'}},
            {'error': timeout_message, 'done': True, 'done_reason': 'error', 'x_router': {'status': 'incomplete'}},
        ])
        assert ''.join(c.get('choices', [{}])[0].get('delta', {}).get('content', '') or '' for c in chunks) == retained
        saved = incomplete_fields(chunks[-1]['x_router'])
        assert saved['error']['content'] == timeout_message
        assert chunks[-1]['error'] == timeout_message
    state = {'status': 'incomplete', 'stop_reason': 'cancelled'}
    items = [{'type': 'function_call', 'status': 'completed', 'arguments': '{"partial":'}]
    assert finalize_items(items, state)[0]['status'] == 'incomplete'
    assert incomplete_fields(state)['error']['content'].startswith('Response incomplete')
    print(json.dumps({'natural_stop': True, 'length_incomplete': True, 'error_incomplete': True,
        'missing_terminal': True, 'broken_stream': True, 'unicode_characters_retained': len(TEXT),
        'partial_tool_marked_incomplete': True, 'upstream_error_details_persisted': True,
        'empty_response_has_no_retained_text_claim': True}))

asyncio.run(main())
