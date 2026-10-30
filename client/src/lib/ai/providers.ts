// Model providers for AI accounts (docs/design.md §9): one adapter for the
// OpenAI-compatible API (DeepSeek, OpenRouter, xAI, local models...), and
// Claude's and Gemini's own. Pure: builds requests and reads streamed
// replies; lib/ai/runner.ts sends them (transport.aiRequest).

export type ProviderKind = 'openai' | 'claude' | 'gemini';

/** A model service I have a key for (kept in the credential store, lib/ai/keys.ts). */
export interface Provider {
  id: string;
  kind: ProviderKind;
  name: string;
  baseUrl: string;
  key: string;
}

/** A plain chat turn (the conversation as the model sees it). */
export interface ChatMsg {
  role: 'user' | 'assistant';
  content: string;
}

/** A tool the model may call (JSON schema for its arguments). */
export interface ToolSpec {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

/** A call the model made; args is JSON text. */
export interface ToolCall {
  id: string;
  name: string;
  args: string;
}

/**
 * One message of an agent turn: chat text, the model's tool calls, tool
 * results. images are base64 PNGs (screenshots) for models that can see.
 */
export type AgentMsg =
  | { role: 'user'; content: string; images?: string[] }
  | { role: 'assistant'; content: string; toolCalls?: ToolCall[] }
  | { role: 'tool'; callId: string; name: string; content: string; images?: string[] };

export interface ChatRequest {
  model: string;
  system: string;
  messages: AgentMsg[];
  temperature: number;
  maxTokens: number;
  tools?: ToolSpec[];
}

export const KIND_LABEL: Record<ProviderKind, string> = { openai: 'OpenAI 兼容', claude: 'Claude', gemini: 'Gemini' };

/** Ready-made addresses (the user can type any other). */
export const PRESETS: { name: string; kind: ProviderKind; baseUrl: string; model: string }[] = [
  { name: 'DeepSeek', kind: 'openai', baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat' },
  { name: 'OpenAI', kind: 'openai', baseUrl: 'https://api.openai.com/v1', model: '' },
  { name: 'OpenRouter', kind: 'openai', baseUrl: 'https://openrouter.ai/api/v1', model: '' },
  { name: 'Claude', kind: 'claude', baseUrl: 'https://api.anthropic.com', model: '' },
  { name: 'Gemini', kind: 'gemini', baseUrl: 'https://generativelanguage.googleapis.com', model: '' },
  { name: '本机模型（Ollama 等）', kind: 'openai', baseUrl: 'http://localhost:11434/v1', model: '' },
];

const trim = (u: string) => u.replace(/\/+$/, '');

const parseArgs = (a: string): Record<string, unknown> => {
  try {
    const v = JSON.parse(a || '{}') as unknown;
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
};

/** Groups runs of tool results (Claude and Gemini want them in one user turn). */
function groupTools(msgs: AgentMsg[]): (AgentMsg | Extract<AgentMsg, { role: 'tool' }>[])[] {
  const out: (AgentMsg | Extract<AgentMsg, { role: 'tool' }>[])[] = [];
  for (const m of msgs) {
    const last = out[out.length - 1];
    if (m.role === 'tool') {
      if (Array.isArray(last)) last.push(m);
      else out.push([m]);
    } else out.push(m);
  }
  return out;
}

function openaiMessages(r: ChatRequest) {
  const out: unknown[] = [{ role: 'system', content: r.system }];
  for (const m of r.messages) {
    if (m.role === 'user') {
      out.push({
        role: 'user',
        content: m.images?.length
          ? [{ type: 'text', text: m.content }, ...m.images.map((b) => ({ type: 'image_url', image_url: { url: `data:image/png;base64,${b}` } }))]
          : m.content,
      });
    } else if (m.role === 'assistant') {
      out.push(m.toolCalls?.length
        ? { role: 'assistant', content: m.content || null, tool_calls: m.toolCalls.map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: c.args || '{}' } })) }
        : { role: 'assistant', content: m.content });
    } else {
      out.push({ role: 'tool', tool_call_id: m.callId, content: m.content });
      // Tool messages can't carry pictures here: hand them over as the user.
      if (m.images?.length) out.push({ role: 'user', content: [{ type: 'text', text: `（${m.name} 的截图）` }, ...m.images.map((b) => ({ type: 'image_url', image_url: { url: `data:image/png;base64,${b}` } }))] });
    }
  }
  return out;
}

function claudeMessages(r: ChatRequest) {
  const img = (b: string) => ({ type: 'image', source: { type: 'base64', media_type: 'image/png', data: b } });
  return groupTools(r.messages).map((m) => {
    if (Array.isArray(m)) {
      return { role: 'user', content: m.map((t) => ({ type: 'tool_result', tool_use_id: t.callId, content: [{ type: 'text', text: t.content || '（空）' }, ...(t.images ?? []).map(img)] })) };
    }
    if (m.role === 'user') return { role: 'user', content: m.images?.length ? [{ type: 'text', text: m.content }, ...m.images.map(img)] : m.content };
    if (m.role === 'assistant' && m.toolCalls?.length) {
      return {
        role: 'assistant',
        content: [...(m.content ? [{ type: 'text', text: m.content }] : []), ...m.toolCalls.map((c) => ({ type: 'tool_use', id: c.id, name: c.name, input: parseArgs(c.args) }))],
      };
    }
    return { role: m.role, content: m.content };
  });
}

function geminiContents(r: ChatRequest) {
  const img = (b: string) => ({ inlineData: { mimeType: 'image/png', data: b } });
  return groupTools(r.messages).map((m) => {
    if (Array.isArray(m)) {
      return { role: 'user', parts: m.flatMap((t) => [{ functionResponse: { name: t.name, response: { result: t.content } } }, ...(t.images ?? []).map(img)]) };
    }
    if (m.role === 'user') return { role: 'user', parts: [{ text: m.content }, ...(m.images ?? []).map(img)] };
    if (m.role === 'assistant') {
      return { role: 'model', parts: [...(m.content ? [{ text: m.content }] : []), ...(m.toolCalls ?? []).map((c) => ({ functionCall: { name: c.name, args: parseArgs(c.args) } }))] };
    }
    return { role: 'user', parts: [{ text: m.content }] };
  });
}

/** The HTTP request for a streamed chat completion (with tools when given). */
export function buildRequest(p: Provider, r: ChatRequest): { url: string; headers: Record<string, string>; body: string } {
  const json = { 'Content-Type': 'application/json' };
  const tools = r.tools?.length ? r.tools : undefined;
  switch (p.kind) {
    case 'openai':
      return {
        url: `${trim(p.baseUrl)}/chat/completions`,
        headers: { ...json, Authorization: `Bearer ${p.key}` },
        body: JSON.stringify({
          model: r.model,
          messages: openaiMessages(r),
          temperature: r.temperature,
          max_tokens: r.maxTokens,
          stream: true,
          ...(tools && { tools: tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } })) }),
        }),
      };
    case 'claude':
      return {
        url: `${trim(p.baseUrl)}/v1/messages`,
        headers: { ...json, 'x-api-key': p.key, 'anthropic-version': '2023-06-01', 'anthropic-dangerous-direct-browser-access': 'true' },
        body: JSON.stringify({
          model: r.model, system: r.system, messages: claudeMessages(r), temperature: r.temperature, max_tokens: r.maxTokens, stream: true,
          ...(tools && { tools: tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters })) }),
        }),
      };
    case 'gemini':
      return {
        url: `${trim(p.baseUrl)}/v1beta/models/${encodeURIComponent(r.model)}:streamGenerateContent?alt=sse`,
        headers: { ...json, 'x-goog-api-key': p.key },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: r.system }] },
          contents: geminiContents(r),
          generationConfig: { temperature: r.temperature, maxOutputTokens: r.maxTokens },
          ...(tools && { tools: [{ functionDeclarations: tools.map((t) => ({ name: t.name, description: t.description, parameters: t.parameters })) }] }),
        }),
      };
  }
}

/** An error message inside a stream or an error body ("error": {...}). */
export function errorOf(body: string): string {
  try {
    const j = JSON.parse(body) as { error?: { message?: string } | string; message?: string };
    if (typeof j.error === 'string') return j.error;
    return j.error?.message ?? j.message ?? '';
  } catch {
    return body.slice(0, 200);
  }
}

/**
 * Reads a streamed reply fed in arbitrary chunks: `feed` returns the new
 * text; tool calls are collected (their arguments arrive in pieces) and
 * read with `toolCalls()` at the end. Lines are buffered until complete.
 */
export function streamReader(kind: ProviderKind) {
  let buf = '';
  let raw = '';
  // Calls being assembled, by the provider's index.
  const calls = new Map<number, ToolCall>();
  let gemini = 0;
  const call = (i: number) => {
    let c = calls.get(i);
    if (!c) calls.set(i, (c = { id: '', name: '', args: '' }));
    return c;
  };
  const data = (d: string): string => {
    if (d === '[DONE]') return '';
    let o: Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
    try {
      o = JSON.parse(d);
    } catch {
      return '';
    }
    switch (kind) {
      case 'openai': {
        const delta = o.choices?.[0]?.delta ?? {};
        for (const tc of delta.tool_calls ?? []) {
          const c = call(tc.index ?? 0);
          if (tc.id) c.id = tc.id;
          if (tc.function?.name) c.name += tc.function.name;
          if (tc.function?.arguments) c.args += tc.function.arguments;
        }
        return delta.content ?? '';
      }
      case 'claude':
        if (o.type === 'content_block_start' && o.content_block?.type === 'tool_use') {
          const c = call(o.index);
          c.id = o.content_block.id;
          c.name = o.content_block.name;
        }
        if (o.type !== 'content_block_delta') return '';
        if (o.delta?.type === 'input_json_delta') call(o.index).args += o.delta.partial_json ?? '';
        return o.delta?.type === 'text_delta' ? o.delta.text ?? '' : '';
      case 'gemini': {
        let text = '';
        for (const part of o.candidates?.[0]?.content?.parts ?? []) {
          if (part.functionCall) {
            const c = call(gemini++);
            c.id = `call_${gemini}`;
            c.name = part.functionCall.name;
            c.args = JSON.stringify(part.functionCall.args ?? {});
          } else if (part.text) text += part.text;
        }
        return text;
      }
    }
  };
  return {
    feed(chunk: string): string {
      raw += chunk;
      buf += chunk;
      let out = '';
      let nl: number;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).replace(/\r$/, '');
        buf = buf.slice(nl + 1);
        if (line.startsWith('data:')) out += data(line.slice(5).trim());
      }
      return out;
    },
    /** The tool calls the model made (in order). */
    toolCalls: (): ToolCall[] =>
      [...calls.entries()].sort((a, b) => a[0] - b[0]).map(([i, c]) => ({ ...c, id: c.id || `call_${i}`, args: c.args || '{}' })).filter((c) => c.name),
    /** Everything received (for error bodies, which are not a stream). */
    raw: () => raw,
  };
}
