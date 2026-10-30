// Run with: npm test
import assert from 'node:assert/strict';
import { buildRequest, errorOf, streamReader, type Provider } from './providers.ts';

const req = { model: 'm1', system: '你是小鱼', messages: [{ role: 'user' as const, content: '你好' }], temperature: 0.8, maxTokens: 800 };
const P = (kind: Provider['kind'], baseUrl: string): Provider => ({ id: 'p', kind, name: 'x', baseUrl, key: 'sk-1' });

// OpenAI-compatible: system message first, bearer key, trailing slash ignored.
let r = buildRequest(P('openai', 'https://api.deepseek.com/v1/'), req);
assert.equal(r.url, 'https://api.deepseek.com/v1/chat/completions');
assert.equal(r.headers.Authorization, 'Bearer sk-1');
let b = JSON.parse(r.body);
assert.deepEqual(b.messages[0], { role: 'system', content: '你是小鱼' });
assert.equal(b.stream, true);
assert.equal(b.max_tokens, 800);

// Claude: system separate, x-api-key, version header.
r = buildRequest(P('claude', 'https://api.anthropic.com'), req);
assert.equal(r.url, 'https://api.anthropic.com/v1/messages');
assert.equal(r.headers['x-api-key'], 'sk-1');
assert.ok(r.headers['anthropic-version']);
b = JSON.parse(r.body);
assert.equal(b.system, '你是小鱼');
assert.deepEqual(b.messages, req.messages);

// Gemini: model in the path, "model" role, SSE.
r = buildRequest(P('gemini', 'https://generativelanguage.googleapis.com'), { ...req, messages: [...req.messages, { role: 'assistant', content: '嗨' }] });
assert.equal(r.url, 'https://generativelanguage.googleapis.com/v1beta/models/m1:streamGenerateContent?alt=sse');
b = JSON.parse(r.body);
assert.equal(b.contents[1].role, 'model');
assert.equal(b.systemInstruction.parts[0].text, '你是小鱼');

// Streams arrive in arbitrary pieces.
const feedAll = (kind: Provider['kind'], s: string) => {
  const rd = streamReader(kind);
  let out = '';
  for (let i = 0; i < s.length; i += 7) out += rd.feed(s.slice(i, i + 7));
  return out;
};
assert.equal(feedAll('openai', 'data: {"choices":[{"delta":{"content":"[mood:happy]你"}}]}\n\ndata: {"choices":[{"delta":{"content":"好呀"}}]}\n\ndata: [DONE]\n\n'), '[mood:happy]你好呀');
assert.equal(feedAll('claude', 'event: message_start\ndata: {"type":"message_start"}\n\nevent: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"你好"}}\r\n\r\n'), '你好');
assert.equal(feedAll('gemini', 'data: {"candidates":[{"content":{"parts":[{"text":"早上"}],"role":"model"}}]}\n\ndata: {"candidates":[{"content":{"parts":[{"text":"好"}]}}]}\n\n'), '早上好');

assert.equal(errorOf('{"error":{"message":"Invalid API key"}}'), 'Invalid API key');
assert.equal(errorOf('{"error":"bad"}'), 'bad');
assert.equal(errorOf('not json'), 'not json');

// ---- tools ----
const tools = [{ name: 'list_dir', description: '列目录', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } }];
const turn = {
  ...req,
  tools,
  messages: [
    { role: 'user' as const, content: '看看桌面' },
    { role: 'assistant' as const, content: '我看看', toolCalls: [{ id: 'c1', name: 'list_dir', args: '{"path":"D:/桌面"}' }] },
    { role: 'tool' as const, callId: 'c1', name: 'list_dir', content: 'a.txt\nb.png', images: ['QUJD'] },
  ],
};
// OpenAI: tool_calls on the assistant, a tool message, the picture as a user message.
b = JSON.parse(buildRequest(P('openai', 'https://x/v1'), turn).body);
assert.equal(b.tools[0].function.name, 'list_dir');
assert.deepEqual(b.messages[2].tool_calls[0], { id: 'c1', type: 'function', function: { name: 'list_dir', arguments: '{"path":"D:/桌面"}' } });
assert.deepEqual(b.messages[3], { role: 'tool', tool_call_id: 'c1', content: 'a.txt\nb.png' });
assert.equal(b.messages[4].content[1].image_url.url, 'data:image/png;base64,QUJD');
// Claude: tool_use with parsed input, tool_result (with the picture) in a user turn.
b = JSON.parse(buildRequest(P('claude', 'https://x'), turn).body);
assert.equal(b.tools[0].input_schema.type, 'object');
assert.deepEqual(b.messages[1].content[1], { type: 'tool_use', id: 'c1', name: 'list_dir', input: { path: 'D:/桌面' } });
assert.equal(b.messages[2].role, 'user');
assert.equal(b.messages[2].content[0].type, 'tool_result');
assert.equal(b.messages[2].content[0].content[1].source.data, 'QUJD');
// Gemini: functionCall / functionResponse parts.
b = JSON.parse(buildRequest(P('gemini', 'https://x'), turn).body);
assert.equal(b.tools[0].functionDeclarations[0].name, 'list_dir');
assert.deepEqual(b.contents[1].parts[1], { functionCall: { name: 'list_dir', args: { path: 'D:/桌面' } } });
assert.deepEqual(b.contents[2].parts[0], { functionResponse: { name: 'list_dir', response: { result: 'a.txt\nb.png' } } });
// No tools: no "tools" field at all.
assert.equal(JSON.parse(buildRequest(P('openai', 'https://x/v1'), req).body).tools, undefined);

// Streamed tool calls arrive in pieces.
const readAll = (kind: Provider['kind'], s: string) => {
  const rd = streamReader(kind);
  let text = '';
  for (let i = 0; i < s.length; i += 5) text += rd.feed(s.slice(i, i + 5));
  return { text, calls: rd.toolCalls() };
};
const sse = (o: unknown) => `data: ${JSON.stringify(o)}\n\n`;
let got = readAll('openai',
  sse({ choices: [{ delta: { content: '好，' } }] }) +
  sse({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_a', function: { name: 'list_dir', arguments: '{"pa' } }] } }] }) +
  sse({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'th":"D:/"}' } }] } }] }) +
  sse({ choices: [{ delta: { tool_calls: [{ index: 1, id: 'call_b', function: { name: 'run_command', arguments: '{}' } }] } }] }) + 'data: [DONE]\n\n');
assert.equal(got.text, '好，');
assert.deepEqual(got.calls, [{ id: 'call_a', name: 'list_dir', args: '{"path":"D:/"}' }, { id: 'call_b', name: 'run_command', args: '{}' }]);
got = readAll('claude',
  sse({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }) +
  sse({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '看一下' } }) +
  sse({ type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'toolu_1', name: 'list_dir', input: {} } }) +
  sse({ type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"path":' } }) +
  sse({ type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '"C:/"}' } }));
assert.equal(got.text, '看一下');
assert.deepEqual(got.calls, [{ id: 'toolu_1', name: 'list_dir', args: '{"path":"C:/"}' }]);
got = readAll('gemini', sse({ candidates: [{ content: { parts: [{ functionCall: { name: 'list_dir', args: { path: 'E:/' } } }] } }] }));
assert.deepEqual(got.calls, [{ id: 'call_1', name: 'list_dir', args: '{"path":"E:/"}' }]);

console.log('ai providers ok');
