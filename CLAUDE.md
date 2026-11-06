# Notes for AI assistants working on itch-to-itad

Read README.md first for what the tool does and how it's run. This file records
how the code is organised, facts about the two APIs that aren't obvious from
the code, and decisions the user made that shouldn't be undone.

## Pipeline and files

Each CLI step reads the previous step's output from `data/` (gitignored) and
writes its own, so every step can be inspected and re-run on its own.

| Step | Code | Reads | Writes |
|---|---|---|---|
| `fetch-itch` | `src/itch/library.ts` | itch API | `data/itch-library.json` |
| `itad-login` | `src/itad/oauth.ts` | ITAD OAuth | `data/itad-token.json` (access/refresh/profile token) |
| `match-itad` | `src/itad/match.ts`, `normalise.ts` | library, overrides, ITAD API | `data/itad-matches.json`, `data/itad-review.md`, `data/itad-cache/*.json` |
| `review` | `src/review/*`, `src/cli/review.ts` | matches, library | `data/itad-overrides.json` |
| `sync-itad` | `src/itad/sync.ts` | matches, token | `data/itad-sync-plan.json`, the user's ITAD collection |

- `src/cli/*` are thin entry points with top-level side effects. Don't import
  them from other modules; shared constants live in `src/paths.ts`.
- `data/itad-overrides.json` (`{ "<itchId>": "<itadGameId>" | null }`) is the
  only user-authored data. It must never be overwritten or regenerated.
- Shared code: `src/http.ts` (`requestJson`: retry/backoff on 429 and 5xx
  honouring `Retry-After`, zod validation, redacts keys from errors) and
  `src/util.ts` (pagination, concurrency, chunking, `Throttle`).

## Conventions

- pnpm and Node's built-in TypeScript type stripping (no tsx, no bun, no build
  step). The user prefers pnpm/vite-ecosystem tools and wants to be asked
  before new tools are added. `tsconfig` has `erasableSyntaxOnly`: no enums,
  no constructor parameter properties, no namespaces. Imports use `.ts`
  extensions.
- Runtime dependency: zod only. Every API response is validated with a schema
  (`src/itch/schemas.ts`, `src/itad/schemas.ts`); keep fields optional unless
  the code needs them.
- Logic is kept pure and testable apart from the I/O: `buildLibrary`,
  `matchGames` (takes a `MatchApi` and caches), `planSync`, `buildReviewItems`.
  Tests in `test/` use vitest with fake fetch/API objects shaped like real
  responses. Run `pnpm typecheck && pnpm test` before committing.
- Commit after each distinct piece of work, with a descriptive message.

## Safety

- Anything that writes to the user's ITAD account (`sync-itad --apply`,
  `--prune`, profile linking) needs the user's go-ahead. `sync-itad` is a dry
  run by default; keep it that way.
- Profile sync (`PUT /profiles/sync/collection/v1`) **mirrors** the list it's
  sent: anything missing from the payload is removed. Always send the full
  set. `--limit` is only for trials, and `--prune` is refused together with
  `--limit`.
- Secrets live in `.env`. Load them with `node --env-file`; never print them.
  Show only the variable names.

## itch.io API facts (verified against the live API)

- `https://api.itch.io`, `Authorization: Bearer <key>`. The responses are
  snake_case.
- **Empty arrays are sent as `{}`**, both for empty pages and for a game's
  empty `traits`. The `itchArray()` helper in `src/itch/schemas.ts` normalises
  this; use it for every list field.
- `/profile/owned-keys?page&per_page=500`: pages can be short, so page until
  one is empty (`pageUntilEmpty`).
- `/profile/owned-bundles` and `/bundles/{id}/bundle-games?page` are not in the
  official docs (they came from a third-party OpenAPI mirror), but they work.
  bundle-games returns 100 per page and lists unclaimed games too. We never
  call `claim-game`.
- The spec says owned-bundles is capped at 100 bundles and excludes sale
  bundles. The user confirmed none of theirs are missing.
- `game.classification` decides what counts as a game; only `game` is kept.
  `user.display_name` is often missing, so fall back to `username`.

## ITAD API facts (verified against the live API)

- `https://api.isthereanydeal.com`. Catalogue endpoints take an `ITAD-API-Key`
  header. Collection and profile endpoints need OAuth (authorization code +
  PKCE, scopes `profiles coll_read coll_write`, redirect
  `http://localhost:8080/callback`). The spec is embedded in the Redoc page at
  docs.isthereanydeal.com.
- Rate limit: 1000 requests per 5 minutes. `ItadClient` throttles to 3/s.
- Itch.io is shop **44**. It is inactive, and ITAD has **no itch id mappings**
  (`/lookup/id/shop/44/v1` returns null for every id format), so all matching
  is title-based.
- `POST /lookup/id/title/v1`: exact-title bulk lookup with inconsistent
  preprocessing (`"Tunic!"` → TUNIC, but `"tunic"` → null). It also returns
  unrelated same-titled games. ITAD's catalogue contains many tiny itch games
  (it seems to ingest itch bundles), so almost every title gets a hit, which is
  why a second signal is required.
- `/games/info/v2` (developers, publishers, one game per request): many small
  games have no developer/publisher data at all.
- `/games/bundles/v2?expired=true` lists the bundles ITAD has seen a game in.
  Itch bundle URLs (`itch.io/b/<id>/…`) let us compare against the user's own
  bundles. ITAD doesn't track every itch bundle, so this signal is incomplete.
- `/games/search/v1` results include `slug`. That's the only way to turn an
  ITAD page URL (`/game/<slug>/info/`) into a game id (`src/review/resolve.ts`).
- Profile sync matches by title, so we send ITAD's canonical title. Copies it
  creates have shop 44, are redeemed, and have no tags. The collection
  endpoints are not paginated.

## Matching rules (`src/itad/match.ts`)

1. Candidates come from the exact-title lookup on `titleVariants()` (original;
   without ™ and fancy quotes; without edition suffixes). If that finds
   nothing, the fallback is search, keeping only near-identical titles of type
   `game`.
2. A candidate **passes** if a developer or publisher matches the itch
   developer (`companiesMatch`: normalised names; display name or itch
   subdomain), **or** ITAD lists it in one of the itch bundles the game came
   from.
3. Exactly one passing candidate → `confirmed`. More than one → `review`.
4. No passing candidate:
   - no candidates → `discarded` (`no-candidate`)
   - all candidates have contradicting developer data → `discarded`
     (`developer-mismatch`)
   - exactly one no-data candidate with an identical, *distinctive* title
     (`distinctiveTitleMatch`) → `confirmed`
   - otherwise `review`
5. Overrides win: an id → `override`, `null` → `excluded`.
6. `syncTitleSafe`: ITAD's canonical title must look up back to the chosen id.
   If it doesn't, `sync-itad` adds the game as a direct copy (tag `itch`)
   instead of through profile sync.

Decisions the user made; don't revert these without asking:

- **Do not strip** "(Demo)", "(Prototype)", "Early Access", alpha/beta or jam
  suffixes when matching. On itch these are separate builds (e.g.
  "Dorfromantik (Prototype)" is not the Steam game), and ITAD often has its
  own entry for them. Only edition suffixes such as "Deluxe Edition" and
  "Director's Cut" are stripped. "Remastered" is not.
- Developer mismatches and games with no candidate are discarded, not
  reviewed. The user accepts that many tiny itch games won't be imported.
- The distinctive-title thresholds (2+ symbols; 3+ words and 12+ letters;
  2 words and 14+ letters; 1 word and 12+ letters) were calibrated on the
  user's library. The user was told the 3+ words rule may be loose (it
  accepts "Soldier of Fortune") and that it could be raised to 4+ words.

## State as of 2026-11

- The user's library has been fully matched, reviewed and synced. The review
  list is empty; the user's decisions are in `data/itad-overrides.json`.
- Possible next steps: an `itad-status` command to list the itch copies in the
  collection and compare them with the plan; tightening the 3+ words rule.
  New purchases only need the normal re-sync workflow from the README.
