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

export function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** Spaces calls so that at most one starts every `intervalMs`. */
export class Throttle {
  readonly #intervalMs: number;
  #nextSlot = 0;
  constructor(requestsPerSecond: number) {
    this.#intervalMs = 1000 / requestsPerSecond;
  }
  async wait(): Promise<void> {
    const now = Date.now();
    const slot = Math.max(now, this.#nextSlot);
    this.#nextSlot = slot + this.#intervalMs;
    if (slot > now) await new Promise((resolve) => setTimeout(resolve, slot - now));
  }
}
