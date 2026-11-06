import { z } from 'zod';

// Shapes verified against live api.itch.io responses (snake_case on the wire).
// Only fields we rely on are required; everything else is optional because
// real records omit them (e.g. display_name, short_text, cover_url).

// itch's backend serialises empty arrays as `{}`; normalise those to `[]`.
const itchArray = <T extends z.ZodType>(item: T) =>
  z.preprocess(
    (v) => (v !== null && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length === 0 ? [] : v),
    z.array(item),
  );

export const ItchUserSchema = z.object({
  id: z.number(),
  username: z.string(),
  url: z.string(),
  display_name: z.string().optional(),
});

export const ItchGameSchema = z.object({
  id: z.number(),
  title: z.string(),
  url: z.string(),
  classification: z.string(),
  type: z.string().optional(),
  short_text: z.string().optional(),
  cover_url: z.string().optional(),
  min_price: z.number().optional(),
  traits: itchArray(z.string()).default([]),
  created_at: z.string().optional(),
  published_at: z.string().optional(),
  user: ItchUserSchema.optional(),
});
export type ItchApiGame = z.infer<typeof ItchGameSchema>;

export const OwnedKeySchema = z.object({
  id: z.number(),
  game_id: z.number(),
  purchase_id: z.number().optional(),
  created_at: z.string().optional(),
  game: ItchGameSchema,
});
export type OwnedKey = z.infer<typeof OwnedKeySchema>;

export const OwnedKeysPageSchema = z.object({
  page: z.number(),
  per_page: z.number(),
  owned_keys: itchArray(OwnedKeySchema),
});

export const BundleSchema = z.object({
  id: z.number(),
  title: z.string(),
  url: z.string(),
  games_count: z.number().optional(),
});
export type Bundle = z.infer<typeof BundleSchema>;

export const OwnedBundlesSchema = z.object({
  bundle_keys: itchArray(
    z.object({
      id: z.number(),
      bundle_id: z.number(),
      bundle: BundleSchema,
    }),
  ),
});

export const BundleGameSchema = z.object({
  bundle_id: z.number(),
  game_id: z.number(),
  position: z.number().optional(),
  game: ItchGameSchema,
});
export type BundleGame = z.infer<typeof BundleGameSchema>;

export const BundleGamesPageSchema = z.object({
  page: z.number(),
  per_page: z.number(),
  bundle_games: itchArray(BundleGameSchema),
});

export const ProfileSchema = z.object({
  user: z.object({
    id: z.number(),
    username: z.string(),
    display_name: z.string().optional(),
  }),
});
