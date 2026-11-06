import { chunk } from '../util.ts';
import type { ItadClient } from './client.ts';
import type { GameMatch } from './match.ts';
import { ITCH_SHOP_ID, type Copy, type NewCopy, type SyncEntry, type SyncResponse } from './schemas.ts';

export const ITCH_TAG = 'itch';

export type SyncApi = Pick<
  ItadClient,
  'collectionGames' | 'copies' | 'addCopies' | 'deleteCopies' | 'syncCollection'
>;

export interface SyncPlan {
  mode: 'profile' | 'direct';
  /** Sent through profile sync (profile mode only). */
  syncEntries: SyncEntry[];
  /** Added as tagged copies directly. */
  direct: { itadId: string; itchTitle: string; itchUrl: string }[];
  /** ITAD ids we expect to end up in the collection. */
  expectedIds: Set<string>;
}

/**
 * Decides what to send where. Only confirmed and override matches are
 * included. In profile mode, games whose ITAD title doesn't resolve back to
 * the chosen game go to `direct`, because profile sync matches by title.
 */
export function planSync(
  matches: readonly GameMatch[],
  { mode, limit }: { mode: 'profile' | 'direct'; limit?: number },
): SyncPlan {
  let chosen = matches.filter(
    (m): m is GameMatch & { itadId: string } =>
      (m.status === 'confirmed' || m.status === 'override') && m.itadId !== undefined,
  );
  // One entry per ITAD game, even if several itch games map to it.
  const seen = new Set<string>();
  chosen = chosen.filter((m) => !seen.has(m.itadId) && seen.add(m.itadId));
  if (limit !== undefined) chosen = chosen.slice(0, limit);

  const plan: SyncPlan = { mode, syncEntries: [], direct: [], expectedIds: new Set() };
  for (const m of chosen) {
    plan.expectedIds.add(m.itadId);
    if (mode === 'profile' && m.syncTitleSafe && m.itadTitle) {
      plan.syncEntries.push({ shop: ITCH_SHOP_ID, id: String(m.itchId), title: m.itadTitle });
    } else {
      plan.direct.push({ itadId: m.itadId, itchTitle: m.itchTitle, itchUrl: m.itchUrl });
    }
  }
  return plan;
}

const isItchCopy = (c: Copy) => c.shop?.id === ITCH_SHOP_ID || c.tags.some((t) => t.tag === ITCH_TAG);

export interface ProfileSyncResult {
  response: SyncResponse;
  /** Expected games that are not in the collection after syncing. */
  missing: string[];
  /** Games that appeared in the collection but weren't expected (ITAD matched differently). */
  unexpected: { id: string; title: string }[];
}

export async function applyProfileSync(
  api: SyncApi,
  profileToken: string,
  entries: SyncEntry[],
  expectedIds: ReadonlySet<string>,
): Promise<ProfileSyncResult> {
  const before = new Set((await api.collectionGames()).map((g) => g.id));
  const response = await api.syncCollection(profileToken, entries);
  const after = await api.collectionGames();
  const afterIds = new Set(after.map((g) => g.id));
  return {
    response,
    missing: [...expectedIds].filter((id) => !afterIds.has(id)),
    unexpected: after
      .filter((g) => !before.has(g.id) && !expectedIds.has(g.id))
      .map((g) => ({ id: g.id, title: g.title })),
  };
}

export interface DirectResult {
  added: number;
  alreadyPresent: number;
  /** Expected games that still lack an itch copy after adding. */
  missing: string[];
  /** Tagged itch copies whose game is no longer expected (deleted if prune). */
  stale: Copy[];
  pruned: number;
}

const COPY_BATCH = 100;

export async function applyDirectCopies(
  api: SyncApi,
  direct: SyncPlan['direct'],
  { allExpectedIds, prune = false }: { allExpectedIds: ReadonlySet<string>; prune?: boolean },
): Promise<DirectResult> {
  const existing = await api.copies();
  const haveItchCopy = new Set(existing.filter(isItchCopy).map((c) => c.game.id));
  const toAdd: NewCopy[] = direct
    .filter((d) => !haveItchCopy.has(d.itadId))
    .map((d) => ({ gameId: d.itadId, redeemed: true, shop: ITCH_SHOP_ID, tags: [ITCH_TAG], note: d.itchUrl }));
  for (const batch of chunk(toAdd, COPY_BATCH)) await api.addCopies(batch);

  // Only copies we created (tagged "itch") are candidates for pruning.
  const stale = existing.filter((c) => c.tags.some((t) => t.tag === ITCH_TAG) && !allExpectedIds.has(c.game.id));
  if (prune && stale.length > 0) {
    for (const batch of chunk(stale.map((c) => c.id), COPY_BATCH)) await api.deleteCopies(batch);
  }

  const after = toAdd.length > 0 || (prune && stale.length > 0) ? await api.copies() : existing;
  const nowHave = new Set(after.filter(isItchCopy).map((c) => c.game.id));
  return {
    added: toAdd.length,
    alreadyPresent: direct.length - toAdd.length,
    missing: direct.map((d) => d.itadId).filter((id) => !nowHave.has(id)),
    stale,
    pruned: prune ? stale.length : 0,
  };
}
