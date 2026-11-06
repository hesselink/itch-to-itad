import type { z } from 'zod';

const BASE_URL = 'https://api.itch.io';
const MAX_ATTEMPTS = 5;

export type Fetch = typeof fetch;

export class ItchApiError extends Error {
  readonly status: number;
  readonly path: string;
  constructor(status: number, path: string, body: string) {
    super(`itch API ${status} for ${path}: ${body.slice(0, 200)}`);
    this.status = status;
    this.path = path;
  }
}

export interface ItchClientOptions {
  apiKey: string;
  fetch?: Fetch;
  /** Base delay for exponential backoff, in ms. */
  retryDelayMs?: number;
}

export class ItchClient {
  readonly #apiKey: string;
  readonly #fetch: Fetch;
  readonly #retryDelayMs: number;

  constructor(options: ItchClientOptions) {
    this.#apiKey = options.apiKey;
    this.#fetch = options.fetch ?? fetch;
    this.#retryDelayMs = options.retryDelayMs ?? 1000;
  }

  async get<S extends z.ZodType>(path: string, schema: S): Promise<z.infer<S>> {
    for (let attempt = 1; ; attempt++) {
      const res = await this.#fetch(`${BASE_URL}${path}`, {
        headers: { Authorization: `Bearer ${this.#apiKey}` },
      });
      if (res.ok) {
        const json: unknown = await res.json();
        const parsed = schema.safeParse(json);
        if (!parsed.success) {
          throw new Error(`Unexpected response shape for ${path}: ${parsed.error.message}`);
        }
        return parsed.data;
      }
      const body = await res.text();
      const retryable = res.status === 429 || res.status >= 500;
      if (!retryable || attempt >= MAX_ATTEMPTS) {
        throw new ItchApiError(res.status, path, body);
      }
      const retryAfter = Number(res.headers.get('retry-after'));
      const delay = retryAfter > 0 ? retryAfter * 1000 : this.#retryDelayMs * 2 ** (attempt - 1);
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
}

/**
 * Requests pages 1, 2, ... until one comes back empty. itch documents that
 * pages may be short, so a short page is not proof that we've reached the end.
 */
export async function pageUntilEmpty<T>(fetchPage: (page: number) => Promise<T[]>): Promise<T[]> {
  const all: T[] = [];
  for (let page = 1; ; page++) {
    const items = await fetchPage(page);
    if (items.length === 0) return all;
    all.push(...items);
  }
}

/** Like Promise.all over items.map(fn), with at most `limit` in flight. */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}
