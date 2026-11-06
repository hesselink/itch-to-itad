import { HttpError } from '../http.ts';
import type { ItchGame } from '../itch/library.ts';
import { chunk, mapWithConcurrency } from '../util.ts';
import { JsonCache } from './cache.ts';
import type { ItadClient } from './client.ts';
import { companiesMatch, itchSubdomain, titlesMatch, titleVariants } from './normalise.ts';
import type { GameInfo, SearchResult } from './schemas.ts';

/** The subset of ItadClient that matching needs (easy to fake in tests). */
export type MatchApi = Pick<ItadClient, 'lookupTitles' | 'search' | 'gameInfo' | 'gameBundles'>;

export type MatchStatus = 'confirmed' | 'override' | 'review' | 'unmatched' | 'excluded';

export interface Candidate {
  id: string;
  slug: string;
  title: string;
  type: string | null;
  releaseDate?: string | null;
  developers: string[];
  publishers: string[];
  via: 'lookup' | 'search';
  /** A developer/publisher matches the itch developer. */
  companyMatch: boolean;
  /** Title of an itch bundle that ITAD also lists this game in, if any. */
  sharedBundle?: string;
}

export interface GameMatch {
  itchId: number;
  itchTitle: string;
  itchUrl: string;
  itchDeveloper?: string;
  itchPublishedAt?: string;
  status: MatchStatus;
  /** Set for confirmed and override. */
  itadId?: string;
  itadTitle?: string;
  /**
   * True if ITAD's exact-title lookup of `itadTitle` resolves to `itadId`,
   * i.e. profile sync (which matches by title) will land on the right game.
   */
  syncTitleSafe?: boolean;
  candidates: Candidate[];
}

/** itch game id → ITAD game id to force a match, or null to exclude the game. */
export type Overrides = Record<string, string | null>;

export interface MatchCaches {
  lookup: JsonCache<string | null>;
  search: JsonCache<SearchResult[]>;
  info: JsonCache<GameInfo | null>;
  /** ITAD game id → itch bundle ids ITAD lists it in. */
  bundles: JsonCache<number[]>;
}

export function memoryCaches(): MatchCaches {
  return {
    lookup: new JsonCache(undefined, 'lookup'),
    search: new JsonCache(undefined, 'search'),
    info: new JsonCache(undefined, 'info'),
    bundles: new JsonCache(undefined, 'bundles'),
  };
}

export function diskCaches(dir: string): MatchCaches {
  return {
    lookup: new JsonCache(dir, 'lookup-title'),
    search: new JsonCache(dir, 'search'),
    info: new JsonCache(dir, 'game-info'),
    bundles: new JsonCache(dir, 'game-bundles'),
  };
}

const saveAll = (c: MatchCaches) => {
  c.lookup.save();
  c.search.save();
  c.info.save();
  c.bundles.save();
};

const ITCH_BUNDLE_URL = /^https?:\/\/itch\.io\/b\/(\d+)\//;

const itchBundleIds = (g: ItchGame) =>
  new Map(g.sources.flatMap((s) => (s.type === 'bundle' ? [[s.bundleId, s.bundleTitle] as const] : [])));

const LOOKUP_BATCH = 200;
const SEARCH_RESULTS = 10;

async function lookupTitles(api: MatchApi, cache: MatchCaches['lookup'], titles: string[]) {
  const missing = [...new Set(titles)].filter((t) => !cache.has(t));
  for (const batch of chunk(missing, LOOKUP_BATCH)) {
    const res = await api.lookupTitles(batch);
    for (const t of batch) cache.set(t, res[t] ?? null);
  }
  cache.save();
}

const itchCompanyNames = (g: ItchGame) =>
  [g.developer, itchSubdomain(g.developerUrl)].filter((n): n is string => !!n);

export interface MatchOptions {
  overrides?: Overrides;
  caches?: MatchCaches;
  concurrency?: number;
  log?: (message: string) => void;
}

export async function matchGames(
  api: MatchApi,
  games: readonly ItchGame[],
  { overrides = {}, caches = memoryCaches(), concurrency = 3, log = () => {} }: MatchOptions = {},
): Promise<GameMatch[]> {
  const toMatch = games.filter((g) => !(String(g.id) in overrides));

  // 1. Exact-title lookup (bulk) on each game's title variants.
  const variants = new Map(toMatch.map((g) => [g.id, titleVariants(g.title)]));
  await lookupTitles(api, caches.lookup, [...variants.values()].flat());
  const candidateIds = new Map<number, Map<string, 'lookup' | 'search'>>();
  for (const g of toMatch) {
    const ids = new Map<string, 'lookup' | 'search'>();
    for (const v of variants.get(g.id)!) {
      const id = caches.lookup.get(v);
      if (id) ids.set(id, 'lookup');
    }
    candidateIds.set(g.id, ids);
  }
  log(`title lookup: ${[...candidateIds.values()].filter((s) => s.size > 0).length}/${toMatch.length} games have a candidate`);

  // 2. Fuzzy search for the rest, keeping only near-identical titles.
  const needSearch = toMatch.filter((g) => candidateIds.get(g.id)!.size === 0);
  let searched = 0;
  await mapWithConcurrency(needSearch, concurrency, async (g) => {
    const results = await caches.search.getOrFetch(g.title, () => api.search(g.title, SEARCH_RESULTS));
    const ids = candidateIds.get(g.id)!;
    for (const r of results) {
      if ((r.type === 'game' || r.type === null) && variants.get(g.id)!.some((v) => titlesMatch(v, r.title))) {
        ids.set(r.id, 'search');
      }
    }
    if (++searched % 100 === 0) log(`search: ${searched}/${needSearch.length}`);
  });
  caches.search.save();

  // 3. Fetch developer/publisher info for every candidate (and every override).
  const allIds = new Set<string>();
  for (const ids of candidateIds.values()) for (const id of ids.keys()) allIds.add(id);
  for (const id of Object.values(overrides)) if (id) allIds.add(id);
  let fetched = 0;
  await mapWithConcurrency([...allIds], concurrency, async (id) => {
    await caches.info.getOrFetch(id, async () => {
      try {
        return await api.gameInfo(id);
      } catch (e) {
        if (e instanceof HttpError && e.status === 404) return null;
        throw e;
      }
    });
    if (++fetched % 100 === 0) log(`game info: ${fetched}/${allIds.size}`);
  });
  caches.info.save();

  // 3b. For games whose candidates aren't confirmed by developer/publisher,
  //     check whether ITAD lists the candidate in an itch bundle the game
  //     came from. That is strong evidence it's the same game.
  const companyConfirmed = (g: ItchGame, id: string) => {
    const info = caches.info.get(id);
    return !!info && companiesMatch(itchCompanyNames(g), [...info.developers, ...info.publishers].map((d) => d.name));
  };
  const needBundles = new Set<string>();
  for (const g of toMatch) {
    if (itchBundleIds(g).size === 0) continue;
    const ids = [...candidateIds.get(g.id)!.keys()].filter((id) => caches.info.get(id));
    if (ids.some((id) => companyConfirmed(g, id))) continue;
    for (const id of ids) needBundles.add(id);
  }
  let bundlesFetched = 0;
  await mapWithConcurrency([...needBundles], concurrency, async (id) => {
    await caches.bundles.getOrFetch(id, async () => {
      const bundles = await api.gameBundles(id);
      return bundles.flatMap((b) => {
        const m = ITCH_BUNDLE_URL.exec(b.url);
        return m ? [Number(m[1])] : [];
      });
    });
    if (++bundlesFetched % 100 === 0) log(`game bundles: ${bundlesFetched}/${needBundles.size}`);
  });
  caches.bundles.save();

  // 4. Classify.
  const results: GameMatch[] = games.map((g) => {
    const base = {
      itchId: g.id,
      itchTitle: g.title,
      itchUrl: g.url,
      itchDeveloper: g.developer,
      itchPublishedAt: g.publishedAt,
    };
    const itchNames = itchCompanyNames(g);
    const ownBundles = itchBundleIds(g);
    const toCandidate = (id: string, via: Candidate['via']): Candidate | undefined => {
      const info = caches.info.get(id);
      if (!info) return undefined;
      const developers = info.developers.map((d) => d.name);
      const publishers = info.publishers.map((p) => p.name);
      const shared = (caches.bundles.get(id) ?? []).find((b) => ownBundles.has(b));
      return {
        id,
        slug: info.slug,
        title: info.title,
        type: info.type,
        releaseDate: info.releaseDate,
        developers,
        publishers,
        via,
        companyMatch: companiesMatch(itchNames, [...developers, ...publishers]),
        sharedBundle: shared === undefined ? undefined : ownBundles.get(shared),
      };
    };

    const key = String(g.id);
    if (key in overrides) {
      const id = overrides[key];
      if (id === null || id === undefined) return { ...base, status: 'excluded', candidates: [] };
      const c = toCandidate(id, 'lookup');
      return { ...base, status: 'override', itadId: id, itadTitle: c?.title, candidates: c ? [c] : [] };
    }

    const candidates = [...candidateIds.get(g.id)!].flatMap(([id, via]) => toCandidate(id, via) ?? []);
    const passing = candidates.filter(
      (c) => (c.companyMatch || c.sharedBundle !== undefined) && (c.type === 'game' || c.type === null),
    );
    if (passing.length === 1) {
      return { ...base, status: 'confirmed', itadId: passing[0]!.id, itadTitle: passing[0]!.title, candidates };
    }
    return { ...base, status: candidates.length > 0 ? 'review' : 'unmatched', candidates };
  });

  // 5. Check that ITAD's own title resolves back to the chosen game, so that
  //    title-based profile sync can't land on a same-named different game.
  const chosen = results.filter((r) => r.itadId && r.itadTitle);
  await lookupTitles(api, caches.lookup, chosen.map((r) => r.itadTitle!));
  for (const r of chosen) r.syncTitleSafe = caches.lookup.get(r.itadTitle!) === r.itadId;

  saveAll(caches);
  return results;
}

export function summarise(matches: readonly GameMatch[]): Record<MatchStatus, number> & { syncTitleUnsafe: number } {
  const counts = { confirmed: 0, override: 0, review: 0, unmatched: 0, excluded: 0, syncTitleUnsafe: 0 };
  for (const m of matches) {
    counts[m.status]++;
    if (m.itadId && !m.syncTitleSafe) counts.syncTitleUnsafe++;
  }
  return counts;
}

const md = (s: string) => s.replace(/\|/g, '\\|').replace(/\n/g, ' ');
const itadLink = (c: { slug: string; title: string }) => `[${md(c.title)}](https://isthereanydeal.com/game/${c.slug}/info/)`;

/** Human-readable report of games that need a decision. */
export function reviewMarkdown(matches: readonly GameMatch[]): string {
  const lines: string[] = [
    '# itch → ITAD matches needing review',
    '',
    'To resolve a game, add it to `data/itad-overrides.json`:',
    '`{ "<itch id>": "<ITAD id>" }` to accept a candidate, or `{ "<itch id>": null }` to skip the game.',
    '',
  ];
  const review = matches.filter((m) => m.status === 'review');
  lines.push(`## Review (${review.length})`, '', 'Title matches, but developer/publisher did not confirm exactly one candidate.', '');
  lines.push('| itch id | itch game | itch developer | candidates (ITAD id — developers / publishers) |', '|---|---|---|---|');
  for (const m of review) {
    const cands = m.candidates
      .map((c) => `${itadLink(c)} \`${c.id}\` — ${md(c.developers.join(', ') || '?')} / ${md(c.publishers.join(', ') || '?')}${c.releaseDate ? ` (${c.releaseDate.slice(0, 4)})` : ''}${c.companyMatch ? ' ✅ developer' : ''}${c.sharedBundle ? ` ✅ in ${md(c.sharedBundle)}` : ''}`)
      .join('<br>');
    lines.push(`| ${m.itchId} | [${md(m.itchTitle)}](${m.itchUrl}) | ${md(m.itchDeveloper ?? '')} | ${cands} |`);
  }
  const unsafe = matches.filter((m) => m.itadId && !m.syncTitleSafe);
  lines.push('', `## Matched, but ITAD title is ambiguous (${unsafe.length})`, '', 'These are added as direct copies instead of through profile sync.', '');
  lines.push('| itch id | itch game | ITAD game |', '|---|---|---|');
  for (const m of unsafe) {
    const c = m.candidates.find((c) => c.id === m.itadId);
    lines.push(`| ${m.itchId} | [${md(m.itchTitle)}](${m.itchUrl}) | ${c ? itadLink(c) : m.itadId} |`);
  }
  const unmatched = matches.filter((m) => m.status === 'unmatched');
  lines.push('', `## Unmatched (${unmatched.length})`, '', 'No ITAD game with this title was found. Most are probably itch-only games.', '');
  lines.push('| itch id | itch game | itch developer |', '|---|---|---|');
  for (const m of unmatched) lines.push(`| ${m.itchId} | [${md(m.itchTitle)}](${m.itchUrl}) | ${md(m.itchDeveloper ?? '')} |`);
  return lines.join('\n') + '\n';
}
