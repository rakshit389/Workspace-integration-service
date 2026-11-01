import type { ZodType } from 'zod';
import { UpstreamError } from '../errors.js';

export interface RequestOptions {
  method?: 'GET' | 'POST';
  headers?: Record<string, string>;
  body?: unknown;
  timeoutMs: number;
}

/**
 * JSON over HTTP with a hard timeout. The response is checked against `schema`, so a vendor that
 * changes its format produces a clear, non-retryable UpstreamError instead of bad data in a panel.
 */
export async function requestJson<T>(system: string, url: string, schema: ZodType<T>, options: RequestOptions): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs);
  let body: unknown;
  try {
    const response = await fetch(url, {
      method: options.method ?? 'GET',
      headers: { accept: 'application/json', ...(options.body ? { 'content-type': 'application/json' } : {}), ...options.headers },
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      signal: controller.signal,
    });
    if (!response.ok) {
      await response.text().catch(() => undefined);
      const retryAfter = response.headers.get('retry-after');
      throw new UpstreamError(
        system,
        response.status,
        `${system} responded with ${response.status}`,
        response.status === 429 || response.status >= 500,
        retryAfter ? Number(retryAfter) * 1_000 : undefined,
      );
    }
    body = await response.json();
  } catch (error) {
    if (error instanceof UpstreamError) throw error;
    if (controller.signal.aborted) {
      throw new UpstreamError(system, undefined, `${system} did not answer within ${options.timeoutMs} ms`, true);
    }
    throw new UpstreamError(system, undefined, `${system} is unreachable`, true);
  } finally {
    clearTimeout(timer);
  }

  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const where = issue?.path.length ? issue.path.join('.') : 'body';
    // Retrying will not fix a format change; it is logged and alerted on, and the panel shows unavailable.
    throw new UpstreamError(system, undefined, `${system} returned an unexpected response (${where}: ${issue?.message ?? 'invalid'})`, false);
  }
  return parsed.data;
}
