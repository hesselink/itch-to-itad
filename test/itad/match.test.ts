import { describe, expect, it, vi } from 'vitest';
import { HttpError } from '../../src/http.ts';
import type { ItchGame } from '../../src/itch/library.ts';
import { matchGames, reviewMarkdown, summarise, type MatchApi } from '../../src/itad/match.ts';
import type { GameInfo, SearchResult } from '../../src/itad/schemas.ts';

const itch = (id: number, title: string, developer: string, sub = developer.toLowerCase()): ItchGame => ({
  id,
  title,
  url: `https://${sub}.itch.io/g${id}`,
  developer,
  developerUrl: `https://${sub}.itch.io`,
  classification: 'game',
  platforms: [],
  sources: [],
});

const info = (id: string, title: string, developers: string[], publishers: string[] = [], type = 'game'): GameInfo => ({
  id,
  slug: title.toLowerCase().replace(/\W+/g, '-'),
  title,
  type,
  releaseDate: '2022-01-01',
  developers: developers.map((name, i) => ({ id: i, name })),
  publishers: publishers.map((name, i) => ({ id: 100 + i, name })),
});

function fakeApi(
  titles: Record<string, string>,
  infos: GameInfo[],
  searches: Record<string, SearchResult[]> = {},
) {
  const byId = new Map(infos.map((i) => [i.id, i]));
  return {
    lookupTitles: vi.fn(async (ts: string[]) => Object.fromEntries(ts.map((t) => [t, titles[t] ?? null]))),
    search: vi.fn(async (t: string) => searches[t] ?? []),
    gameInfo: vi.fn(async (id: string) => {
      const i = byId.get(id);
      if (!i) throw new HttpError(404, id, 'not found');
      return i;
    }),
  } satisfies MatchApi;
}

describe('matchGames', () => {
  it('confirms a title match only when developer or publisher matches', async () => {
    const api = fakeApi(
      { TUNIC: 'tunic-id', Ghost: 'other-ghost', 'TUNIC Team': 'x' },
      [
        info('tunic-id', 'TUNIC', ['ISOMETRICORP Games Ltd.', 'TUNIC Team'], ['Finji']),
        info('other-ghost', 'Ghost', ['Big AAA Studio'], ['Mega Publisher']),
      ],
    );
    const res = await matchGames(api, [itch(1, 'TUNIC', 'Finji'), itch(2, 'Ghost', 'tiny indie dev', 'tinyindie')]);
    expect(res[0]).toMatchObject({ status: 'confirmed', itadId: 'tunic-id', itadTitle: 'TUNIC', syncTitleSafe: true });
    // The "Ghost" false positive is rejected by the developer check
    expect(res[1]).toMatchObject({ status: 'review' });
    expect(res[1]!.candidates).toHaveLength(1);
    expect(res[1]!.candidates[0]!.companyMatch).toBe(false);
  });

  it('uses title variants for the exact lookup', async () => {
    const api = fakeApi({ Celeste: 'celeste' }, [info('celeste', 'Celeste', ['Maddy Makes Games'], ['Matt Makes Games'])]);
    const [r] = await matchGames(api, [itch(1, 'Celeste™', 'Maddy Makes Games', 'maddymakesgames')]);
    expect(r).toMatchObject({ status: 'confirmed', itadId: 'celeste' });
  });

  it('falls back to search, keeping only near-identical game titles', async () => {
    const api = fakeApi(
      { 'Hollow Knight': 'hk' },
      [info('hk', 'Hollow Knight', ['Team Cherry'])],
      {
        'hollow knight': [
          { id: 'hk', slug: 'hollow-knight', title: 'Hollow Knight', type: 'game' },
          { id: 'hks', slug: 'silksong', title: 'Hollow Knight: Silksong', type: 'game' },
          { id: 'hkdlc', slug: 'hk-ost', title: 'Hollow Knight', type: 'dlc' },
        ],
      },
    );
    const [r] = await matchGames(api, [itch(1, 'hollow knight', 'Team Cherry', 'teamcherry')]);
    expect(r).toMatchObject({ status: 'confirmed', itadId: 'hk' });
    expect(r!.candidates.map((c) => [c.id, c.via])).toEqual([['hk', 'search']]);
    expect(api.gameInfo).not.toHaveBeenCalledWith('hks');
  });

  it('marks multiple passing candidates for review and missing games as unmatched', async () => {
    // "Twin (Demo)" and its variant "Twin" resolve to two different ITAD games by the same dev.
    const api = fakeApi({ 'Twin (Demo)': 'b', Twin: 'a' }, [info('a', 'Twin', ['Dev']), info('b', 'Twin (Demo)', ['Dev'])]);
    const res = await matchGames(api, [itch(1, 'Twin (Demo)', 'Dev'), itch(2, 'Nothing Like This', 'Dev')]);
    expect(res[0]!.status).toBe('review');
    expect(res[0]!.candidates.map((c) => c.id).sort()).toEqual(['a', 'b']);
    expect(res[1]!.status).toBe('unmatched');
  });

  it('applies overrides: forcing a match or excluding a game', async () => {
    const api = fakeApi({ Ghost: 'other-ghost' }, [info('real-ghost', 'Ghost (2019)', ['tiny indie dev'])]);
    const res = await matchGames(api, [itch(1, 'Ghost', 'tiny indie dev'), itch(2, 'Skip Me', 'x')], {
      overrides: { '1': 'real-ghost', '2': null },
    });
    expect(res[0]).toMatchObject({ status: 'override', itadId: 'real-ghost', itadTitle: 'Ghost (2019)' });
    expect(res[1]).toMatchObject({ status: 'excluded' });
    // Overridden games are not looked up by title at all
    expect(api.lookupTitles.mock.calls.flat(2)).not.toContain('Ghost');
  });

  it('flags matches whose ITAD title resolves to a different game', async () => {
    const api = fakeApi(
      { 'Same Name': 'popular-same-name' },
      [info('indie-same-name', 'Same Name', ['Indie']), info('popular-same-name', 'Same Name', ['AAA'])],
      { 'same name!': [{ id: 'indie-same-name', slug: 'same-name-2', title: 'Same Name', type: 'game' }] },
    );
    const [r] = await matchGames(api, [itch(1, 'same name!', 'Indie')]);
    // Lookup of "same name!" misses, search finds the indie game, but ITAD's
    // title "Same Name" resolves to the popular one.
    expect(r).toMatchObject({ status: 'confirmed', itadId: 'indie-same-name', syncTitleSafe: false });
    expect(summarise([r!]).syncTitleUnsafe).toBe(1);
  });

  it('only calls the API once per title/id thanks to the cache', async () => {
    const api = fakeApi({ A: 'a' }, [info('a', 'A', ['Dev'])]);
    await matchGames(api, [itch(1, 'A', 'Dev'), itch(2, 'A', 'Dev')]);
    expect(api.gameInfo).toHaveBeenCalledTimes(1);
  });
});

describe('reviewMarkdown', () => {
  it('lists review and unmatched games with ITAD ids', async () => {
    const api = fakeApi({ Ghost: 'other-ghost' }, [info('other-ghost', 'Ghost', ['AAA'])]);
    const md = reviewMarkdown(await matchGames(api, [itch(1, 'Ghost', 'indie'), itch(2, 'Nope', 'indie')]));
    expect(md).toContain('## Review (1)');
    expect(md).toContain('`other-ghost`');
    expect(md).toContain('## Unmatched (1)');
    expect(md).toContain('[Nope](https://indie.itch.io/g2)');
  });
});
