"""Overlay tests; run inside the built image, never against production data:

docker run --rm -e WEBUI_SECRET_KEY=test-only -v "$PWD/tests:/tests:ro" --entrypoint python \
    local/open-webui:v0.11.4-router-v2 -m unittest discover -s /tests -v
"""
import asyncio
import json
import unittest

from aiohttp import web
from fastapi import HTTPException

from open_webui.routers import ollama
from open_webui.utils import context_compaction as compaction
from open_webui.utils import router_completion as rc
from open_webui.utils import session_pool


class TerminalStateTests(unittest.TestCase):
    def test_terminal_frames_are_classified_without_model_ids(self):
        done = rc.terminal_metadata({'model': 'any-new-canonical-id', 'done': True, 'done_reason': 'stop'})
        self.assertEqual(done['status'], 'completed')
        cut = rc.terminal_metadata({'model': 'any', 'done': True, 'done_reason': 'length'})
        self.assertEqual((cut['status'], cut['stop_reason']), ('incomplete', 'length'))
        self.assertIsNone(rc.terminal_metadata({'model': 'any', 'message': {'content': 'partial'}, 'done': False}))
        routed = rc.terminal_metadata({'x_router': {'status': 'in_progress'}, 'done': False})
        self.assertEqual(routed['status'], 'in_progress')
        failed = rc.terminal_metadata({'error': {'code': 'UPSTREAM_STREAM_FAILED', 'message': 'x'}, 'done': True, 'done_reason': 'error'})
        self.assertEqual((failed['status'], failed['stop_reason']), ('incomplete', 'UPSTREAM_STREAM_FAILED'))
        self.assertFalse(hasattr(rc, 'ROUTER_MODELS'))

    def test_wait_decision_uses_the_router_error_code(self):
        self.assertTrue(rc.router_should_wait(503, {'error': {'code': 'BACKEND_DRAINING'}}))
        self.assertTrue(rc.router_should_wait(503, {'error': {'code': 'MAINTENANCE_MODE'}}))
        self.assertFalse(rc.router_should_wait(503, {'error': {'code': 'SERVICE_OFFLINE'}}))
        self.assertFalse(rc.router_should_wait(503, {'error': 'legacy string'}))
        self.assertFalse(rc.router_should_wait(500, {'error': {'code': 'BACKEND_DRAINING'}}))
        self.assertEqual([rc.router_wait_delay(a) for a in range(6)], [2, 4, 8, 16, 30, 30])


class CompactionCapTests(unittest.TestCase):
    def test_threshold_never_exceeds_the_serving_models_context(self):
        models = {'daytime': {'ollama': {'context_length': 131072}},
                  'small': {'ollama': {'x_ollama_router': {'context_window': 65536}}},
                  'preset': {'info': {'base_model_id': 'small'}}}
        self.assertEqual(compaction._model_context_window('daytime', models), 131072)
        self.assertEqual(compaction._model_context_window('preset', models), 65536)
        self.assertIsNone(compaction._model_context_window('unknown', models))
        self.assertEqual(compaction._cap_to_model_context(80000, 131072), 80000)
        self.assertEqual(compaction._cap_to_model_context(80000, 98304), 80000)
        self.assertEqual(compaction._cap_to_model_context(80000, 65536), 65536 - 1024 - 8192)
        self.assertEqual(compaction._cap_to_model_context(80000, None), 80000)


class NativeBridgeTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        # Open WebUI shares one aiohttp session; each test runs on its own event loop.
        session_pool._session = None
        self.calls = []
        self.responses = []

        async def handler(request):
            self.calls.append(dict(request.headers))
            status, body = self.responses.pop(0) if self.responses else (200, {'ok': True})
            return web.json_response(body, status=status)

        app = web.Application()
        app.router.add_post('/api/chat', handler)
        self.runner = web.AppRunner(app)
        await self.runner.setup()
        site = web.TCPSite(self.runner, '127.0.0.1', 0)
        await site.start()
        self.url = f'http://127.0.0.1:{site._server.sockets[0].getsockname()[1]}/api/chat'
        self._delay, self._limit = ollama.router_wait_delay, ollama.ROUTER_WAIT_SECONDS
        ollama.router_wait_delay = lambda attempt: 0

    async def asyncTearDown(self):
        ollama.router_wait_delay, ollama.ROUTER_WAIT_SECONDS = self._delay, self._limit
        if session_pool._session is not None:
            await session_pool._session.close()
            session_pool._session = None
        await self.runner.cleanup()

    async def send(self):
        return await ollama.send_request(self.url, payload=json.dumps({'model': 'daytime'}), stream=False)

    async def test_waits_through_a_router_drain_then_succeeds(self):
        drain = (503, {'error': {'code': 'BACKEND_DRAINING', 'message': 'draining'}})
        self.responses = [drain, drain]
        self.assertEqual(await self.send(), {'ok': True})
        self.assertEqual(len(self.calls), 3)
        self.assertTrue(all(c.get('X-Client-Name') == 'open-webui' for c in self.calls))

    async def test_an_offline_service_fails_at_once(self):
        self.responses = [(503, {'error': {'code': 'SERVICE_OFFLINE', 'message': 'Nighttime is offline'}})]
        with self.assertRaises(HTTPException) as caught:
            await self.send()
        self.assertEqual(caught.exception.status_code, 503)
        self.assertIn('SERVICE_OFFLINE', json.dumps(caught.exception.detail))
        self.assertEqual(len(self.calls), 1)

    async def test_gives_up_after_the_wait_limit(self):
        ollama.ROUTER_WAIT_SECONDS = 0
        self.responses = [(503, {'error': {'code': 'BACKEND_DRAINING', 'message': 'draining'}})] * 3
        with self.assertRaises(HTTPException) as caught:
            await self.send()
        self.assertEqual(caught.exception.status_code, 503)
        self.assertEqual(len(self.calls), 1)


if __name__ == '__main__':
    unittest.main()
