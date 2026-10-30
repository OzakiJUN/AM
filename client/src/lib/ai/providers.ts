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

export interface ChatMsg {
  role: 'user' | 'assistant';
  content: string;
}

export interface ChatRequest {
  model: string;
  system: string;
  messages: ChatMsg[];
  temperature: number;
  maxTokens: number;
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

/** The HTTP request for a streamed chat completion. */
export function buildRequest(p: Provider, r: ChatRequest): { url: string; headers: Record<string, string>; body: string } {
  const json = { 'Content-Type': 'application/json' };
  switch (p.kind) {
    case 'openai':
      return {
        url: `${trim(p.baseUrl)}/chat/completions`,
        headers: { ...json, Authorization: `Bearer ${p.key}` },
        body: JSON.stringify({
          model: r.model,
          messages: [{ role: 'system', content: r.system }, ...r.messages],
          temperature: r.temperature,
          max_tokens: r.maxTokens,
          stream: true,
        }),
      };
    case 'claude':
      return {
        url: `${trim(p.baseUrl)}/v1/messages`,
        headers: { ...json, 'x-api-key': p.key, 'anthropic-version': '2023-06-01', 'anthropic-dangerous-direct-browser-access': 'true' },
        body: JSON.stringify({ model: r.model, system: r.system, messages: r.messages, temperature: r.temperature, max_tokens: r.maxTokens, stream: true }),
      };
    case 'gemini':
      return {
        url: `${trim(p.baseUrl)}/v1beta/models/${encodeURIComponent(r.model)}:streamGenerateContent?alt=sse`,
        headers: { ...json, 'x-goog-api-key': p.key },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: r.system }] },
          contents: r.messages.map((m) => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] })),
          generationConfig: { temperature: r.temperature, maxOutputTokens: r.maxTokens },
        }),
      };
  }
}

/** Text pieces in one server-sent-events `data:` payload. */
function deltaOf(kind: ProviderKind, data: string): string {
  if (data === '[DONE]') return '';
  let j: unknown;
  try {
    j = JSON.parse(data);
  } catch {
    return '';
  }
  const o = j as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
  switch (kind) {
    case 'openai':
      return o.choices?.[0]?.delta?.content ?? '';
    case 'claude':
      return o.type === 'content_block_delta' && o.delta?.type === 'text_delta' ? o.delta.text ?? '' : '';
    case 'gemini':
      return (o.candidates?.[0]?.content?.parts ?? []).map((p: { text?: string }) => p.text ?? '').join('');
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
 * Reads a streamed reply fed in arbitrary chunks; `feed` returns the new
 * text. Lines are buffered until complete.
 */
export function streamReader(kind: ProviderKind) {
  let buf = '';
  let raw = '';
  return {
    feed(chunk: string): string {
      raw += chunk;
      buf += chunk;
      let out = '';
      let nl: number;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).replace(/\r$/, '');
        buf = buf.slice(nl + 1);
        if (line.startsWith('data:')) out += deltaOf(kind, line.slice(5).trim());
      }
      return out;
    },
    /** Everything received (for error bodies, which are not a stream). */
    raw: () => raw,
  };
}
