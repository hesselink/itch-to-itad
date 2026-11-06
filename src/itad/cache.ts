import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * A key/value cache persisted as one JSON file per namespace. Values may be
 * `null` (e.g. "no match"), which is distinct from "not cached".
 */
export class JsonCache<T> {
  readonly #file: string | undefined;
  readonly #entries: Map<string, T>;
  #dirty = 0;

  /** Pass `dir` undefined for an in-memory cache (tests). */
  constructor(dir: string | undefined, namespace: string) {
    this.#file = dir === undefined ? undefined : join(dir, `${namespace}.json`);
    this.#entries = new Map();
    if (this.#file) {
      try {
        const data = JSON.parse(readFileSync(this.#file, 'utf8')) as Record<string, T>;
        for (const [k, v] of Object.entries(data)) this.#entries.set(k, v);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
      }
    }
  }

  has(key: string): boolean {
    return this.#entries.has(key);
  }

  get(key: string): T | undefined {
    return this.#entries.get(key);
  }

  set(key: string, value: T): void {
    this.#entries.set(key, value);
    if (++this.#dirty >= 50) this.save();
  }

  async getOrFetch(key: string, fetch: () => Promise<T>): Promise<T> {
    if (this.#entries.has(key)) return this.#entries.get(key)!;
    const value = await fetch();
    this.set(key, value);
    return value;
  }

  save(): void {
    if (!this.#file || this.#dirty === 0) return;
    mkdirSync(join(this.#file, '..'), { recursive: true });
    writeFileSync(this.#file, JSON.stringify(Object.fromEntries(this.#entries)));
    this.#dirty = 0;
  }
}
