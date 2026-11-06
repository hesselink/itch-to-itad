import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { HttpError } from '../http.ts';
import { ItchClient } from '../itch/client.ts';
import { ProfileSchema } from '../itch/schemas.ts';
import { ItadClient } from '../itad/client.ts';
import {
  REDIRECT_URI,
  buildAuthorizeUrl,
  createPkcePair,
  exchangeCode,
  saveAuth,
  type StoredAuth,
} from '../itad/oauth.ts';
import { requireEnv } from './env.ts';

const TIMEOUT_MS = 5 * 60 * 1000;

const { ITAD_CLIENT_ID, ITAD_CLIENT_SECRET, ITAD_API_KEY, ITCH_API_KEY } = requireEnv(
  'ITAD_CLIENT_ID',
  'ITAD_CLIENT_SECRET',
  'ITAD_API_KEY',
  'ITCH_API_KEY',
);
const oauth = { clientId: ITAD_CLIENT_ID, clientSecret: ITAD_CLIENT_SECRET };

function waitForCode(expectedState: string): Promise<string> {
  const { pathname, port } = new URL(REDIRECT_URI);
  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      const url = new URL(req.url ?? '/', REDIRECT_URI);
      if (url.pathname !== pathname) {
        res.writeHead(404).end();
        return;
      }
      const finish = (status: number, message: string, result: () => void) => {
        res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8' }).end(message);
        clearTimeout(timer);
        server.close();
        result();
      };
      const error = url.searchParams.get('error');
      const code = url.searchParams.get('code');
      if (error) {
        finish(400, `Authorization failed: ${error}`, () => reject(new Error(`ITAD authorization failed: ${error}`)));
      } else if (url.searchParams.get('state') !== expectedState) {
        finish(400, 'State mismatch', () => reject(new Error('OAuth state mismatch')));
      } else if (!code) {
        finish(400, 'Missing code', () => reject(new Error('OAuth callback without code')));
      } else {
        finish(200, 'Logged in to IsThereAnyDeal. You can close this tab.', () => resolve(code));
      }
    });
    const timer = setTimeout(() => {
      server.close();
      reject(new Error('Timed out waiting for the OAuth callback'));
    }, TIMEOUT_MS);
    server.on('error', reject);
    server.listen(Number(port), '127.0.0.1');
  });
}

const { verifier, challenge } = createPkcePair();
const state = randomBytes(16).toString('hex');
const authorizeUrl = buildAuthorizeUrl(ITAD_CLIENT_ID, challenge, state);

const codePromise = waitForCode(state);
console.log(`Opening browser for ITAD login. If it doesn't open, visit:\n${authorizeUrl}\n`);
spawn('open', [authorizeUrl], { stdio: 'ignore', detached: true }).on('error', () => {}).unref();

const code = await codePromise;
let auth: StoredAuth = await exchangeCode(oauth, code, verifier);
await saveAuth(auth);
console.log('Logged in; token saved to data/itad-token.json');

// Link the itch account as an ITAD profile, so we can use profile sync.
const { user } = await new ItchClient({ apiKey: ITCH_API_KEY }).get('/profile', ProfileSchema);
const profile = { accountId: String(user.id), accountName: user.username };
const itad = new ItadClient({ apiKey: ITAD_API_KEY, accessToken: async () => auth.accessToken });
try {
  const { token } = await itad.linkProfile(profile.accountId, profile.accountName);
  auth = { ...auth, profileToken: token, profile };
  await saveAuth(auth);
  console.log(`Linked itch account "${profile.accountName}" as an ITAD profile.`);
} catch (e) {
  if (e instanceof HttpError && (e.status === 401 || e.status === 403)) {
    console.log(
      `Could not link profile (HTTP ${e.status}): ${e.body.slice(0, 300)}\n` +
        'Profile sync is probably not enabled for this app. sync-itad will fall back to adding copies directly.',
    );
  } else {
    throw e;
  }
}
