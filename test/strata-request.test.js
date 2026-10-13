import test from 'node:test';
import assert from 'node:assert/strict';
import { strataCountRequest } from '../src/strata-request.js';

test('Strata counting preserves system positions, thinking, tool calls and tool results', () => {
  const messages = [
    { role: 'system', content: 'x-anthropic-billing-header: cch=abc; keep this literally' },
    { role: 'user', content: [{ type: 'text', text: 'Find ' }, { type: 'text', text: 'it' }] },
    { role: 'assistant', content: null, reasoning_content: 'Look up the item.', tool_calls: [
      { id: 'call-1', type: 'function', function: { name: 'lookup', arguments: '{"id":4}' } }
    ] },
    { role: 'tool', tool_call_id: 'call-1', content: 'found' },
    { role: 'developer', content: 'Now answer.' }
  ];
  const tools = [{ type: 'function', function: { name: 'lookup', description: 'Look up an item', parameters: { type: 'object' } } }];
  const req = strataCountRequest(messages, { tools, chat_template_kwargs: { reasoning_effort: 'low' } }, 'trial');
  assert.equal(req.system, undefined);
  assert.deepEqual(req.messages[0], messages[0]);
  assert.equal(req.messages[1].content, 'Find it');
  assert.deepEqual(req.messages[2].content.slice(1), [
    { type: 'thinking', thinking: 'Look up the item.' },
    { type: 'tool_use', id: 'call-1', name: 'lookup', input: '{"id":4}' }
  ]);
  assert.deepEqual(req.messages[3], { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call-1', content: 'found' }] });
  assert.deepEqual(req.messages[4], { role: 'system', content: 'Now answer.' });
  assert.deepEqual(req.tools, [{ name: 'lookup', description: 'Look up an item', input_schema: { type: 'object' } }]);
  assert.deepEqual(req.output_config, { effort: 'low' });
});

test('Strata count explicitly preserves thinking off and template-default thinking', () => {
  for (const controls of [{ reasoning_effort: 'none' }, { chat_template_kwargs: { enable_thinking: false } }]) {
    assert.deepEqual(strataCountRequest([], controls, 'trial').thinking, { type: 'disabled' });
  }
  assert.deepEqual(strataCountRequest([], {}, 'trial').thinking, { type: 'enabled' });
  assert.throws(() => strataCountRequest([{ role: 'user', content: [{ type: 'image_url' }] }], {}, 'trial'), /text messages only/);
});
