import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ItchLibrary } from '../../src/itch/library.ts';
import type { Candidate, GameMatch } from '../../src/itad/match.ts';
import {
  applyDecision,
  buildReviewItems,
  readOverrides,
  validateDecision,
  writeOverrides,
} from '../../src/review/data.ts';

const ID = '018d937f-62f2-705d-be60-33c317e9bf7e';

const cand = (over: Partial<Candidate> = {}): Candidate => ({
  id: ID, slug: 's', title: 'T', type: null, developers: [], publishers: [], via: 'lookup', companyMatch: false, ...over,
});
const match = (itchId: number, status: GameMatch['status'], candidates: Candidate[] = []): GameMatch => ({
  itchId, itchTitle: `Game ${itchId}`, itchUrl: `https://x.itch.io/${itchId}`, status, candidates,
});

const library: ItchLibrary = {
  fetchedAt: '', ownedKeyCount: 0, bundles: [], excludedByClassification: {},
  games: [
    { id: 1, title: 'Game 1', url: '', classification: 'game', platforms: [], coverUrl: 'c1',
      sources: [{ type: 'bundle', bundleId: 1003, bundleTitle: 'Example Bundle' }, { type: 'key', keyId: 9 }] },
  ],
};

describe('buildReviewItems', () => {
  it('includes review, unmatched and previously decided games, with a reason', () => {
    const items = buildReviewItems(
      [
        match(1, 'review', [cand()]),
        match(2, 'review', [cand({ developers: ['Someone'] })]),
        match(3, 'review', [cand({ companyMatch: true }), cand({ id: 'b', sharedBundle: 'X' })]),
        match(4, 'unmatched'),
        match(5, 'confirmed', [cand({ companyMatch: true })]),
        match(6, 'override', [cand()]),
      ],
      library,
      { '6': ID },
    );
    expect(items.map((i) => [i.itchId, i.reason])).toEqual([
      [1, 'no-data'], [2, 'mismatch'], [3, 'multiple'], [4, 'unmatched'], [6, 'decided'],
    ]);
    expect(items[0]).toMatchObject({ coverUrl: 'c1', sources: ['Example Bundle', 'Owned key'] });
  });
});

describe('decisions', () => {
  const known = new Set([1]);

  it('validates input from the page', () => {
    expect(validateDecision({ itchId: 1, itadId: ID }, known)).toBeUndefined();
    expect(validateDecision({ itchId: 1, itadId: null }, known)).toBeUndefined();
    expect(validateDecision({ itchId: 1, clear: true }, known)).toBeUndefined();
    expect(validateDecision({ itchId: 2, itadId: ID }, known)).toMatch(/unknown/);
    expect(validateDecision({ itchId: 1, itadId: 'not-a-uuid' }, known)).toMatch(/UUID/);
    expect(validateDecision({ itchId: 1 }, known)).toMatch(/UUID/);
    expect(validateDecision('x', known)).toBeDefined();
  });

  it('applies accept, skip and clear without mutating the input', () => {
    const start = { '7': ID };
    const accepted = applyDecision(start, { itchId: 1, itadId: ID });
    expect(accepted).toEqual({ '7': ID, '1': ID });
    expect(applyDecision(accepted, { itchId: 1, itadId: null })).toEqual({ '7': ID, '1': null });
    expect(applyDecision(accepted, { itchId: 1, clear: true })).toEqual({ '7': ID });
    expect(start).toEqual({ '7': ID });
  });

  it('round-trips overrides through disk, sorted by itch id', async () => {
    const file = join(await mkdtemp(join(tmpdir(), 'overrides-')), 'o.json');
    expect(await readOverrides(file)).toEqual({});
    await writeOverrides(file, { '20': null, '3': ID });
    expect(await readOverrides(file)).toEqual({ '3': ID, '20': null });
    expect((await readFile(file, 'utf8')).indexOf('"3"')).toBeLessThan((await readFile(file, 'utf8')).indexOf('"20"'));
  });
});
