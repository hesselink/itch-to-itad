import { ItchClient } from './client.ts';
import { mapWithConcurrency, pageUntilEmpty } from '../util.ts';
import {
  BundleGamesPageSchema,
  OwnedBundlesSchema,
  OwnedKeysPageSchema,
  type Bundle,
  type BundleGame,
  type ItchApiGame,
  type OwnedKey,
} from './schemas.ts';

export type GameSource =
  | { type: 'key'; keyId: number; purchaseId?: number }
  | { type: 'bundle'; bundleId: number; bundleTitle: string };

export interface ItchGame {
  id: number;
  title: string;
  url: string;
  developer?: string;
  developerUrl?: string;
  classification: string;
  platforms: string[];
  shortText?: string;
  publishedAt?: string;
  coverUrl?: string;
  sources: GameSource[];
}

export interface BundleSummary {
  id: number;
  title: string;
  url: string;
  gamesCount?: number;
  fetchedGames: number;
}

export interface ItchLibrary {
  fetchedAt: string;
  ownedKeyCount: number;
  bundles: BundleSummary[];
  /** Number of unique items dropped per non-game classification. */
  excludedByClassification: Record<string, number>;
  games: ItchGame[];
}

export interface BundleWithGames {
  bundle: Bundle;
  games: BundleGame[];
}

const PLATFORM_TRAITS: Record<string, string> = {
  p_windows: 'windows',
  p_osx: 'macos',
  p_linux: 'linux',
  p_android: 'android',
};

function platformsOf(game: ItchApiGame): string[] {
  const platforms = game.traits.flatMap((t) => PLATFORM_TRAITS[t] ?? []);
  if (game.type === 'html' || game.type === 'flash' || game.type === 'unity' || game.type === 'java') {
    platforms.push('web');
  }
  return platforms;
}

function normalise(game: ItchApiGame): Omit<ItchGame, 'sources'> {
  return {
    id: game.id,
    title: game.title,
    url: game.url,
    developer: game.user?.display_name ?? game.user?.username,
    developerUrl: game.user?.url,
    classification: game.classification,
    platforms: platformsOf(game),
    shortText: game.short_text,
    publishedAt: game.published_at,
    coverUrl: game.cover_url,
  };
}

/** Pure part of the library build: merge, dedupe and filter. */
export function buildLibrary(
  ownedKeys: OwnedKey[],
  bundles: BundleWithGames[],
  fetchedAt: Date = new Date(),
): ItchLibrary {
  const byId = new Map<number, ItchGame>();
  const add = (game: ItchApiGame, source: GameSource) => {
    const existing = byId.get(game.id);
    if (existing) {
      existing.sources.push(source);
    } else {
      byId.set(game.id, { ...normalise(game), sources: [source] });
    }
  };

  for (const key of ownedKeys) {
    add(key.game, { type: 'key', keyId: key.id, purchaseId: key.purchase_id });
  }
  for (const { bundle, games } of bundles) {
    for (const bg of games) {
      add(bg.game, { type: 'bundle', bundleId: bundle.id, bundleTitle: bundle.title });
    }
  }

  const excludedByClassification: Record<string, number> = {};
  const games: ItchGame[] = [];
  for (const game of byId.values()) {
    if (game.classification === 'game') {
      games.push(game);
    } else {
      excludedByClassification[game.classification] =
        (excludedByClassification[game.classification] ?? 0) + 1;
    }
  }
  games.sort((a, b) => a.title.localeCompare(b.title) || a.id - b.id);

  return {
    fetchedAt: fetchedAt.toISOString(),
    ownedKeyCount: ownedKeys.length,
    bundles: bundles.map(({ bundle, games }) => ({
      id: bundle.id,
      title: bundle.title,
      url: bundle.url,
      gamesCount: bundle.games_count,
      fetchedGames: games.length,
    })),
    excludedByClassification,
    games,
  };
}

export interface FetchLibraryOptions {
  concurrency?: number;
  log?: (message: string) => void;
}

export async function fetchLibrary(
  client: ItchClient,
  { concurrency = 3, log = () => {} }: FetchLibraryOptions = {},
): Promise<ItchLibrary> {
  const ownedKeys = await pageUntilEmpty(async (page) => {
    const res = await client.get(`/profile/owned-keys?page=${page}&per_page=500`, OwnedKeysPageSchema);
    log(`owned-keys page ${page}: ${res.owned_keys.length}`);
    return res.owned_keys;
  });

  const { bundle_keys } = await client.get('/profile/owned-bundles', OwnedBundlesSchema);
  // Repeat purchases of a bundle are supposedly deduped server-side, but be safe.
  const uniqueBundles = [...new Map(bundle_keys.map((k) => [k.bundle.id, k.bundle])).values()];
  log(`owned bundles: ${uniqueBundles.length}`);
  if (bundle_keys.length >= 100) {
    log('warning: owned-bundles returned 100 entries, which may be a server-side cap; some bundles may be missing');
  }

  const bundles = await mapWithConcurrency(uniqueBundles, concurrency, async (bundle) => {
    const games = await pageUntilEmpty(async (page) => {
      const res = await client.get(`/bundles/${bundle.id}/bundle-games?page=${page}`, BundleGamesPageSchema);
      return res.bundle_games;
    });
    log(`bundle "${bundle.title}": ${games.length} games`);
    return { bundle, games };
  });

  return buildLibrary(ownedKeys, bundles);
}
