import { describe, expect, it, vi } from 'vitest';
import { ItchClient } from '../../src/itch/client.ts';
import { mapWithConcurrency, pageUntilEmpty } from '../../src/util.ts';
import { buildLibrary, fetchLibrary } from '../../src/itch/library.ts';
import { OwnedKeySchema, BundleGameSchema } from '../../src/itch/schemas.ts';

// Shapes mirror real api.itch.io responses (snake_case, optional display_name etc.).
const rawGame = (id: number, title: string, extra: Record<string, unknown> = {}) => ({
  id,
  title,
  url: `https://dev.itch.io/game-${id}`,
  classification: 'game',
  type: 'default',
  traits: ['p_windows', 'p_osx', 'can_be_bought'],
  published_at: '2022-03-16T17:03:52Z',
  user: { id: 1, username: 'dev', url: 'https://dev.itch.io' },
  ...extra,
});

const ownedKey = (id: number, game: ReturnType<typeof rawGame>) =>
  OwnedKeySchema.parse({ id, game_id: game.id, purchase_id: 99, game });

const bundleGame = (bundleId: number, game: ReturnType<typeof rawGame>) =>
  BundleGameSchema.parse({ bundle_id: bundleId, game_id: game.id, game });

const bundle = { id: 1003, title: 'Example Charity Bundle', url: 'https://itch.io/b/1003', games_count: 2 };

describe('buildLibrary', () => {
  it('dedupes games owned via key and bundle, merging sources', () => {
    const shared = rawGame(1, 'Shared');
    const lib = buildLibrary(
      [ownedKey(10, shared)],
      [{ bundle, games: [bundleGame(1003, shared), bundleGame(1003, rawGame(2, 'Bundle Only'))] }],
      new Date('2026-01-01T00:00:00Z'),
    );
    expect(lib.games.map((g) => g.title)).toEqual(['Bundle Only', 'Shared']);
    expect(lib.games.find((g) => g.id === 1)!.sources).toEqual([
      { type: 'key', keyId: 10, purchaseId: 99 },
      { type: 'bundle', bundleId: 1003, bundleTitle: bundle.title },
    ]);
    expect(lib.bundles).toEqual([
      { id: 1003, title: bundle.title, url: bundle.url, gamesCount: 2, fetchedGames: 2 },
    ]);
  });

  it('keeps only classification "game" and counts the rest', () => {
    const lib = buildLibrary(
      [
        ownedKey(1, rawGame(1, 'Game')),
        ownedKey(2, rawGame(2, 'OST', { classification: 'soundtrack' })),
        ownedKey(3, rawGame(3, 'Sprites', { classification: 'assets' })),
      ],
      [{ bundle, games: [bundleGame(1003, rawGame(4, 'More sprites', { classification: 'assets' }))] }],
    );
    expect(lib.games.map((g) => g.id)).toEqual([1]);
    expect(lib.excludedByClassification).toEqual({ soundtrack: 1, assets: 2 });
  });

  it('normalises developer and platforms', () => {
    const lib = buildLibrary(
      [
        ownedKey(1, rawGame(1, 'A', { user: { id: 1, username: 'dev', display_name: 'Dev Studio', url: 'u' } })),
        // itch sends empty traits as `{}` rather than `[]`
        ownedKey(2, rawGame(2, 'B', { type: 'html', traits: {} })),
      ],
      [],
    );
    const [a, b] = lib.games;
    expect(a!.developer).toBe('Dev Studio');
    expect(a!.platforms).toEqual(['windows', 'macos']);
    expect(b!.developer).toBe('dev');
    expect(b!.platforms).toEqual(['web']);
  });
});

describe('pageUntilEmpty', () => {
  it('continues past short pages and stops on an empty one', async () => {
    const pages = [[1, 2], [3], []];
    const fetchPage = vi.fn(async (p: number) => pages[p - 1] ?? []);
    expect(await pageUntilEmpty(fetchPage)).toEqual([1, 2, 3]);
    expect(fetchPage).toHaveBeenCalledTimes(3);
  });
});

describe('mapWithConcurrency', () => {
  it('preserves order and respects the limit', async () => {
    let inFlight = 0;
    let max = 0;
    const out = await mapWithConcurrency([1, 2, 3, 4, 5], 2, async (n) => {
      inFlight++;
      max = Math.max(max, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
      return n * 10;
    });
    expect(out).toEqual([10, 20, 30, 40, 50]);
    expect(max).toBe(2);
  });
});

describe('fetchLibrary', () => {
  it('pages through owned keys and bundle games, retrying on 429', async () => {
    const json = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    let rateLimited = false;
    const fakeFetch = vi.fn(async (input: string | URL | Request, _init?: RequestInit) => {
      const url = new URL(String(input));
      const page = Number(url.searchParams.get('page'));
      if (url.pathname === '/profile/owned-keys') {
        return json({ page, per_page: 500, owned_keys: page === 1 ? [{ id: 10, game_id: 1, game: rawGame(1, 'Key Game') }] : {} });
      }
      if (url.pathname === '/profile/owned-bundles') {
        return json({ bundle_keys: [{ id: 5, bundle_id: 1003, bundle }] });
      }
      if (url.pathname === '/bundles/1003/bundle-games') {
        if (page === 2 && !rateLimited) {
          rateLimited = true;
          return json({ errors: ['rate limited'] }, 429);
        }
        const games = page <= 2 ? [{ bundle_id: 1003, game_id: page + 1, game: rawGame(page + 1, `Bundle ${page}`) }] : {};
        return json({ page, per_page: 100, bundle_games: games });
      }
      return json({ errors: ['not found'] }, 404);
    });

    const client = new ItchClient({ apiKey: 'test', fetch: fakeFetch as typeof fetch, retryDelayMs: 1 });
    const lib = await fetchLibrary(client);

    expect(lib.games.map((g) => g.id).sort()).toEqual([1, 2, 3]);
    expect(lib.bundles[0]!.fetchedGames).toBe(2);
    expect(rateLimited).toBe(true);
    const auth = (fakeFetch.mock.calls[0]![1] as RequestInit).headers as Record<string, string>;
    expect(auth.Authorization).toBe('Bearer test');
  });

  it('fails loudly on an unexpected response shape', async () => {
    const fakeFetch = async () => new Response(JSON.stringify({ ownedKeys: [] }), { status: 200 });
    const client = new ItchClient({ apiKey: 'k', fetch: fakeFetch as typeof fetch });
    await expect(fetchLibrary(client)).rejects.toThrow(/Unexpected response shape/);
  });
});
