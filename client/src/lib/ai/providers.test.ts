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

console.log('ai providers ok');
