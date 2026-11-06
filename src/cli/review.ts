import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { ItchLibrary } from '../itch/library.ts';
import { ItadClient } from '../itad/client.ts';
import type { GameMatch } from '../itad/match.ts';
import { LIBRARY_FILE, MATCHES_FILE, OVERRIDES_FILE } from '../paths.ts';
import {
  applyDecision,
  buildReviewItems,
  readOverrides,
  validateDecision,
  writeOverrides,
  type Decision,
} from '../review/data.ts';
import { parseItadRef, resolveSlug } from '../review/resolve.ts';
import { requireEnv } from './env.ts';

const PORT = Number(process.env.REVIEW_PORT ?? 8081); // 8080 is reserved for the ITAD OAuth callback
const PAGE = new URL('../review/page.html', import.meta.url);

const { ITAD_API_KEY } = requireEnv('ITAD_API_KEY');
const itad = new ItadClient({ apiKey: ITAD_API_KEY });

const library = JSON.parse(await readFile(LIBRARY_FILE, 'utf8')) as ItchLibrary;
const { matches } = JSON.parse(await readFile(MATCHES_FILE, 'utf8')) as { matches: GameMatch[] };
let overrides = await readOverrides(OVERRIDES_FILE);
const items = buildReviewItems(matches, library, overrides);
const knownIds = new Set(items.map((i) => i.itchId));

// Serialise writes so concurrent clicks can't interleave read-modify-write.
let writeQueue = Promise.resolve();

const send = (res: ServerResponse, status: number, type: string, body: string) =>
  res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' }).end(body);
const json = (res: ServerResponse, status: number, body: unknown) =>
  send(res, status, 'application/json', JSON.stringify(body));

async function readBody(req: IncomingMessage): Promise<unknown> {
  let raw = '';
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 10_000) throw new Error('body too large');
  }
  return JSON.parse(raw);
}

const server = createServer(async (req, res) => {
  // Only answer requests addressed to localhost (guards against DNS rebinding).
  if (req.headers.host !== `localhost:${PORT}` && req.headers.host !== `127.0.0.1:${PORT}`) {
    return send(res, 403, 'text/plain', 'Forbidden');
  }
  const url = new URL(req.url ?? '/', `http://localhost:${PORT}`);
  try {
    if (req.method === 'GET' && url.pathname === '/') {
      return send(res, 200, 'text/html; charset=utf-8', await readFile(PAGE, 'utf8'));
    }
    if (req.method === 'GET' && url.pathname === '/api/items') {
      return json(res, 200, { items, overrides });
    }
    if (req.method === 'POST' && url.pathname === '/api/resolve') {
      // Turns a pasted ITAD URL, slug or id into a game id.
      const body = (await readBody(req)) as { input?: unknown };
      const ref = typeof body?.input === 'string' ? parseItadRef(body.input) : undefined;
      if (!ref) return json(res, 400, { error: 'Paste an ITAD game URL (…/game/<name>/info/), its name slug, or a game id' });
      if (ref.kind === 'id') {
        const info = await itad.gameInfo(ref.id).catch(() => undefined);
        if (!info) return json(res, 404, { error: `No ITAD game with id ${ref.id}` });
        return json(res, 200, { id: info.id, title: info.title, slug: info.slug });
      }
      const game = await resolveSlug(itad, ref.slug);
      if (!game) return json(res, 404, { error: `Could not find ITAD game "${ref.slug}"` });
      return json(res, 200, game);
    }
    if (req.method === 'POST' && url.pathname === '/api/decision') {
      const body = await readBody(req);
      const error = validateDecision(body, knownIds);
      if (error) return json(res, 400, { error });
      const done = writeQueue.then(async () => {
        overrides = applyDecision(overrides, body as Decision);
        await writeOverrides(OVERRIDES_FILE, overrides);
      });
      writeQueue = done.catch(() => {});
      await done;
      return json(res, 200, { overrides });
    }
    send(res, 404, 'text/plain', 'Not found');
  } catch (e) {
    json(res, 500, { error: String(e) });
  }
});

server.listen(PORT, '127.0.0.1', () => {
  const address = `http://localhost:${PORT}/`;
  console.log(`Reviewing ${items.length} games at ${address}`);
  console.log(`Decisions are saved to ${OVERRIDES_FILE} as you make them. Press Ctrl+C to stop.`);
  console.log('Afterwards run `pnpm match-itad` and then `pnpm sync-itad --apply`.');
  if (!process.argv.includes('--no-open')) {
    spawn('open', [address], { stdio: 'ignore', detached: true }).on('error', () => {}).unref();
  }
});
