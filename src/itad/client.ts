import type { z } from 'zod';
import { requestJson, type Fetch } from '../http.ts';
import { Throttle } from '../util.ts';
import {
  AnySchema,
  CollectionGamesSchema,
  CopiesSchema,
  GameBundlesSchema,
  GameInfoSchema,
  LinkProfileSchema,
  SearchResultSchema,
  SyncResponseSchema,
  TitleLookupSchema,
  type NewCopy,
  type SyncEntry,
} from './schemas.ts';

const BASE_URL = 'https://api.isthereanydeal.com';

export interface ItadClientOptions {
  apiKey: string;
  /** Needed for collection/profile endpoints. */
  accessToken?: () => Promise<string>;
  fetch?: Fetch;
  retryDelayMs?: number;
  /** Default 3/s, comfortably under ITAD's 1000 per 5 minutes. */
  requestsPerSecond?: number;
}

type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

export class ItadClient {
  readonly #apiKey: string;
  readonly #accessToken: (() => Promise<string>) | undefined;
  readonly #fetch: Fetch | undefined;
  readonly #retryDelayMs: number | undefined;
  readonly #throttle: Throttle;

  constructor(options: ItadClientOptions) {
    this.#apiKey = options.apiKey;
    this.#accessToken = options.accessToken;
    this.#fetch = options.fetch;
    this.#retryDelayMs = options.retryDelayMs;
    this.#throttle = new Throttle(options.requestsPerSecond ?? 3);
  }

  async #request<S extends z.ZodType>(
    method: Method,
    path: string,
    schema: S,
    { body, user = false, headers = {} }: { body?: unknown; user?: boolean; headers?: Record<string, string> } = {},
  ): Promise<z.infer<S>> {
    const h: Record<string, string> = { ...headers };
    if (user) {
      if (!this.#accessToken) throw new Error('ITAD user endpoint called without OAuth token');
      h.Authorization = `Bearer ${await this.#accessToken()}`;
    } else {
      h['ITAD-API-Key'] = this.#apiKey;
    }
    if (body !== undefined) h['content-type'] = 'application/json';
    await this.#throttle.wait();
    return requestJson(
      `${BASE_URL}${path}`,
      { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) },
      schema,
      { fetch: this.#fetch, retryDelayMs: this.#retryDelayMs },
    );
  }

  // --- catalogue (API key) ---

  lookupTitles(titles: string[]) {
    return this.#request('POST', '/lookup/id/title/v1', TitleLookupSchema, { body: titles });
  }

  gameInfo(id: string) {
    return this.#request('GET', `/games/info/v2?id=${encodeURIComponent(id)}`, GameInfoSchema);
  }

  /** All bundles (including expired) that contained the game. */
  gameBundles(id: string) {
    const q = new URLSearchParams({ id, expired: 'true' });
    return this.#request('GET', `/games/bundles/v2?${q}`, GameBundlesSchema);
  }

  search(title: string, results = 10) {
    const q = new URLSearchParams({ title, results: String(results) });
    return this.#request('GET', `/games/search/v1?${q}`, SearchResultSchema);
  }

  // --- user (OAuth) ---

  collectionGames() {
    return this.#request('GET', '/collection/games/v1', CollectionGamesSchema, { user: true });
  }

  copies() {
    return this.#request('GET', '/collection/copies/v1', CopiesSchema, { user: true });
  }

  addCopies(copies: NewCopy[]) {
    return this.#request('POST', '/collection/copies/v1', AnySchema, { user: true, body: copies });
  }

  deleteCopies(copyIds: number[]) {
    return this.#request('DELETE', '/collection/copies/v1', AnySchema, { user: true, body: copyIds });
  }

  linkProfile(accountId: string, accountName: string) {
    return this.#request('PUT', '/profiles/link/v1', LinkProfileSchema, {
      user: true,
      body: { accountId, accountName },
    });
  }

  syncCollection(profileToken: string, entries: SyncEntry[]) {
    return this.#request('PUT', '/profiles/sync/collection/v1', SyncResponseSchema, {
      user: true,
      body: entries,
      headers: { 'ITAD-Profile': profileToken },
    });
  }
}
