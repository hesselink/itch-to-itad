import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  accessTokenProvider,
  buildAuthorizeUrl,
  pkceChallenge,
  saveAuth,
  type StoredAuth,
} from '../../src/itad/oauth.ts';

describe('PKCE', () => {
  it('matches the RFC 7636 example', () => {
    expect(pkceChallenge('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk')).toBe(
      'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
    );
  });

  it('builds the authorize URL', () => {
    const url = new URL(buildAuthorizeUrl('client', 'chal', 'st'));
    expect(url.origin + url.pathname).toBe('https://isthereanydeal.com/oauth/authorize/');
    expect(Object.fromEntries(url.searchParams)).toEqual({
      response_type: 'code',
      client_id: 'client',
      redirect_uri: 'http://localhost:8080/callback',
      scope: 'profiles coll_read coll_write',
      code_challenge: 'chal',
      code_challenge_method: 'S256',
      state: 'st',
    });
  });
});

describe('accessTokenProvider', () => {
  const tmpFile = async () => join(await mkdtemp(join(tmpdir(), 'itad-oauth-')), 'token.json');

  it('returns a still-valid token without refreshing', async () => {
    const file = await tmpFile();
    await saveAuth({ accessToken: 'a1', refreshToken: 'r1', expiresAt: Date.now() + 3600_000 }, file);
    const fetch = vi.fn();
    expect(await accessTokenProvider({ clientId: 'c', fetch }, file)()).toBe('a1');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('refreshes an almost-expired token and persists it, keeping the profile token', async () => {
    const file = await tmpFile();
    await saveAuth(
      { accessToken: 'a1', refreshToken: 'r1', expiresAt: Date.now() + 1000, profileToken: 'p' },
      file,
    );
    const fetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = new URLSearchParams(String(init?.body));
      expect(Object.fromEntries(body)).toEqual({
        client_id: 'c',
        client_secret: 's',
        grant_type: 'refresh_token',
        refresh_token: 'r1',
      });
      return new Response(JSON.stringify({ access_token: 'a2', expires_in: 3600 }));
    });
    const token = await accessTokenProvider({ clientId: 'c', clientSecret: 's', fetch }, file)();
    expect(token).toBe('a2');
    const stored = JSON.parse(await readFile(file, 'utf8')) as StoredAuth;
    expect(stored).toMatchObject({ accessToken: 'a2', refreshToken: 'r1', profileToken: 'p' });
  });

  it('asks to log in when there is no token file', async () => {
    const file = await tmpFile();
    await expect(accessTokenProvider({ clientId: 'c' }, file)()).rejects.toThrow(/itad-login/);
  });
});
