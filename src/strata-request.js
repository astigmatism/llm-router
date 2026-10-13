// Strata v0.1.43 exposes the model's real tokenizer at the Anthropic count route.
// Keep messages in place (including system/developer turns), so its special
// top-level Anthropic billing-header rewrite cannot change an OpenAI prompt.
export function strataCountRequest(messages, controls, model) {
  const text = (content) => typeof content === 'string' ? content
    : (content || []).map((part) => {
      if (part.type !== 'text') throw new Error('Strata token counting supports text messages only.');
      return part.text || '';
    }).join('');
  const converted = messages.map((message) => {
    const role = message.role === 'developer' ? 'system' : message.role;
    const content = text(message.content);
    if (role === 'tool') return { role: 'user', content: [{
      type: 'tool_result', tool_use_id: message.tool_call_id, content
    }] };
    if (!message.tool_calls?.length && !message.reasoning_content) return { role, content };
    const blocks = [{ type: 'text', text: content }];
    if (message.reasoning_content) blocks.push({ type: 'thinking', thinking: message.reasoning_content });
    for (const call of message.tool_calls || []) {
      // Strata's two frontends accept the same raw argument string/object.
      blocks.push({ type: 'tool_use', id: call.id, name: call.function.name, input: call.function.arguments });
    }
    return { role, content: blocks };
  });
  const kwargs = controls.chat_template_kwargs || {};
  const effort = kwargs.reasoning_effort || controls.reasoning_effort;
  return {
    model, messages: converted,
    thinking: { type: kwargs.enable_thinking === false || effort === 'none' ? 'disabled' : 'enabled' },
    ...(effort && effort !== 'none' ? { output_config: { effort } } : {}),
    ...(controls.tools ? { tools: controls.tools.map(({ function: fn }) => ({
      name: fn.name, description: fn.description || '', input_schema: fn.parameters || {}
    })) } : {})
  };
}
