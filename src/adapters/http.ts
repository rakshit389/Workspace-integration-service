import { UpstreamError } from '../errors.js';

export interface RequestOptions {
  method?: 'GET' | 'POST';
  headers?: Record<string, string>;
  body?: unknown;
  timeoutMs: number;
}

/** JSON over HTTP with a hard timeout. Every failure becomes an UpstreamError the retry logic understands. */
export async function requestJson<T>(system: string, url: string, options: RequestOptions): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs);
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
    return (await response.json()) as T;
  } catch (error) {
    if (error instanceof UpstreamError) throw error;
    if (controller.signal.aborted) {
      throw new UpstreamError(system, undefined, `${system} did not answer within ${options.timeoutMs} ms`, true);
    }
    throw new UpstreamError(system, undefined, `${system} is unreachable`, true);
  } finally {
    clearTimeout(timer);
  }
}
