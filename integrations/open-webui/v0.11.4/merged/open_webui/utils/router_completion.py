"""Preserve router terminal state through Open WebUI's native Ollama bridge."""
import asyncio
import json

ROUTER_MODELS = {'local-active', 'qwen3.8-27b-q8_0', 'qwen3.8-27b-abliterated-q6_k'}


def error_message(error):
    if isinstance(error, str):
        return error
    if isinstance(error, dict):
        for key in ('message', 'content', 'detail', 'error'):
            message = error_message(error.get(key))
            if message:
                return message
    return None


def incomplete_message(state):
    message = error_message(state.get('error'))
    if message:
        return message if message.startswith('Response incomplete') else f'Response incomplete: {message}'
    return f"Response incomplete ({state.get('stop_reason') or 'stream interrupted'})."


def terminal_metadata(payload):
    metadata = dict(payload.get('x_router') or {})
    if metadata or payload.get('model') in ROUTER_MODELS:
        metadata.setdefault('status', 'in_progress')
        if payload.get('done'):
            reason = payload.get('done_reason') or 'missing_finish_reason'
            metadata.setdefault('stop_reason', reason)
            metadata['status'] = 'completed' if reason in ('stop', 'tool_calls') and not payload.get('error') and metadata.get('status') != 'incomplete' else 'incomplete'
        if payload.get('error'):
            metadata['status'] = 'incomplete'
            metadata['error'] = payload['error']
            if isinstance(payload['error'], dict) and payload['error'].get('code'):
                if metadata.get('stop_reason') in (None, 'error', 'missing_finish_reason'):
                    metadata['stop_reason'] = payload['error']['code']
        return metadata
    return None


def apply_terminal(payload, converted, has_tools=False):
    metadata = terminal_metadata(payload)
    if metadata is None:
        return converted
    converted['x_router'] = metadata
    if payload.get('done'):
        reason = payload.get('done_reason') or 'missing_finish_reason'
        converted['choices'][0]['finish_reason'] = ('tool_calls' if has_tools else 'stop') if reason == 'stop' else reason
    if metadata['status'] == 'incomplete':
        converted['error'] = incomplete_message(metadata)
    return converted


def incomplete_fields(state):
    if not state:
        return {}
    result = {'x_router': dict(state)}
    if state.get('status') != 'completed':
        result['error'] = {'content': incomplete_message(state)}
    return result


def finalize_items(items, state):
    if state and state.get('status') != 'completed':
        for item in items:
            item['status'] = 'incomplete'
    return items


async def guarded_native_stream(response, original):
    """Keep the upstream bridge for framing; make broken router streams explicit."""
    state = {}
    try:
        async for line in original(response):
            if line.startswith('data: {'):
                data = json.loads(line[6:])
                state.update(data.get('x_router') or {})
            if '[DONE]' in line and state and state.get('status') == 'in_progress':
                state.update(status='incomplete', stop_reason='missing_terminal_event', error='Upstream ended without a terminal event.')
                yield 'data: ' + json.dumps({'error': incomplete_message(state), 'x_router': state}) + '\n\n'
            yield line
    except asyncio.CancelledError:
        raise
    except Exception:
        if not state:
            raise
        state.update(status='incomplete', stop_reason='broken_stream', error='Upstream stream failed.')
        yield 'data: ' + json.dumps({'error': incomplete_message(state), 'x_router': state}) + '\n\n'
        yield 'data: [DONE]\n\n'
