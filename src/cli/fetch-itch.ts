import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { ItchClient } from '../itch/client.ts';
import { fetchLibrary } from '../itch/library.ts';

const OUTPUT = 'data/itch-library.json';

const apiKey = process.env.ITCH_API_KEY;
if (!apiKey) {
  console.error('ITCH_API_KEY is not set (put it in .env)');
  process.exit(1);
}

const library = await fetchLibrary(new ItchClient({ apiKey }), {
  log: (msg) => console.error(msg),
});

await mkdir(dirname(OUTPUT), { recursive: true });
await writeFile(OUTPUT, JSON.stringify(library, null, 2) + '\n');

const viaKey = library.games.filter((g) => g.sources.some((s) => s.type === 'key')).length;
console.log(`Owned keys:        ${library.ownedKeyCount}`);
console.log(`Bundles:           ${library.bundles.length}`);
for (const b of library.bundles) {
  const mismatch = b.gamesCount !== undefined && b.gamesCount !== b.fetchedGames ? ` (bundle says ${b.gamesCount})` : '';
  console.log(`  ${b.title}: ${b.fetchedGames}${mismatch}`);
}
console.log(`Unique games:      ${library.games.length}`);
console.log(`  via owned key:   ${viaKey}`);
console.log(`  bundle-only:     ${library.games.length - viaKey}`);
console.log(`Excluded non-games: ${JSON.stringify(library.excludedByClassification)}`);
console.log(`Wrote ${OUTPUT}`);
