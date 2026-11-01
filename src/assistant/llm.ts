import { z } from 'zod';
import type { Config } from '../config.js';
import { HttpError } from '../errors.js';

export interface ToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
}

export interface ToolSpec {
  type: 'function';
  function: { name: string; description: string; parameters: Record<string, unknown> };
}

/** The one thing the chat needs from a language model. Tests replace it with a scripted fake. */
export interface ChatModel {
  complete(messages: ChatMessage[], tools: ToolSpec[]): Promise<ChatMessage>;
}

const replySchema = z.object({
  choices: z
    .array(
      z.object({
        message: z.object({
          content: z.string().nullable().optional(),
          tool_calls: z
            .array(
              z.object({
                id: z.string().optional(),
                function: z.object({ name: z.string(), arguments: z.union([z.string(), z.record(z.unknown())]).optional() }),
              }),
            )
            .optional(),
        }),
      }),
    )
    .min(1),
});

/**
 * Calls any OpenAI-compatible chat completions endpoint: Ollama locally, Azure OpenAI in production.
 * Only the URL, model and key differ, so switching is configuration, not code.
 */
export class OpenAICompatibleChatModel implements ChatModel {
  constructor(private readonly config: Config['llm']) {}

  async complete(messages: ChatMessage[], tools: ToolSpec[]): Promise<ChatMessage> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.config.timeoutMs);
    let body: unknown;
    try {
      const response = await fetch(`${this.config.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(this.config.apiKey ? { authorization: `Bearer ${this.config.apiKey}` } : {}),
        },
        body: JSON.stringify({ model: this.config.model, messages, tools, temperature: 0 }),
        signal: controller.signal,
      });
      if (!response.ok) {
        const detail = (await response.text().catch(() => '')).slice(0, 200);
        throw new HttpError(503, 'assistant_unavailable', `The language model returned ${response.status}: ${detail}`);
      }
      body = await response.json();
    } catch (error) {
      if (error instanceof HttpError) throw error;
      const reason = controller.signal.aborted ? `did not answer within ${this.config.timeoutMs} ms` : 'is not reachable';
      throw new HttpError(503, 'assistant_unavailable', `The language model at ${this.config.baseUrl} ${reason}`);
    } finally {
      clearTimeout(timer);
    }

    const parsed = replySchema.safeParse(body);
    if (!parsed.success) throw new HttpError(503, 'assistant_unavailable', 'The language model returned an unexpected response');
    const message = parsed.data.choices[0]!.message;
    return {
      role: 'assistant',
      content: message.content ?? null,
      tool_calls: message.tool_calls?.map((call, index) => ({
        id: call.id ?? `call_${index}`,
        type: 'function' as const,
        function: {
          name: call.function.name,
          arguments: typeof call.function.arguments === 'string' ? call.function.arguments : JSON.stringify(call.function.arguments ?? {}),
        },
      })),
    };
  }
}
