#!/usr/bin/env python3
"""Verify production queues with synthetic requests; cancel only our own holder."""
import concurrent.futures
import datetime
import importlib.util
import json
import os
import time

import requests

spec = importlib.util.spec_from_file_location('installed_primary', '/home/astigmatism/apps/local-ai-primary/primary.py')
primary = importlib.util.module_from_spec(spec)
spec.loader.exec_module(primary)
BASE = 'http://192.168.1.4:11434'
MODEL = os.environ.get('QUEUE_TEST_MODEL', 'qwen3.8-27b-abliterated-q6_k')


def state():
    return primary.admin('runtime-state')['runtime']


def wait_for(predicate, seconds=180):
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        current = state()
        if predicate(current):
            return current
        time.sleep(.2)
    raise RuntimeError('Queue verification did not reach expected state')


def main():
    assert state()['queue_policy'] == 'fifo-per-backend'
    target = primary.http(BASE + '/v1/models/' + MODEL)['x_ollama_router']['upstream_model']
    holder = None
    queued = None
    cancelled = None
    executor = concurrent.futures.ThreadPoolExecutor(max_workers=1)
    result = {'checked_at': datetime.datetime.now(datetime.timezone.utc).isoformat(), 'model': MODEL, 'canonical_target': target}
    try:
        holder = requests.post(BASE + '/v1/chat/completions', json={
            'model': target, 'messages': [{'role': 'user', 'content': 'List every integer from 1 through 2000, one per line. Continue until 2000 without commentary.'}],
            'reasoning_effort': 'none', 'stream': True,
        }, stream=True, timeout=(10, 180))
        holder.raise_for_status()
        # Skip comments and wait for real output so this request owns the slot.
        holder_lines = holder.iter_lines(chunk_size=1)
        for line in holder_lines:
            if line.startswith(b'data: {'):
                data = json.loads(line[6:])
                if any(c.get('delta', {}).get('content') for c in data.get('choices', [])):
                    break
        else:
            raise RuntimeError('Holder produced no output')

        queued = requests.post(BASE + '/api/chat', json={
            'model': MODEL, 'messages': [{'role': 'user', 'content': 'Reply with exactly QUEUE_OK.'}], 'think': False, 'stream': True,
        }, stream=True, timeout=(10, 180))
        queued.raise_for_status()
        lines = queued.iter_lines(chunk_size=1)
        first = json.loads(next(lines))
        assert first['done'] is False and first['message']['content'] == ''
        before = wait_for(lambda s: s['queued_by_model'].get(target, 0) >= 1)
        assert before['active_by_model'].get(target) == 1

        cancelled = requests.post(BASE + '/v1/responses', json={
            'model': MODEL, 'input': 'Reply with exactly CANCELLED_REQUEST_MUST_NOT_RUN.', 'stream': True,
        }, stream=True, timeout=(10, 180))
        cancelled.raise_for_status()
        cancelled_lines = cancelled.iter_lines(chunk_size=1)
        assert next(cancelled_lines).startswith(b': waiting')
        two = wait_for(lambda s: s['queued_by_model'].get(target, 0) >= 2)
        cancelled.close()
        after_cancel = wait_for(lambda s: s['queued_by_model'].get(target, 0) < two['queued_by_model'][target])
        assert after_cancel['active_by_model'].get(target) == 1
        result['queued_cancellation_preserved_active_request'] = True

        started = time.monotonic()
        second = json.loads(executor.submit(next, lines).result(timeout=25))
        assert second['done'] is False and second['message']['content'] == ''
        result['heartbeat_interval_observed_seconds'] = round(time.monotonic() - started, 2)
        result['runtime_while_queued'] = before
        holder.close()
        chunks = []
        terminal = None
        for line in lines:
            if not line:
                continue
            item = json.loads(line)
            assert not item.get('error'), item.get('error')
            chunks.append(item.get('message', {}).get('content', ''))
            if item.get('done'):
                terminal = item
        assert 'QUEUE_OK' in ''.join(chunks)
        assert terminal and terminal['done_reason'] == 'stop'
        result.update(native_status=queued.status_code, native_completed=True,
                      generation_record_id=terminal.get('x_router', {}).get('record_id'))
        print(json.dumps(result, indent=2))
        return result
    finally:
        for response in [cancelled, queued, holder]:
            if response is not None:
                response.close()
        executor.shutdown(wait=False, cancel_futures=True)


if __name__ == '__main__':
    main()
