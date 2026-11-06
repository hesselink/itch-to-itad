import { createHash, randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { requestJson, type Fetch } from '../http.ts';
import { TokenResponseSchema } from './schemas.ts';

export const AUTHORIZE_URL = 'https://isthereanydeal.com/oauth/authorize/';
export const TOKEN_URL = 'https://isthereanydeal.com/oauth/token/';
export const REDIRECT_URI = 'http://localhost:8080/callback';
export const SCOPES = ['profiles', 'coll_read', 'coll_write'];
export const TOKEN_FILE = 'data/itad-token.json';

export interface OAuthConfig {
  clientId: string;
  clientSecret?: string;
  fetch?: Fetch;
}

export interface StoredAuth {
  accessToken: string;
  refreshToken?: string;
  /** Epoch ms. */
  expiresAt?: number;
  /** Token returned by /profiles/link/v1, if linking succeeded. */
  profileToken?: string;
  /** What we linked the profile as, for reference. */
  profile?: { accountId: string; accountName: string };
}

const base64url = (buf: Buffer) => buf.toString('base64url');

export function createPkcePair(): { verifier: string; challenge: string } {
  const verifier = base64url(randomBytes(48));
  return { verifier, challenge: pkceChallenge(verifier) };
}

export function pkceChallenge(verifier: string): string {
  return base64url(createHash('sha256').update(verifier).digest());
}

export function buildAuthorizeUrl(clientId: string, challenge: string, state: string): string {
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: REDIRECT_URI,
    scope: SCOPES.join(' '),
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state,
  });
  return `${AUTHORIZE_URL}?${params}`;
}

async function tokenRequest(config: OAuthConfig, params: Record<string, string>): Promise<StoredAuth> {
  const body = new URLSearchParams({ client_id: config.clientId, ...params });
  if (config.clientSecret) body.set('client_secret', config.clientSecret);
  const res = await requestJson(
    TOKEN_URL,
    { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body },
    TokenResponseSchema,
    { fetch: config.fetch },
  );
  return {
    accessToken: res.access_token,
    refreshToken: res.refresh_token,
    expiresAt: res.expires_in !== undefined ? Date.now() + res.expires_in * 1000 : undefined,
  };
}

export function exchangeCode(config: OAuthConfig, code: string, verifier: string): Promise<StoredAuth> {
  return tokenRequest(config, {
    grant_type: 'authorization_code',
    code,
    redirect_uri: REDIRECT_URI,
    code_verifier: verifier,
  });
}

export function refreshTokens(config: OAuthConfig, refreshToken: string): Promise<StoredAuth> {
  return tokenRequest(config, { grant_type: 'refresh_token', refresh_token: refreshToken });
}

export async function loadAuth(file = TOKEN_FILE): Promise<StoredAuth | undefined> {
  try {
    return JSON.parse(await readFile(file, 'utf8')) as StoredAuth;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw e;
  }
}

export async function saveAuth(auth: StoredAuth, file = TOKEN_FILE): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(auth, null, 2) + '\n', { mode: 0o600 });
}

const REFRESH_MARGIN_MS = 5 * 60 * 1000;

/**
 * Returns a function that yields a valid access token, refreshing (and
 * persisting) it when it is within a few minutes of expiry.
 */
export function accessTokenProvider(config: OAuthConfig, file = TOKEN_FILE): () => Promise<string> {
  let cached: StoredAuth | undefined;
  return async () => {
    cached ??= await loadAuth(file);
    if (!cached) throw new Error(`Not logged in to ITAD; run \`pnpm itad-login\` first`);
    if (cached.expiresAt !== undefined && cached.expiresAt - Date.now() < REFRESH_MARGIN_MS) {
      if (!cached.refreshToken) throw new Error('ITAD token expired and no refresh token; run `pnpm itad-login`');
      const fresh = await refreshTokens(config, cached.refreshToken);
      cached = { ...cached, ...fresh, refreshToken: fresh.refreshToken ?? cached.refreshToken };
      await saveAuth(cached, file);
    }
    return cached.accessToken;
  };
}
