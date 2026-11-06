import type { ItadClient } from '../itad/client.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export type ItadRef = { kind: 'id'; id: string } | { kind: 'slug'; slug: string };

/**
 * Parses what a user pastes to identify an ITAD game: a game id (UUID), a
 * game page URL (https://isthereanydeal.com/game/<slug>/info/), or a slug.
 */
export function parseItadRef(input: string): ItadRef | undefined {
  const s = input.trim();
  if (UUID.test(s)) return { kind: 'id', id: s.toLowerCase() };
  if (/^https?:\/\//i.test(s)) {
    try {
      const url = new URL(s);
      if (!/(^|\.)isthereanydeal\.com$/i.test(url.hostname)) return undefined;
      const m = /^\/game\/([^/]+)/.exec(url.pathname);
      return m && SLUG.test(m[1]!) ? { kind: 'slug', slug: m[1]! } : undefined;
    } catch {
      return undefined;
    }
  }
  const slug = s.toLowerCase();
  return SLUG.test(slug) ? { kind: 'slug', slug } : undefined;
}

export interface ResolvedGame {
  id: string;
  title: string;
  slug: string;
}

/**
 * ITAD has no slug lookup, but search results include slugs: search for the
 * slug's words and pick the result with exactly that slug. Slugs of
 * same-named games get a numeric suffix ("same-name-2"), so also search
 * without it.
 */
export async function resolveSlug(api: Pick<ItadClient, 'search'>, slug: string): Promise<ResolvedGame | undefined> {
  const queries = [slug.replace(/-/g, ' ')];
  const withoutSuffix = slug.replace(/-\d+$/, '');
  if (withoutSuffix !== slug) queries.push(withoutSuffix.replace(/-/g, ' '));
  for (const q of queries) {
    const hit = (await api.search(q, 100)).find((r) => r.slug === slug);
    if (hit) return { id: hit.id, title: hit.title, slug: hit.slug };
  }
  return undefined;
}
