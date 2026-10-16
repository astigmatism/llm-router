import test from 'node:test';
import assert from 'node:assert/strict';
import {
  STRATA_VISION_TOKEN_ALLOWANCE,
  StrataUncountableContentError,
  strataCountRequest,
  strataVisionImages,
  strataVisionTokenAllowance
} from '../src/strata-request.js';

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
});

// The vision cutover replaced the former text-only contract: image parts are
// representable, so they are counted through the per-image allowance instead of
// failing the request. Only parts with no count representation may throw.
test('Strata counting counts image parts instead of rejecting them', () => {
  for (const image of [
    { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } },
    { type: 'input_image', image_url: 'data:image/png;base64,AAAA' },
    { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } },
    { type: 'image_url' }
  ]) {
    const messages = [{ role: 'user', content: [{ type: 'text', text: 'Describe ' }, image, { type: 'text', text: 'this' }] }];
    const req = strataCountRequest(messages, {}, 'trial');
    assert.equal(req.messages[0].content, 'Describe this');
    assert.equal(JSON.stringify(req).includes('AAAA'), false);
    assert.equal(strataVisionImages(messages), 1);
  }
});

test('Strata counting walks the whole history for images', () => {
  const image = { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } };
  const messages = [
    { role: 'user', content: [{ type: 'text', text: 'first' }, image] },
    { role: 'assistant', content: 'answered' },
    { role: 'user', content: [{ type: 'text', text: 'and again' }, image] },
    { role: 'user', content: 'plain text turn', images: ['AAAA', 'BBBB'] }
  ];
  assert.equal(strataVisionImages(messages), 4);
  assert.deepEqual(strataCountRequest(messages, {}, 'trial').messages, [
    { role: 'user', content: 'first' },
    { role: 'assistant', content: 'answered' },
    { role: 'user', content: 'and again' },
    { role: 'user', content: 'plain text turn' }
  ]);
});

test('Strata counting keeps a text-free image turn countable', () => {
  const messages = [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } }] }];
  assert.equal(strataCountRequest(messages, {}, 'trial').messages[0].content, '');
  assert.equal(strataVisionImages(messages), 1);
});

test('Strata counting rejects only content it cannot represent', () => {
  for (const part of [{ type: 'audio' }, { type: 'file' }, {} ]) {
    assert.throws(
      () => strataCountRequest([{ role: 'user', content: [part] }], {}, 'trial'),
      (error) => error instanceof StrataUncountableContentError && error.param === 'messages[0].content[0]',
      JSON.stringify(part)
    );
    assert.throws(() => strataVisionImages([{ role: 'user', content: [part] }]), StrataUncountableContentError);
  }
});

test('Strata vision allowance defaults to the measured ceiling and follows model metadata', () => {
  assert.equal(STRATA_VISION_TOKEN_ALLOWANCE, 1050);
  assert.equal(strataVisionTokenAllowance({}), STRATA_VISION_TOKEN_ALLOWANCE);
  assert.equal(strataVisionTokenAllowance({ raw: 'not-an-object' }), STRATA_VISION_TOKEN_ALLOWANCE);
  assert.equal(strataVisionTokenAllowance({ raw: { vision_token_allowance: 1180 } }), 1180);
  assert.equal(strataVisionTokenAllowance({ raw: { vision_token_allowance: '1180' } }), 1180);
  // Publishing 0 is how a model whose engine already counts patch tokens opts out.
  assert.equal(strataVisionTokenAllowance({ raw: { vision_token_allowance: 0 } }), 0);
  for (const invalid of [-1, 1.5, '1050.0', true, {}, null]) {
    assert.equal(strataVisionTokenAllowance({ raw: { vision_token_allowance: invalid } }), STRATA_VISION_TOKEN_ALLOWANCE);
  }
});
