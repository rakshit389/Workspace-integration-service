/** An error that maps directly to an HTTP response for our own API. */
export class HttpError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

/** A failed call to an enterprise system. `retryable` decides whether backoff applies. */
export class UpstreamError extends Error {
  constructor(
    readonly system: string,
    readonly statusCode: number | undefined,
    message: string,
    readonly retryable: boolean,
    readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = 'UpstreamError';
  }
}
