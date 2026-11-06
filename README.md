# itch-to-itad

Syncs the games you own on [itch.io](https://itch.io) into your
[IsThereAnyDeal](https://isthereanydeal.com) (ITAD) collection. ITAD has no
built-in itch.io integration, so this tool does three things:

1. Downloads your itch library: purchases, claimed keys and every game in the
   bundles you bought, including the ones you never clicked "claim" on.
2. Matches each itch game to a game in ITAD's catalogue, checking more than
   just the title.
3. Adds the matches to your ITAD collection through ITAD's profile sync. Your
   itch account appears as a linked profile at
   <https://isthereanydeal.com/settings/profiles/>, and the games show up in
   your **collection** (not your waitlist) with shop "Itch.io".

Only items that itch classifies as *games* are included, so soundtracks, assets,
books and tabletop/physical games are skipped.

## Usage

### One-time setup

You need Node ≥ 23.6 (the TypeScript sources run directly, with no build step)
and pnpm.

```sh
pnpm install
```

Create a `.env` file in the repo root with these variables. It is gitignored;
never commit it.

```
ITCH_API_KEY=...        # https://itch.io/user/settings/api-keys
ITAD_API_KEY=...        # from your app at https://isthereanydeal.com/apps/my/
ITAD_CLIENT_ID=...      # same app page (OAuth credentials)
ITAD_CLIENT_SECRET=...
```

The ITAD app must have `http://localhost:8080/callback` as its redirect URL.

Log in to ITAD once. This opens a browser, then links your itch account as an
ITAD profile:

```sh
pnpm itad-login
```

The token refreshes itself. Run `itad-login` again only if a command tells you
you're not logged in.

### Syncing (the usual run, e.g. after buying new games or bundles)

```sh
pnpm fetch-itch       # 1. download itch library → data/itch-library.json
pnpm match-itad       # 2. match to ITAD → data/itad-matches.json, data/itad-review.md
pnpm review           # 3. optional: decide on uncertain matches in the browser
pnpm match-itad       #    (re-run after reviewing, so your decisions are applied)
pnpm sync-itad        # 4. dry run: shows what would be sent
pnpm sync-itad --apply
```

- `fetch-itch` takes about 15 seconds.
- `match-itad` takes a while the first time, at most about 20 minutes, because
  ITAD is rate-limited. After that it's nearly instant: every ITAD response is
  cached in `data/itad-cache/`, so only new games cost API requests.
- `sync-itad --apply` prints ITAD's `added`/`removed` counts and then compares
  your collection before and after. Any warning lines it prints are worth a
  look.

### Reviewing uncertain matches

```sh
pnpm review    # opens http://localhost:8081/
```

This page lists the games where the matcher couldn't decide, mostly short or
generic titles that ITAD has no developer data for, such as "Octodad" or
"Cube". For each game you can:

- **Accept** one of the candidates (keys `1`–`9`),
- **Skip** it so it's never synced (`s`),
- paste an **ITAD game page URL** if the right game isn't listed,
- **Undo** a decision (`u`). Use `j`/`k` to move between games.

Decisions are saved immediately to `data/itad-overrides.json`. The Reason
filter can also show games that were *discarded automatically*, if you want to
rescue one. Afterwards, run `pnpm match-itad` and `pnpm sync-itad --apply`.

`data/itad-review.md` has the same information as a static Markdown report.

### Things to know

- **Back up `data/itad-overrides.json`.** It holds your manual review decisions
  and is the only file in `data/` that can't be regenerated. Everything else
  can be rebuilt by re-running the commands. The whole `data/` directory is
  gitignored.
- **Profile sync mirrors the list it's sent.** Every `sync-itad --apply`
  replaces the itch profile's games with the current list, so games that drop
  out (e.g. you skip them in review) are removed from ITAD. `--limit N` syncs
  only the first N games, which is useful for a trial run, but it also removes
  the rest. Always finish with a run without `--limit`.
- **A few games are added as plain copies instead.** Their ITAD title is shared
  with another game, so ITAD's title-based sync could pick the wrong one. They
  are added as collection copies tagged `itch`. Use `--prune` to delete
  itch-tagged copies whose game is no longer in the library.
- **To refresh ITAD's data**, e.g. because ITAD may have added developer info
  for games that were in review, delete `data/itad-cache/` and re-run
  `match-itad`. This takes a while again.
- **Why a game didn't match:** see the "Discarded" sections in
  `data/itad-review.md`. Games are discarded when ITAD has no game with that
  title, or when ITAD's game is by a different developer. Many tiny itch games
  simply aren't on ITAD.

### Development

```sh
pnpm test        # vitest
pnpm typecheck   # tsc
```

Notes on the code, written mainly as context for an AI assistant continuing
development, are in [CLAUDE.md](CLAUDE.md).
