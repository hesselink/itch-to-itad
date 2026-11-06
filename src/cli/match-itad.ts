import { readFile, writeFile } from 'node:fs/promises';
import type { ItchLibrary } from '../itch/library.ts';
import { ItadClient } from '../itad/client.ts';
import { diskCaches, matchGames, reviewMarkdown, summarise, type Overrides } from '../itad/match.ts';
import { ITAD_CACHE_DIR, LIBRARY_FILE, MATCHES_FILE, OVERRIDES_FILE, REVIEW_FILE } from '../paths.ts';
import { requireEnv } from './env.ts';

const { ITAD_API_KEY } = requireEnv('ITAD_API_KEY');

const library = JSON.parse(await readFile(LIBRARY_FILE, 'utf8')) as ItchLibrary;

let overrides: Overrides = {};
try {
  overrides = JSON.parse(await readFile(OVERRIDES_FILE, 'utf8')) as Overrides;
  console.error(`Loaded ${Object.keys(overrides).length} overrides from ${OVERRIDES_FILE}`);
} catch (e) {
  if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
}

const matches = await matchGames(new ItadClient({ apiKey: ITAD_API_KEY }), library.games, {
  overrides,
  caches: diskCaches(ITAD_CACHE_DIR),
  log: (m) => console.error(m),
});

await writeFile(MATCHES_FILE, JSON.stringify({ matchedAt: new Date().toISOString(), matches }, null, 2) + '\n');
await writeFile(REVIEW_FILE, reviewMarkdown(matches));

const s = summarise(matches);
console.log(`Games:      ${matches.length}`);
console.log(`Confirmed:  ${s.confirmed}`);
console.log(`Overrides:  ${s.override}`);
console.log(`Review:     ${s.review}`);
console.log(`Discarded:  ${s.discarded} (no ITAD game or developer mismatch)`);
console.log(`Excluded:   ${s.excluded}`);
console.log(`  of matched, ambiguous ITAD title (direct copies): ${s.syncTitleUnsafe}`);
console.log(`Wrote ${MATCHES_FILE} and ${REVIEW_FILE}`);
