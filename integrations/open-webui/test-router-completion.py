"""Regression coverage for error details surviving the native bridge and persistence."""
import asyncio
import unittest
from types import SimpleNamespace

from router_completion import (
    apply_terminal, finalize_items, guarded_native_stream, incomplete_fields,
    terminal_metadata,
)


class TerminalErrors(unittest.TestCase):
    def test_queued_timeout_survives_conversion_and_saved_error(self):
        message = 'No upstream bytes or inference progress for 120000 ms.'
        payload = {
            'done': True, 'done_reason': 'error', 'error': message,
            'x_router': {'status': 'incomplete', 'stop_reason': 'UPSTREAM_TIMEOUT'},
        }
        converted = apply_terminal(payload, {'choices': [{'delta': {'content': ''}}]})
        self.assertEqual(converted['x_router']['stop_reason'], 'UPSTREAM_TIMEOUT')
        self.assertEqual(converted['choices'][0]['finish_reason'], 'error')
        saved = incomplete_fields(converted['x_router'])
        self.assertEqual(saved['error']['content'], 'Response incomplete: ' + message)
        self.assertNotIn('text has been retained', saved['error']['content'])

    def test_partial_output_is_preserved_with_structured_error(self):
        fragment = 'A partial answer: 雪 café'
        payload = {
            'model': 'local-active', 'done': True, 'done_reason': 'error',
            'error': {'code': 'UPSTREAM_TIMEOUT', 'message': 'Image processing timed out.'},
        }
        converted = apply_terminal(payload, {'choices': [{'delta': {'content': fragment}}]})
        self.assertEqual(converted['choices'][0]['delta']['content'], fragment)
        self.assertEqual(converted['x_router']['stop_reason'], 'UPSTREAM_TIMEOUT')
        self.assertIn('Image processing timed out.', incomplete_fields(converted['x_router'])['error']['content'])
        items = [{'type': 'message', 'content': fragment}, {'type': 'function_call', 'arguments': '{"partial":'}]
        self.assertTrue(all(i['status'] == 'incomplete' for i in finalize_items(items, converted['x_router'])))
        self.assertEqual(items[0]['content'], fragment)

    def test_natural_completion_and_explicit_incomplete_metadata(self):
        natural = terminal_metadata({'model': 'local-active', 'done': True, 'done_reason': 'stop'})
        self.assertEqual(natural['status'], 'completed')
        self.assertNotIn('error', incomplete_fields(natural))
        incomplete = terminal_metadata({
            'done': True, 'done_reason': 'stop',
            'x_router': {'status': 'incomplete', 'stop_reason': 'context_length_exceeded'},
        })
        self.assertEqual(incomplete['status'], 'incomplete')
        self.assertEqual(incomplete['stop_reason'], 'context_length_exceeded')

    def test_missing_terminal_error_survives_final_persistence(self):
        async def source(_):
            yield 'data: {"x_router":{"status":"in_progress"}}\n\n'
            yield 'data: [DONE]\n\n'

        async def run():
            import json
            rows = [r async for r in guarded_native_stream(SimpleNamespace(), source)]
            error = json.loads(rows[-2][6:])
            self.assertEqual(incomplete_fields(error['x_router'])['error']['content'], error['error'])
            self.assertIn('without a terminal event', error['error'])
        asyncio.run(run())


if __name__ == '__main__':
    unittest.main()
