import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { DEFAULT_REDIRECT_URIS, loadConfig, redirectUriAllowed } from '../src/config.js';
import { hashToken, pkceMatches, SecretBox } from '../src/crypto.js';
import { ADMIN_PERMISSIONS, permissionsFor, USER_PERMISSIONS } from '../src/immich.js';
import { signInPageHeaders } from '../src/oauth/login-page.js';
import { ImmichOAuthProvider, REFRESH_REUSE_GRACE_SECONDS } from '../src/oauth/provider.js';
import { createApp } from '../src/server.js';
import { Store } from '../src/store.js';
import { compact, formatDuration, mapLimit, takenAt } from '../src/tools/context.js';

const config = loadConfig({ PUBLIC_URL: 'https://photos.example.com/mcp', IMMICH_URL: 'http://immich:2283' });

describe('redirect URI allow-list', () => {
  it('accepts the Claude callbacks and any loopback port', () => {
    expect(redirectUriAllowed('https://claude.ai/api/mcp/auth_callback', DEFAULT_REDIRECT_URIS)).toBe(true);
    expect(redirectUriAllowed('http://localhost:33418/callback', DEFAULT_REDIRECT_URIS)).toBe(true);
    expect(redirectUriAllowed('http://127.0.0.1:5000/cb', DEFAULT_REDIRECT_URIS)).toBe(true);
  });

  it('rejects look-alikes', () => {
    for (const uri of [
      'https://claude.ai/api/mcp/auth_callback/../../evil',
      'https://claude.ai.evil.com/api/mcp/auth_callback',
      'http://localhost:@evil.com/',
      'http://localhost.evil.com:80/',
      'http://user:pw@localhost:8080/',
      'https://localhost:8080/cb#frag',
      'javascript:alert(1)',
      'not a url',
    ]) {
      expect(redirectUriAllowed(uri, DEFAULT_REDIRECT_URIS), uri).toBe(false);
    }
  });
});

describe('crypto', () => {
  it('round-trips sealed secrets and rejects tampering', () => {
    const box = new SecretBox(Buffer.alloc(32, 7));
    const sealed = box.seal('secret-key');
    expect(sealed).not.toContain('secret-key');
    expect(box.open(sealed)).toBe('secret-key');
    const parts = sealed.split('.');
    parts[3] = Buffer.from('other').toString('base64url');
    expect(() => box.open(parts.join('.'))).toThrow();
    expect(() => new SecretBox(Buffer.alloc(32, 8)).open(sealed)).toThrow();
  });

  it('checks S256 PKCE', () => {
    const verifier = 'v'.repeat(50);
    const challenge = createHash('sha256').update(verifier).digest('base64url');
    expect(pkceMatches(verifier, challenge)).toBe(true);
    expect(pkceMatches('w'.repeat(50), challenge)).toBe(false);
  });
});

describe('sign-in page headers', () => {
  it('let the form post here and its redirect go to the app', () => {
    const csp = signInPageHeaders('https://claude.ai/api/mcp/auth_callback', 'n0nce')[
      'Content-Security-Policy'
    ];
    expect(csp).toContain("form-action 'self' https://claude.ai;");
    expect(csp).toContain("script-src 'nonce-n0nce'");
    expect(csp).toContain("frame-ancestors 'none'");
    const local = signInPageHeaders('http://localhost:33418/callback', 'x')['Content-Security-Policy'];
    expect(local).toContain("form-action 'self' http://localhost:33418;");
  });
});

describe('permissions', () => {
  it('never include a delete permission', () => {
    for (const p of [...USER_PERMISSIONS, ...ADMIN_PERMISSIONS]) {
      expect(p).not.toMatch(/delete|all/i);
    }
  });

  it('give admin permissions only to admins', () => {
    expect(permissionsFor(false)).toEqual(USER_PERMISSIONS);
    expect(permissionsFor(true)).toEqual([...USER_PERMISSIONS, ...ADMIN_PERMISSIONS]);
  });
});

describe('token lifecycle', () => {
  const setup = () => {
    const store = new Store(':memory:');
    const provider = new ImmichOAuthProvider(store, config, '/mcp/oauth/login');
    const client = provider.clientsStore.registerClient({
      redirect_uris: ['https://claude.ai/api/mcp/auth_callback'],
      client_name: 'Claude',
      token_endpoint_auth_method: 'none',
    });
    const now = Math.floor(Date.now() / 1000);
    store.saveGrant({
      id: 'g1',
      clientId: client.client_id,
      userId: 'u1',
      email: 'a@example.com',
      name: 'A',
      isAdmin: false,
      apiKeyId: 'k1',
      apiKeySealed: 'sealed',
      scopes: ['immich'],
      createdAt: now,
    });
    store.savePending({
      id: 'p1',
      clientId: client.client_id,
      redirectUri: 'https://claude.ai/api/mcp/auth_callback',
      codeChallenge: 'challenge',
      state: 'xyz',
      scopes: ['immich'],
      expiresAt: now + 600,
    });
    return { store, provider, client };
  };

  it('rejects clients with redirect URIs outside the allow-list', () => {
    const { provider } = setup();
    expect(() =>
      provider.clientsStore.registerClient({ redirect_uris: ['https://evil.example/cb'] }),
    ).toThrow(/not allowed/);
  });

  it('issues a single-use code bound to its client', async () => {
    const { provider, client } = setup();
    const redirect = provider.issueCode('g1', 'p1');
    expect(redirect.origin + redirect.pathname).toBe('https://claude.ai/api/mcp/auth_callback');
    expect(redirect.searchParams.get('state')).toBe('xyz');
    expect(redirect.searchParams.get('iss')).toBe(config.publicUrl.href);
    const code = redirect.searchParams.get('code') as string;
    expect(await provider.challengeForAuthorizationCode(client, code)).toBe('challenge');
    const other = { ...client, client_id: 'someone-else' };
    await expect(provider.exchangeAuthorizationCode(other, code)).rejects.toThrow();
    const tokens = await provider.exchangeAuthorizationCode(client, code);
    expect(tokens.access_token).toBeTruthy();
    await expect(provider.exchangeAuthorizationCode(client, code)).rejects.toThrow();
    const info = await provider.verifyAccessToken(tokens.access_token);
    expect(info.extra?.grantId).toBe('g1');
    expect(() => provider.issueCode('g1', 'p1')).toThrow(/expired/);
  });

  it('rotates refresh tokens and ends the sign-in on late reuse', async () => {
    const { store, provider, client } = setup();
    const code = provider.issueCode('g1', 'p1').searchParams.get('code') as string;
    const first = await provider.exchangeAuthorizationCode(client, code);
    const second = await provider.exchangeRefreshToken(client, first.refresh_token as string);
    // A retry within the grace window still works.
    await provider.exchangeRefreshToken(client, first.refresh_token as string);
    store.db
      .prepare('UPDATE refresh_tokens SET used_at = used_at - ? WHERE token_hash = ?')
      .run(REFRESH_REUSE_GRACE_SECONDS + 1, hashToken(first.refresh_token as string));
    await expect(provider.exchangeRefreshToken(client, first.refresh_token as string)).rejects.toThrow(
      /reuse/,
    );
    expect(store.getGrant('g1')).toBeUndefined();
    await expect(provider.verifyAccessToken(second.access_token)).rejects.toThrow();
  });

  it('revoking a refresh token ends the sign-in', async () => {
    const { store, provider, client } = setup();
    const code = provider.issueCode('g1', 'p1').searchParams.get('code') as string;
    const tokens = await provider.exchangeAuthorizationCode(client, code);
    await provider.revokeToken(client, { token: tokens.refresh_token as string });
    expect(store.getGrant('g1')).toBeUndefined();
    await expect(provider.verifyAccessToken(tokens.access_token)).rejects.toThrow();
  });

  it('stores only token hashes', async () => {
    const { store, provider, client } = setup();
    const code = provider.issueCode('g1', 'p1').searchParams.get('code') as string;
    const tokens = await provider.exchangeAuthorizationCode(client, code);
    const dump = JSON.stringify([
      store.db.prepare('SELECT * FROM access_tokens').all(),
      store.db.prepare('SELECT * FROM refresh_tokens').all(),
    ]);
    expect(dump).not.toContain(tokens.access_token);
    expect(dump).not.toContain(tokens.refresh_token);
  });
});

describe('result helpers', () => {
  it('compact drops empty values, arrays and objects', () => {
    expect(
      compact({ a: 1, b: undefined, c: null, d: '', e: [], f: {}, g: { x: 1 }, h: 0, i: false }),
    ).toEqual({
      a: 1,
      g: { x: 1 },
      h: 0,
      i: false,
    });
  });

  it('takenAt says when a time is UTC or unknown', () => {
    const at = (localDateTime: string, fileCreatedAt: string, timeZone?: string) =>
      takenAt({ localDateTime, fileCreatedAt, exifInfo: { timeZone } });
    expect(at('2026-11-09T19:57:49.000Z', '2026-11-09T08:57:49.000Z', 'UTC+11')).toBe('2026-11-09 19:57');
    expect(at('2026-11-16T04:01:04.000Z', '2026-11-16T04:01:04.000Z')).toBe('2026-11-16 04:01 UTC');
    expect(at('1970-01-01T00:00:00.000Z', '1970-01-01T00:00:00.000Z')).toBe('unknown');
  });

  it('formatDuration writes m:ss and h:mm:ss', () => {
    expect(formatDuration(50551)).toBe('0:51');
    expect(formatDuration(3_723_000)).toBe('1:02:03');
  });

  it('mapLimit keeps order and never runs more than the limit at once', async () => {
    let running = 0;
    let peak = 0;
    const out = await mapLimit([5, 1, 4, 2, 3], 2, async (n) => {
      peak = Math.max(peak, ++running);
      await new Promise((r) => setTimeout(r, n));
      running--;
      return n * 10;
    });
    expect(out).toEqual([50, 10, 40, 20, 30]);
    expect(peak).toBe(2);
  });

  it('reads IMMICH_TIMEOUT', () => {
    expect(config.immichTimeoutSeconds).toBe(45);
    const other = loadConfig({
      PUBLIC_URL: 'https://p.example.com/mcp',
      IMMICH_URL: 'http://i',
      IMMICH_TIMEOUT: '5',
    });
    expect(other.immichTimeoutSeconds).toBe(5);
  });
});

describe('MCP endpoint', () => {
  /** An app whose Immich never answers, and an access token for it. */
  const setup = async (log: string[]) => {
    const store = new Store(':memory:');
    const box = new SecretBox(Buffer.alloc(32, 1));
    const cfg = loadConfig({
      PUBLIC_URL: 'https://photos.example.com/mcp',
      IMMICH_URL: 'http://immich:2283',
      IMMICH_TIMEOUT: '1',
    });
    const hang: typeof fetch = (_url, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason));
      });
    const app = createApp({ config: cfg, store, box, fetch: hang, log: (m) => log.push(m) });
    const provider = new ImmichOAuthProvider(store, cfg, '/mcp/oauth/login');
    const client = provider.clientsStore.registerClient({
      redirect_uris: ['https://claude.ai/api/mcp/auth_callback'],
      token_endpoint_auth_method: 'none',
    });
    const now = Math.floor(Date.now() / 1000);
    store.saveGrant({
      id: 'g1',
      clientId: client.client_id,
      userId: 'u1',
      email: 'a@example.com',
      name: 'A',
      isAdmin: false,
      apiKeyId: 'k1',
      apiKeySealed: box.seal('key'),
      scopes: ['immich'],
      createdAt: now,
    });
    store.savePending({
      id: 'p1',
      clientId: client.client_id,
      redirectUri: 'https://claude.ai/api/mcp/auth_callback',
      codeChallenge: 'c',
      state: 's',
      scopes: ['immich'],
      expiresAt: now + 600,
    });
    const code = provider.issueCode('g1', 'p1').searchParams.get('code') as string;
    const { access_token } = await provider.exchangeAuthorizationCode(client, code);
    const server = app.listen(0, '127.0.0.1');
    await new Promise((r) => server.once('listening', r));
    const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/mcp`;
    const post = (body: unknown, headers: Record<string, string> = {}) =>
      fetch(url, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${access_token}`,
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          ...headers,
        },
        body: JSON.stringify(body),
      });
    return { post, close: () => new Promise((r) => server.close(r)) };
  };

  it('ends a call Immich does not answer with a clear error, and logs it', async () => {
    const log: string[] = [];
    const { post, close } = await setup(log);
    try {
      const res = await post(
        { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'list_tags', arguments: {} } },
        { 'mcp-protocol-version': '2025-06-18' },
      );
      const body = (await res.json()) as { result: { isError: boolean; content: { text: string }[] } };
      expect(body.result.isError).toBe(true);
      expect(body.result.content[0]?.text).toMatch(/did not answer within 1 s/);
      expect(
        log.some((l) => /^tool list_tags for a@example.com: \d+ ms, error: Immich did not answer/.test(l)),
      ).toBe(true);
    } finally {
      await close();
    }
  });

  it('logs why it rejects an unsupported protocol version', async () => {
    const log: string[] = [];
    const { post, close } = await setup(log);
    try {
      const res = await post(
        { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} },
        { 'mcp-protocol-version': '2099-01-01' },
      );
      expect(res.status).toBe(400);
      expect(log.join('\n')).toMatch(
        /Unsupported protocol version: 2099-01-01.*mcp-protocol-version: 2099-01-01/,
      );
    } finally {
      await close();
    }
  });
});
