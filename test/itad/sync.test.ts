import { describe, expect, it, vi } from 'vitest';
import type { GameMatch } from '../../src/itad/match.ts';
import type { Copy, NewCopy, SyncEntry } from '../../src/itad/schemas.ts';
import { applyDirectCopies, applyProfileSync, planSync, type SyncApi } from '../../src/itad/sync.ts';

const match = (itchId: number, status: GameMatch['status'], itadId?: string, safe = true): GameMatch => ({
  itchId,
  itchTitle: `itch ${itchId}`,
  itchUrl: `https://dev.itch.io/${itchId}`,
  status,
  itadId,
  itadTitle: itadId ? `ITAD ${itadId}` : undefined,
  syncTitleSafe: itadId ? safe : undefined,
  candidates: [],
});

const matches = [
  match(1, 'confirmed', 'a'),
  match(2, 'override', 'b'),
  match(3, 'confirmed', 'c', false), // ambiguous ITAD title
  match(4, 'review'),
  match(5, 'unmatched'),
  match(6, 'excluded'),
  match(7, 'confirmed', 'a'), // second itch game mapping to the same ITAD game
];

describe('planSync', () => {
  it('sends only confirmed/override matches, using ITAD titles, and diverts ambiguous ones', () => {
    const plan = planSync(matches, { mode: 'profile' });
    expect(plan.syncEntries).toEqual([
      { shop: 44, id: '1', title: 'ITAD a' },
      { shop: 44, id: '2', title: 'ITAD b' },
    ]);
    expect(plan.direct).toEqual([{ itadId: 'c', itchTitle: 'itch 3', itchUrl: 'https://dev.itch.io/3' }]);
    expect([...plan.expectedIds]).toEqual(['a', 'b', 'c']);
  });

  it('puts everything in direct mode when there is no profile', () => {
    const plan = planSync(matches, { mode: 'direct' });
    expect(plan.syncEntries).toEqual([]);
    expect(plan.direct.map((d) => d.itadId)).toEqual(['a', 'b', 'c']);
  });

  it('applies a limit', () => {
    const plan = planSync(matches, { mode: 'profile', limit: 1 });
    expect(plan.syncEntries).toHaveLength(1);
    expect([...plan.expectedIds]).toEqual(['a']);
  });
});

const copy = (id: number, gameId: string, opts: { shop?: number; tags?: string[] } = {}): Copy => ({
  id,
  game: { id: gameId },
  shop: opts.shop === undefined ? null : { id: opts.shop },
  redeemed: true,
  note: null,
  tags: (opts.tags ?? []).map((tag, i) => ({ id: i, tag })),
});

function fakeApi(initialCopies: Copy[] = [], collection: { id: string; title: string }[] = []) {
  let copies = [...initialCopies];
  let games = [...collection];
  let nextId = 1000;
  return {
    collectionGames: vi.fn(async () => games),
    copies: vi.fn(async () => copies),
    addCopies: vi.fn(async (newCopies: NewCopy[]) => {
      for (const c of newCopies) copies.push(copy(nextId++, c.gameId, { shop: c.shop ?? undefined, tags: c.tags ?? [] }));
      return undefined;
    }),
    deleteCopies: vi.fn(async (ids: number[]) => {
      copies = copies.filter((c) => !ids.includes(c.id));
      return undefined;
    }),
    syncCollection: vi.fn(async (_token: string, entries: SyncEntry[]) => {
      games = [...games, ...entries.map((e) => ({ id: e.title.replace('ITAD ', ''), title: e.title }))];
      return { total: entries.length, added: entries.length, removed: 0 };
    }),
  } satisfies SyncApi;
}

describe('applyDirectCopies', () => {
  const direct = [
    { itadId: 'a', itchTitle: 'A', itchUrl: 'https://x.itch.io/a' },
    { itadId: 'b', itchTitle: 'B', itchUrl: 'https://x.itch.io/b' },
  ];

  it('adds tagged itch copies, skipping games that already have one', async () => {
    const api = fakeApi([copy(1, 'a', { shop: 44 }), copy(2, 'b', { shop: 61 })]);
    const r = await applyDirectCopies(api, direct, { allExpectedIds: new Set(['a', 'b']) });
    expect(api.addCopies).toHaveBeenCalledWith([
      { gameId: 'b', redeemed: true, shop: 44, tags: ['itch'], note: 'https://x.itch.io/b' },
    ]);
    expect(r).toMatchObject({ added: 1, alreadyPresent: 1, missing: [], stale: [], pruned: 0 });
  });

  it('is idempotent on re-run', async () => {
    const api = fakeApi();
    await applyDirectCopies(api, direct, { allExpectedIds: new Set(['a', 'b']) });
    const r = await applyDirectCopies(api, direct, { allExpectedIds: new Set(['a', 'b']) });
    expect(r.added).toBe(0);
    expect(api.addCopies).toHaveBeenCalledTimes(1);
  });

  it('reports stale itch-tagged copies and only deletes them with prune', async () => {
    const initial = [copy(1, 'gone', { shop: 44, tags: ['itch'] }), copy(2, 'steam-game', { shop: 61 }), copy(3, 'untagged', { shop: 44 })];
    const api = fakeApi(initial);
    const r1 = await applyDirectCopies(api, [], { allExpectedIds: new Set() });
    expect(r1.stale.map((c) => c.id)).toEqual([1]);
    expect(api.deleteCopies).not.toHaveBeenCalled();

    const r2 = await applyDirectCopies(api, [], { allExpectedIds: new Set(), prune: true });
    expect(r2.pruned).toBe(1);
    expect(api.deleteCopies).toHaveBeenCalledWith([1]);
  });
});

describe('applyProfileSync', () => {
  it('diffs the collection before and after', async () => {
    const api = fakeApi([], [{ id: 'old', title: 'Old' }]);
    api.syncCollection.mockImplementationOnce(async () => {
      // ITAD matched "ITAD b" to a different game
      (await api.collectionGames()).push({ id: 'a', title: 'ITAD a' }, { id: 'wrong', title: 'ITAD b' });
      return { total: 2, added: 2, removed: 0 };
    });
    const r = await applyProfileSync(
      api,
      'tok',
      [
        { shop: 44, id: '1', title: 'ITAD a' },
        { shop: 44, id: '2', title: 'ITAD b' },
      ],
      new Set(['a', 'b']),
    );
    expect(api.syncCollection).toHaveBeenCalledWith('tok', expect.any(Array));
    expect(r.missing).toEqual(['b']);
    expect(r.unexpected).toEqual([{ id: 'wrong', title: 'ITAD b' }]);
  });
});
