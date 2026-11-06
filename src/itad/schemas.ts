import { z } from 'zod';

// Shapes from the ITAD OpenAPI spec (docs.isthereanydeal.com), checked
// against live responses where possible.

export const ITCH_SHOP_ID = 44;

export const GameIdSchema = z.string();

/** Response of /lookup/id/title/v1: title → ITAD game id or null. */
export const TitleLookupSchema = z.record(z.string(), GameIdSchema.nullable());

const NamedSchema = z.object({ id: z.number(), name: z.string() });

export const GameInfoSchema = z.object({
  id: GameIdSchema,
  slug: z.string(),
  title: z.string(),
  type: z.string().nullable(),
  releaseDate: z.string().nullable().optional(),
  appid: z.number().nullable().optional(),
  developers: z.array(NamedSchema).default([]),
  publishers: z.array(NamedSchema).default([]),
});
export type GameInfo = z.infer<typeof GameInfoSchema>;

export const SearchResultSchema = z.array(
  z.object({
    id: GameIdSchema,
    slug: z.string(),
    title: z.string(),
    type: z.string().nullable(),
  }),
);
export type SearchResult = z.infer<typeof SearchResultSchema>[number];

/** Response of /games/bundles/v2: bundles that contained the game. */
export const GameBundlesSchema = z.array(
  z.object({
    id: z.number(),
    title: z.string(),
    url: z.string(),
    page: z.object({ id: z.number(), name: z.string() }).optional(),
  }),
);
export type GameBundle = z.infer<typeof GameBundlesSchema>[number];

export const CollectionGamesSchema = z.array(
  z.object({
    id: GameIdSchema,
    title: z.string(),
    group: z.number().nullable().optional(),
  }),
);

export const CopySchema = z.object({
  id: z.number(),
  game: z.object({ id: GameIdSchema }),
  shop: z.object({ id: z.number() }).passthrough().nullable(),
  redeemed: z.boolean(),
  note: z.string().nullable(),
  tags: z.array(z.object({ id: z.number(), tag: z.string() })),
});
export const CopiesSchema = z.array(CopySchema);
export type Copy = z.infer<typeof CopySchema>;

export interface NewCopy {
  gameId: string;
  redeemed: boolean;
  shop: number | null;
  note: string | null;
  tags: string[] | null;
}

export const LinkProfileSchema = z.object({ token: z.string() });

export const SyncResponseSchema = z.object({
  total: z.number(),
  added: z.number(),
  removed: z.number(),
});
export type SyncResponse = z.infer<typeof SyncResponseSchema>;

export interface SyncEntry {
  shop: number;
  id: string;
  title: string;
}

export const TokenResponseSchema = z.object({
  access_token: z.string(),
  refresh_token: z.string().optional(),
  expires_in: z.number().optional(),
  token_type: z.string().optional(),
});

/** Accepts any (or no) body; used for 204/200-without-content endpoints. */
export const AnySchema = z.unknown();
