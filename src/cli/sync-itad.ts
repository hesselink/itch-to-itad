import { readFile, writeFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { ItadClient } from '../itad/client.ts';
import type { GameMatch } from '../itad/match.ts';
import { accessTokenProvider, loadAuth } from '../itad/oauth.ts';
import { applyDirectCopies, applyProfileSync, planSync } from '../itad/sync.ts';
import { MATCHES_FILE } from '../paths.ts';
import { requireEnv } from './env.ts';

const PLAN_FILE = 'data/itad-sync-plan.json';

const { values: args } = parseArgs({
  options: {
    apply: { type: 'boolean', default: false },
    limit: { type: 'string' },
    prune: { type: 'boolean', default: false },
    direct: { type: 'boolean', default: false },
  },
});
const limit = args.limit === undefined ? undefined : Number(args.limit);
if (limit !== undefined && !(Number.isInteger(limit) && limit > 0)) {
  console.error('--limit must be a positive integer');
  process.exit(1);
}
if (limit !== undefined && args.prune) {
  console.error('--prune cannot be combined with --limit (it would delete everything outside the limit)');
  process.exit(1);
}

const { ITAD_API_KEY, ITAD_CLIENT_ID, ITAD_CLIENT_SECRET } = requireEnv('ITAD_API_KEY', 'ITAD_CLIENT_ID', 'ITAD_CLIENT_SECRET');
const { matches } = JSON.parse(await readFile(MATCHES_FILE, 'utf8')) as { matches: GameMatch[] };

const auth = await loadAuth();
const profileToken = auth?.profileToken;
const mode = profileToken && !args.direct ? 'profile' : 'direct';
if (!profileToken && !args.direct) {
  console.error('No linked ITAD profile (see `pnpm itad-login`); adding games as tagged copies instead.');
}

const plan = planSync(matches, { mode, limit });
await writeFile(
  PLAN_FILE,
  JSON.stringify({ ...plan, expectedIds: [...plan.expectedIds] }, null, 2) + '\n',
);
console.log(`Mode:                 ${mode}${limit ? ` (limited to ${limit} games)` : ''}`);
console.log(`Via profile sync:     ${plan.syncEntries.length}`);
console.log(`Direct tagged copies: ${plan.direct.length}`);
console.log(`Plan written to ${PLAN_FILE}`);
if (mode === 'profile' && limit !== undefined) {
  console.log(
    'Note: profile sync mirrors the list it is sent, so a limited sync removes previously synced itch games\n' +
      'beyond the limit. Run without --limit afterwards to sync everything.',
  );
}

if (!args.apply) {
  console.log('\nDry run. Re-run with --apply to write to your ITAD collection.');
  process.exit(0);
}

const itad = new ItadClient({
  apiKey: ITAD_API_KEY,
  accessToken: accessTokenProvider({ clientId: ITAD_CLIENT_ID, clientSecret: ITAD_CLIENT_SECRET }),
});

if (mode === 'profile' && plan.syncEntries.length > 0) {
  const r = await applyProfileSync(itad, profileToken!, plan.syncEntries, plan.expectedIds);
  console.log(`\nProfile sync: total ${r.response.total}, added ${r.response.added}, removed ${r.response.removed}`);
  const directIds = new Set(plan.direct.map((d) => d.itadId));
  const missing = r.missing.filter((id) => !directIds.has(id));
  if (missing.length) console.log(`  ${missing.length} expected games missing after sync: ${missing.slice(0, 20).join(', ')}`);
  if (r.unexpected.length) {
    console.log(`  ${r.unexpected.length} unexpected games added (ITAD matched a title differently):`);
    for (const g of r.unexpected.slice(0, 20)) console.log(`    ${g.title} (${g.id})`);
  }
}

if (plan.direct.length > 0 || args.prune) {
  const r = await applyDirectCopies(itad, plan.direct, { allExpectedIds: plan.expectedIds, prune: args.prune });
  console.log(`\nDirect copies: added ${r.added}, already present ${r.alreadyPresent}`);
  if (r.missing.length) console.log(`  ${r.missing.length} still missing after adding: ${r.missing.slice(0, 20).join(', ')}`);
  if (r.stale.length) {
    console.log(
      `  ${r.stale.length} itch-tagged copies are no longer in the library` +
        (args.prune ? ' and were deleted' : '; run with --prune to delete them'),
    );
  }
}
