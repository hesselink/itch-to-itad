import type { z } from 'zod';
import { requestJson, type Fetch } from '../http.ts';

const BASE_URL = 'https://api.itch.io';

export interface ItchClientOptions {
  apiKey: string;
  fetch?: Fetch;
  /** Base delay for exponential backoff, in ms. */
  retryDelayMs?: number;
}

export class ItchClient {
  readonly #apiKey: string;
  readonly #fetch: Fetch | undefined;
  readonly #retryDelayMs: number | undefined;

  constructor(options: ItchClientOptions) {
    this.#apiKey = options.apiKey;
    this.#fetch = options.fetch;
    this.#retryDelayMs = options.retryDelayMs;
  }

  get<S extends z.ZodType>(path: string, schema: S): Promise<z.infer<S>> {
    return requestJson(
      `${BASE_URL}${path}`,
      { headers: { Authorization: `Bearer ${this.#apiKey}` } },
      schema,
      { fetch: this.#fetch, retryDelayMs: this.#retryDelayMs },
    );
  }
}
