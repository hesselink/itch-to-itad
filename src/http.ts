import type { z } from 'zod';

export type Fetch = typeof fetch;

const MAX_ATTEMPTS = 5;

export class HttpError extends Error {
  readonly status: number;
  readonly url: string;
  readonly body: string;
  constructor(status: number, url: string, body: string) {
    super(`HTTP ${status} for ${url}: ${body.slice(0, 300)}`);
    this.status = status;
    this.url = url;
    this.body = body;
  }
}

export interface RequestOptions {
  fetch?: Fetch;
  /** Base delay for exponential backoff, in ms. */
  retryDelayMs?: number;
}

/**
 * Performs a request, retrying 429/5xx with exponential backoff (honouring
 * Retry-After), and validates the JSON body against `schema`. A 204 or empty
 * body is passed to the schema as `undefined`.
 */
export async function requestJson<S extends z.ZodType>(
  url: string,
  init: RequestInit,
  schema: S,
  { fetch: doFetch = fetch, retryDelayMs = 1000 }: RequestOptions = {},
): Promise<z.infer<S>> {
  for (let attempt = 1; ; attempt++) {
    const res = await doFetch(url, init);
    if (res.ok) {
      const text = await res.text();
      const json: unknown = text === '' ? undefined : JSON.parse(text);
      const parsed = schema.safeParse(json);
      if (!parsed.success) {
        throw new Error(`Unexpected response shape for ${redact(url)}: ${parsed.error.message}`);
      }
      return parsed.data;
    }
    const body = await res.text();
    const retryable = res.status === 429 || res.status >= 500;
    if (!retryable || attempt >= MAX_ATTEMPTS) {
      throw new HttpError(res.status, redact(url), body);
    }
    const retryAfter = Number(res.headers.get('retry-after'));
    const delay = retryAfter > 0 ? retryAfter * 1000 : retryDelayMs * 2 ** (attempt - 1);
    await new Promise((resolve) => setTimeout(resolve, delay));
  }
}

/** Strips credentials passed as query parameters from URLs used in error messages. */
function redact(url: string): string {
  return url.replace(/([?&](?:key|access_token)=)[^&]*/g, '$1***');
}
