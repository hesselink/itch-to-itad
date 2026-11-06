import { readFile, rename, writeFile } from 'node:fs/promises';
import type { ItchLibrary } from '../itch/library.ts';
import type { Candidate, GameMatch, Overrides } from '../itad/match.ts';

export interface ReviewItem {
  itchId: number;
  itchTitle: string;
  itchUrl: string;
  itchDeveloper?: string;
  itchPublishedAt?: string;
  coverUrl?: string;
  /** "Owned key" or bundle titles. */
  sources: string[];
  /** Status from the last match-itad run (before any new decisions). */
  matchStatus: GameMatch['status'];
  /**
   * Why it is listed: needs review ('no-data', 'multiple'), was discarded
   * automatically ('mismatch', 'no-candidate'), or was decided earlier.
   */
  reason: 'no-data' | 'multiple' | 'mismatch' | 'no-candidate' | 'decided';
  candidates: Candidate[];
}

/**
 * Games the user may want to decide on: everything in review, everything
 * discarded automatically (in case the user wants to rescue one), plus
 * anything that already has an override (so earlier decisions show up).
 */
export function buildReviewItems(
  matches: readonly GameMatch[],
  library: ItchLibrary,
  overrides: Overrides,
): ReviewItem[] {
  const games = new Map(library.games.map((g) => [g.id, g]));
  return matches
    .filter((m) => m.status === 'review' || m.status === 'discarded' || String(m.itchId) in overrides)
    .map((m) => {
      const g = games.get(m.itchId);
      const passing = m.candidates.filter((c) => c.companyMatch || c.sharedBundle);
      const reason: ReviewItem['reason'] =
        String(m.itchId) in overrides || (m.status !== 'review' && m.status !== 'discarded')
          ? 'decided'
          : m.status === 'discarded'
            ? m.discardReason === 'developer-mismatch'
              ? 'mismatch'
              : 'no-candidate'
            : passing.length > 1
              ? 'multiple'
              : 'no-data';
      return {
        itchId: m.itchId,
        itchTitle: m.itchTitle,
        itchUrl: m.itchUrl,
        itchDeveloper: m.itchDeveloper,
        itchPublishedAt: m.itchPublishedAt,
        coverUrl: g?.coverUrl,
        sources: [
          ...new Set((g?.sources ?? []).map((s) => (s.type === 'key' ? 'Owned key' : s.bundleTitle))),
        ],
        matchStatus: m.status,
        reason,
        candidates: m.candidates,
      };
    })
    .sort((a, b) => a.itchTitle.localeCompare(b.itchTitle));
}

const ITAD_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type Decision = { itchId: number; itadId: string | null } | { itchId: number; clear: true };

/** Validates a decision posted by the page. Returns an error message, or undefined if valid. */
export function validateDecision(body: unknown, knownItchIds: ReadonlySet<number>): string | undefined {
  if (typeof body !== 'object' || body === null) return 'expected an object';
  const d = body as Record<string, unknown>;
  if (typeof d.itchId !== 'number' || !knownItchIds.has(d.itchId)) return 'unknown itchId';
  if ('clear' in d) return d.clear === true ? undefined : 'clear must be true';
  if (d.itadId === null) return undefined;
  if (typeof d.itadId !== 'string' || !ITAD_ID.test(d.itadId)) return 'itadId must be an ITAD game id (UUID) or null';
  return undefined;
}

export function applyDecision(overrides: Overrides, decision: Decision): Overrides {
  const next = { ...overrides };
  const key = String(decision.itchId);
  if ('clear' in decision) delete next[key];
  else next[key] = decision.itadId;
  return next;
}

export async function readOverrides(file: string): Promise<Overrides> {
  try {
    return JSON.parse(await readFile(file, 'utf8')) as Overrides;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw e;
  }
}

/** Writes via a temp file + rename so a crash can't leave a half-written file. */
export async function writeOverrides(file: string, overrides: Overrides): Promise<void> {
  const sorted = Object.fromEntries(Object.entries(overrides).sort(([a], [b]) => Number(a) - Number(b)));
  const tmp = `${file}.tmp`;
  await writeFile(tmp, JSON.stringify(sorted, null, 2) + '\n');
  await rename(tmp, file);
}
