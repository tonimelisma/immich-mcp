/**
 * End to end against a throwaway Immich (e2e/docker-compose.yml): the OAuth sign-in as a browser and a
 * client would do it, then every tool through the MCP client. Run with `npm run test:e2e`.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { createHash, randomBytes } from 'node:crypto';
import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';
import type { Server } from 'node:http';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { loadConfig } from '../src/config.js';
import { SecretBox } from '../src/crypto.js';
import { ADMIN_PERMISSIONS, USER_PERMISSIONS } from '../src/immich.js';
import { createApp } from '../src/server.js';
import { Store } from '../src/store.js';

const IMMICH = process.env.E2E_IMMICH_URL ?? 'http://127.0.0.1:2299';
const RUN = randomBytes(3).toString('hex');
const ADMIN = { email: 'admin@e2e.test', password: 'admin-password', name: 'Admin' };
const MEMBER = { email: `member-${RUN}@e2e.test`, password: 'member-password', name: 'Member' };
const CALLBACK = 'http://localhost:9/callback';
const FIXTURES = join(import.meta.dirname, 'fixtures');

type Json = Record<string, unknown>;

async function api(
  path: string,
  init: { token?: string; apiKey?: string; method?: string; body?: unknown } = {},
) {
  const headers: Record<string, string> = {};
  if (init.token) headers.authorization = `Bearer ${init.token}`;
  if (init.apiKey) headers['x-api-key'] = init.apiKey;
  let body: BodyInit | undefined;
  if (init.body instanceof FormData) body = init.body;
  else if (init.body !== undefined) {
    headers['content-type'] = 'application/json';
    body = JSON.stringify(init.body);
  }
  const res = await fetch(`${IMMICH}/api${path}`, {
    method: init.method ?? (body ? 'POST' : 'GET'),
    headers,
    body,
  });
  const text = await res.text();
  return { status: res.status, data: (text ? JSON.parse(text) : undefined) as unknown };
}

async function claudeKeys(token: string): Promise<Json[]> {
  return ((await api('/api-keys', { token })).data as Json[]).filter((k) => k.name === 'Claude (immich-mcp)');
}

async function login(user: { email: string; password: string }): Promise<string> {
  const res = await api('/auth/login', { body: { email: user.email, password: user.password } });
  if (res.status !== 201) throw new Error(`login ${user.email}: ${res.status} ${JSON.stringify(res.data)}`);
  return (res.data as Json).accessToken as string;
}

async function upload(token: string, file: string, takenAt: string): Promise<string> {
  const form = new FormData();
  form.set('assetData', new Blob([readFileSync(join(FIXTURES, file))], { type: 'image/jpeg' }), file);
  form.set('fileCreatedAt', takenAt);
  form.set('fileModifiedAt', takenAt);
  const res = await api('/assets', { token, body: form });
  if (res.status !== 201 && res.status !== 200)
    throw new Error(`upload ${file}: ${res.status} ${JSON.stringify(res.data)}`);
  return (res.data as Json).id as string;
}

async function until<T>(what: string, probe: () => Promise<T | undefined>, seconds = 120): Promise<T> {
  for (let i = 0; i < seconds; i++) {
    const value = await probe();
    if (value !== undefined) return value;
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`timed out waiting for ${what}`);
}

const freePort = () =>
  new Promise<number>((resolve) => {
    const srv = createServer().listen(0, '127.0.0.1', () => {
      const port = (srv.address() as { port: number }).port;
      srv.close(() => resolve(port));
    });
  });

const text = (result: unknown): string =>
  ((result as CallToolResult).content.find((c) => c.type === 'text') as { text: string } | undefined)?.text ??
  '';
const parsed = <T = Json>(result: unknown): T => JSON.parse(text(result)) as T;

let server: Server;
let store: Store;
let box: SecretBox;
let base: string;
let memberToken: string;
let adminToken: string;
const ids: Record<'beach' | 'sign' | 'forest', string> = { beach: '', sign: '', forest: '' };
let faceId: string;
const people = { alice: `Alice ${RUN}`, bob: `Bob ${RUN}`, carol: `Carol ${RUN}` };

beforeAll(async () => {
  await until('Immich', async () =>
    (await fetch(`${IMMICH}/api/server/ping`).catch(() => undefined))?.ok ? true : undefined,
  );
  await api('/auth/admin-sign-up', { body: ADMIN }); // 400 when it already exists
  adminToken = await login(ADMIN);
  const created = await api('/admin/users', { token: adminToken, body: MEMBER });
  expect(created.status).toBe(201);
  memberToken = await login(MEMBER);

  ids.beach = await upload(memberToken, 'beach.jpg', '2024-07-14T15:30:00.000Z');
  ids.sign = await upload(memberToken, 'sign.jpg', '2023-12-24T10:00:00.000Z');
  ids.forest = await upload(memberToken, 'forest.jpg', '2022-05-01T16:15:00.000Z');
  await until('metadata extraction', async () => {
    const res = await api(`/assets/${ids.forest}`, { token: memberToken });
    return ((res.data as Json).exifInfo as Json | undefined)?.dateTimeOriginal ? true : undefined;
  });

  const person = async (name: string) =>
    ((await api('/people', { token: memberToken, body: { name } })).data as Json).id as string;
  const alice = await person(people.alice);
  const bob = await person(people.bob);
  await person(people.carol);
  for (const [asset, who] of [
    [ids.beach, alice],
    [ids.forest, bob],
  ] as const) {
    const res = await api('/faces', {
      token: memberToken,
      body: {
        assetId: asset,
        personId: who,
        imageWidth: 640,
        imageHeight: 480,
        x: 100,
        y: 100,
        width: 80,
        height: 80,
      },
    });
    expect(res.status).toBe(201);
  }
  const faces = (await api(`/faces?id=${ids.forest}`, { token: memberToken })).data as Json[];
  faceId = faces[0]?.id as string;
  await api('/albums', { token: memberToken, body: { albumName: `Summer ${RUN}`, assetIds: [ids.beach] } });

  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  const config = loadConfig({
    PUBLIC_URL: `${base}/mcp`,
    IMMICH_URL: IMMICH,
    IMMICH_PUBLIC_URL: 'https://photos.example.com',
    KEY_GRACE_SECONDS: '0',
  });
  store = new Store(':memory:');
  box = new SecretBox(randomBytes(32));
  const app = createApp({ config, store, box, log: () => undefined });
  await new Promise<void>((resolve) => {
    server = app.listen(port, '127.0.0.1', () => resolve());
  });
}, 300_000);

afterAll(async () => {
  await new Promise((resolve) => server?.close(resolve));
  store?.close();
});

interface Tokens {
  access_token: string;
  refresh_token: string;
  clientId: string;
}

async function register(redirect = CALLBACK) {
  return fetch(`${base}/mcp/oauth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      redirect_uris: [redirect],
      client_name: 'e2e',
      token_endpoint_auth_method: 'none',
    }),
  });
}

function authorizationUrl(clientId: string) {
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  const url = new URL(`${base}/mcp/oauth/authorize`);
  url.search = new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: CALLBACK,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state: 'state-1',
    scope: 'immich',
    resource: `${base}/mcp`,
  }).toString();
  return { url: url.href, verifier };
}

async function startAuthorization(clientId: string) {
  const { url, verifier } = authorizationUrl(clientId);
  const page = await fetch(url);
  const html = await page.text();
  const requestId = /name="request_id" value="([^"]+)"/.exec(html)?.[1];
  return { page, html, requestId: requestId as string, verifier };
}

async function submitLogin(requestId: string, email: string, password: string) {
  return fetch(`${base}/mcp/oauth/login`, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ request_id: requestId, email, password }),
  });
}

async function tokenRequest(params: Record<string, string>) {
  return fetch(`${base}/mcp/oauth/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params),
  });
}

async function signIn(user: { email: string; password: string }, clientId?: string): Promise<Tokens> {
  const id = clientId ?? (((await (await register()).json()) as Json).client_id as string);
  const { requestId, verifier } = await startAuthorization(id);
  const done = await submitLogin(requestId, user.email, user.password);
  expect(done.status).toBe(302);
  const code = new URL(done.headers.get('location') as string).searchParams.get('code') as string;
  const res = await tokenRequest({
    grant_type: 'authorization_code',
    code,
    code_verifier: verifier,
    client_id: id,
    redirect_uri: CALLBACK,
    resource: `${base}/mcp`,
  });
  expect(res.status).toBe(200);
  return { ...((await res.json()) as { access_token: string; refresh_token: string }), clientId: id };
}

async function connect(accessToken: string): Promise<Client> {
  const client = new Client({ name: 'e2e', version: '1' });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
      requestInit: { headers: { authorization: `Bearer ${accessToken}` } },
    }),
  );
  return client;
}

describe('OAuth', () => {
  it('publishes discovery documents and challenges unauthenticated calls', async () => {
    const prm = (await (await fetch(`${base}/.well-known/oauth-protected-resource/mcp`)).json()) as Json;
    expect(prm.resource).toBe(`${base}/mcp`);
    expect(prm.authorization_servers).toEqual([`${base}/mcp`]);
    for (const path of [
      '/.well-known/oauth-authorization-server/mcp',
      '/mcp/.well-known/openid-configuration',
    ]) {
      const meta = (await (await fetch(`${base}${path}`)).json()) as Json;
      expect(meta.authorization_endpoint).toBe(`${base}/mcp/oauth/authorize`);
      expect(meta.code_challenge_methods_supported).toEqual(['S256']);
    }
    const res = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toContain('resource_metadata=');
  });

  it('refuses redirect URIs outside the allow-list', async () => {
    expect((await register('https://evil.example/cb')).status).toBe(400);
  });

  it('shows the sign-in page, rejects a wrong password and needs the right PKCE verifier', async () => {
    const id = ((await (await register()).json()) as Json).client_id as string;
    const { page, html, requestId, verifier } = await startAuthorization(id);
    expect(page.status).toBe(200);
    expect(page.headers.get('x-frame-options')).toBe('DENY');
    expect(html).toContain('It cannot delete anything');
    const wrong = await submitLogin(requestId, MEMBER.email, 'wrong');
    expect(wrong.status).toBe(401);
    expect(await wrong.text()).toContain('Wrong email or password');
    const ok = await submitLogin(requestId, MEMBER.email, MEMBER.password);
    expect(ok.status).toBe(302);
    const location = new URL(ok.headers.get('location') as string);
    expect(location.searchParams.get('state')).toBe('state-1');
    const code = location.searchParams.get('code') as string;
    const params = { grant_type: 'authorization_code', code, client_id: id, redirect_uri: CALLBACK };
    expect((await tokenRequest({ ...params, code_verifier: 'x'.repeat(43) })).status).toBe(400);
    expect((await tokenRequest({ ...params, code_verifier: verifier })).status).toBe(200);
    expect((await tokenRequest({ ...params, code_verifier: verifier })).status).toBe(400);
  });

  it('keeps one scoped API key per user and app, replaced on each sign-in', async () => {
    // claude.ai registers a new client on every connect, so a fresh client with the same callback
    // counts as the same app.
    await signIn(MEMBER);
    await signIn(MEMBER);
    await signIn(MEMBER);
    const keys = await until(
      'old keys to be deleted',
      async () => {
        const all = await claudeKeys(memberToken);
        return all.length === 1 ? all : undefined;
      },
      20,
    );
    expect([...(keys[0]?.permissions as string[])].sort()).toEqual([...USER_PERMISSIONS].sort());
  });

  it('deletes keys left by expired sign-ins, and nothing else', async () => {
    const make = async (name: string) =>
      (
        (await api('/api-keys', { token: memberToken, body: { name, permissions: ['asset.read'] } }))
          .data as Json
      ).apiKey as Json;
    const stray = await make('Claude (immich-mcp)');
    const other = await make('Some other app');
    await signIn(MEMBER);
    await until(
      'the stray key to be deleted',
      async () => {
        const ids = ((await api('/api-keys', { token: memberToken })).data as Json[]).map((k) => k.id);
        return ids.includes(stray.id) ? undefined : ids;
      },
      20,
    );
    const names = ((await api('/api-keys', { token: memberToken })).data as Json[]).map((k) => k.name);
    expect(names).toContain('Some other app');
    expect(names.filter((n) => n === 'Claude (immich-mcp)')).toHaveLength(1);
    await api(`/api-keys/${other.id as string}`, { token: memberToken, method: 'DELETE' });
  });

  it('a second submit of the same form joins the first instead of failing', async () => {
    const id = ((await (await register()).json()) as Json).client_id as string;
    const { requestId } = await startAuthorization(id);
    const [first, second] = await Promise.all([
      submitLogin(requestId, MEMBER.email, MEMBER.password),
      submitLogin(requestId, MEMBER.email, MEMBER.password),
    ]);
    expect(first.status).toBe(302);
    expect(second.status).toBe(302);
    expect(second.headers.get('location')).toBe(first.headers.get('location'));
    // ...and one more after it finished, as a reload would.
    const third = await submitLogin(requestId, MEMBER.email, MEMBER.password);
    expect(third.status).toBe(302);
    expect(third.headers.get('location')).toBe(first.headers.get('location'));
    await until('one key', async () => ((await claudeKeys(memberToken)).length === 1 ? true : undefined), 20);
  });

  it('signs in from a real browser, which enforces the page security policy', async () => {
    const browser = await chromium.launch(
      process.env.PLAYWRIGHT_CHROMIUM ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM } : {},
    );
    try {
      const page = await browser.newPage();
      const reachedCallback = page.waitForRequest((r) => r.url().startsWith(CALLBACK), { timeout: 60_000 });
      await page.route(`${CALLBACK}**`, (route) => route.fulfill({ status: 200, body: 'callback reached' }));
      const id = ((await (await register()).json()) as Json).client_id as string;
      const { url } = authorizationUrl(id);
      const blocked: string[] = [];
      page.on('console', (m) => {
        if (/Content Security Policy|Refused/i.test(m.text())) blocked.push(m.text());
      });
      await page.goto(url);
      await page.fill('#email', MEMBER.email);
      await page.fill('#password', MEMBER.password);
      await page.click('button[type=submit]');
      const callback = new URL((await reachedCallback).url());
      expect(callback.searchParams.get('code')).toBeTruthy();
      expect(callback.searchParams.get('state')).toBe('state-1');
      expect(blocked).toEqual([]);
    } finally {
      await browser.close();
    }
  });

  it('refresh tokens rotate', async () => {
    const tokens = await signIn(MEMBER);
    const res = await tokenRequest({
      grant_type: 'refresh_token',
      refresh_token: tokens.refresh_token,
      client_id: tokens.clientId,
    });
    expect(res.status).toBe(200);
    const next = (await res.json()) as Tokens;
    expect(next.refresh_token).not.toBe(tokens.refresh_token);
    const client = await connect(next.access_token);
    expect((await client.listTools()).tools.length).toBeGreaterThan(5);
    await client.close();
  });
});

describe('tools as a regular user', () => {
  let client: Client;
  const call = async (name: string, args: Json = {}) => {
    const result = await client.callTool({ name, arguments: args });
    if (result.isError) throw new Error(`${name}: ${text(result)}`);
    return result;
  };

  beforeAll(async () => {
    client = await connect((await signIn(MEMBER)).access_token);
  });
  afterAll(async () => client?.close());

  it('offers no admin or delete tools', async () => {
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names).toContain('search_photos');
    expect(names.some((n) => n.startsWith('admin_'))).toBe(false);
    expect(names.some((n) => /delete|trash|remove_photo/.test(n))).toBe(false);
  });

  it('about_connection names the user', async () => {
    const about = parsed(await call('about_connection'));
    expect(about.email).toBe(MEMBER.email);
    expect(about.admin).toBe(false);
  });

  it('search_photos filters by date, person, album and file name', async () => {
    const byDate = parsed<{ photos: Json[] }>(
      await call('search_photos', { taken_after: '2023-12-01', taken_before: '2023-12-31' }),
    );
    expect(byDate.photos.map((p) => p.id)).toEqual([ids.sign]);
    const byPerson = parsed<{ photos: Json[] }>(await call('search_photos', { people: [people.alice] }));
    expect(byPerson.photos.map((p) => p.id)).toEqual([ids.beach]);
    expect(byPerson.photos[0]?.url).toBe(`https://photos.example.com/photos/${ids.beach}`);
    const byAlbum = parsed<{ photos: Json[] }>(await call('search_photos', { album: `Summer ${RUN}` }));
    expect(byAlbum.photos.map((p) => p.id)).toEqual([ids.beach]);
    const byName = parsed<{ photos: Json[] }>(await call('search_photos', { file_name: 'forest' }));
    expect(byName.photos.map((p) => p.id)).toEqual([ids.forest]);
    const oldest = parsed<{ photos: Json[] }>(await call('search_photos', { order: 'oldest', limit: 1 }));
    expect(oldest.photos[0]?.id).toBe(ids.forest);
    const unknown = await client.callTool({
      name: 'search_photos',
      arguments: { people: ['Nobody At All'] },
    });
    expect(unknown.isError).toBe(true);
  });

  it('view_photos returns images', async () => {
    const result = (await call('view_photos', { ids: [ids.beach, ids.sign] })) as CallToolResult;
    const images = result.content.filter((c) => c.type === 'image');
    expect(images).toHaveLength(2);
    expect((images[0] as { mimeType: string }).mimeType).toMatch(/^image\//);
    expect((images[0] as { data: string }).data.length).toBeGreaterThan(1000);
    const small = (await call('view_photos', { ids: [ids.forest], size: 'small' })) as CallToolResult;
    expect(small.content.filter((c) => c.type === 'image')).toHaveLength(1);
  });

  it('get_photo_details shows date, GPS and faces', async () => {
    const [forest] = parsed<Json[]>(await call('get_photo_details', { ids: [ids.forest] }));
    expect(forest?.taken).toBe('2022-05-01 09:15');
    expect((forest?.gps as Json).latitude).toBeCloseTo(37.7456, 3);
    expect((forest?.faces as Json[])[0]).toMatchObject({ person: people.bob, person_id: expect.any(String) });
    expect(forest?.type).toBe('photo');
  });

  it('list_people, list_albums, list_tags and search_suggestions', async () => {
    const list = parsed<{ people: Json[] }>(await call('list_people', { name: RUN, with_counts: true }));
    const alice = list.people.find((p) => p.name === people.alice);
    expect(alice?.photos).toBe(1);
    const albums = parsed<Json[]>(await call('list_albums', { name: RUN }));
    expect(albums).toEqual([expect.objectContaining({ name: `Summer ${RUN}`, photos: 1 })]);
    expect(parsed<Json[]>(await call('list_tags'))).toEqual(expect.any(Array));
    expect(parsed<string[]>(await call('search_suggestions', { field: 'camera_make' }))).toEqual(
      expect.any(Array),
    );
  });

  it('update_photos sets description, favorite, rating and location', async () => {
    await call('update_photos', {
      ids: [ids.sign],
      description: 'Greeting card',
      favorite: true,
      rating: 4,
      latitude: 60.45,
      longitude: 22.27,
    });
    const found = parsed<{ photos: Json[] }>(await call('search_photos', { description: 'Greeting' }));
    expect(found.photos.map((p) => p.id)).toEqual([ids.sign]);
    expect(found.photos[0]).toMatchObject({ favorite: true, rating: 4 });
    const bad = await client.callTool({ name: 'update_photos', arguments: { ids: [ids.sign], rating: 0 } });
    expect(bad.isError).toBe(true);
  });

  it('tag_photos and untag_photos', async () => {
    await call('tag_photos', { ids: [ids.beach, ids.forest], tags: [`Trips ${RUN}/Outdoors`] });
    const tagged = parsed<{ photos: Json[] }>(
      await call('search_photos', { tags: [`Trips ${RUN}/Outdoors`] }),
    );
    expect(tagged.photos.map((p) => p.id).sort()).toEqual([ids.beach, ids.forest].sort());
    await call('untag_photos', { ids: [ids.forest], tags: [`Trips ${RUN}/Outdoors`] });
    const left = parsed<{ photos: Json[] }>(await call('search_photos', { tags: [`Trips ${RUN}/Outdoors`] }));
    expect(left.photos.map((p) => p.id)).toEqual([ids.beach]);
  });

  it('update_person, create_person, reassign_face and merge_people', async () => {
    const updated = parsed(await call('update_person', { person: people.alice, birth_date: '2020-04-24' }));
    expect(updated.birth_date).toBe('2020-04-24');
    const dave = parsed(await call('create_person', { name: `Dave ${RUN}` }));
    await call('reassign_face', { face_id: faceId, person: dave.id as string });
    const forDave = parsed<{ photos: Json[] }>(await call('search_photos', { people: [`Dave ${RUN}`] }));
    expect(forDave.photos.map((p) => p.id)).toEqual([ids.forest]);
    const merged = parsed(await call('merge_people', { into: people.carol, from: [`Dave ${RUN}`] }));
    expect(merged.merged).toBeGreaterThanOrEqual(1);
    const forCarol = parsed<{ photos: Json[] }>(await call('search_photos', { people: [people.carol] }));
    expect(forCarol.photos.map((p) => p.id)).toEqual([ids.forest]);
  });
});

// Needs the machine-learning container: E2E_ML=1 with `docker compose --profile ml`.
describe.runIf(process.env.E2E_ML === '1')('smart search and OCR', () => {
  let client: Client;
  beforeAll(async () => {
    client = await connect((await signIn(MEMBER)).access_token);
    await until(
      'smart search and OCR jobs',
      async () => {
        const queues = (await api('/queues', { token: adminToken })).data as Json[];
        const busy = queues
          .filter((q) => ['smartSearch', 'ocr'].includes(q.name as string))
          .some((q) => (q.statistics as Json).active || (q.statistics as Json).waiting);
        return busy ? undefined : true;
      },
      600,
    );
  }, 700_000);
  afterAll(async () => client?.close());

  it('finds a photo by what it shows', async () => {
    const res = parsed<{ photos: Json[] }>(
      await client.callTool({
        name: 'search_photos',
        arguments: { query: 'a sign with black text', limit: 3 },
      }),
    );
    expect(res.photos[0]?.id).toBe(ids.sign);
  });

  it('finds a photo by the text in it', async () => {
    const res = parsed<{ photos: Json[] }>(
      await client.callTool({ name: 'search_photos', arguments: { text_in_photo: 'HELLO' } }),
    );
    expect(res.photos.map((p) => p.id)).toContain(ids.sign);
    const [details] = parsed<Json[]>(
      await client.callTool({
        name: 'get_photo_details',
        arguments: { ids: [ids.sign], include_text: true },
      }),
    );
    expect(String(details?.text)).toMatch(/HELLO/i);
  });
});

describe('safety', () => {
  it('the stored API key cannot delete anything', async () => {
    await signIn(MEMBER);
    const row = store.db
      .prepare('SELECT api_key_sealed FROM grants ORDER BY rowid DESC LIMIT 1')
      .get() as Json;
    const apiKey = box.open(row.api_key_sealed as string);
    // The key works for what the tools do...
    expect((await api(`/assets/${ids.beach}`, { apiKey })).status).toBe(200);
    // ...and Immich refuses every delete, whatever the server's code would try.
    const attempts = [
      api('/assets', { apiKey, method: 'DELETE', body: { ids: [ids.beach], force: true } }),
      api('/trash/empty', { apiKey, method: 'POST' }),
      api(`/albums`, { apiKey }).then(async (albums) =>
        api(`/albums/${((albums.data as Json[])[0] as Json).id as string}`, { apiKey, method: 'DELETE' }),
      ),
      api('/people', { apiKey, method: 'DELETE', body: { ids: [ids.beach] } }),
      api('/api-keys', { apiKey }),
    ];
    for (const res of await Promise.all(attempts)) expect(res.status).toBe(403);
    expect((await api(`/assets/${ids.beach}`, { apiKey })).status).toBe(200);
  });

  it('deleting the key in Immich ends the connection', async () => {
    const tokens = await signIn(MEMBER);
    const client = await connect(tokens.access_token);
    const keys = (await api('/api-keys', { token: memberToken })).data as Json[];
    for (const key of keys)
      await api(`/api-keys/${key.id as string}`, { token: memberToken, method: 'DELETE' });
    const result = await client.callTool({ name: 'about_connection', arguments: {} });
    expect(result.isError).toBe(true);
    expect(text(result)).toContain('Reconnect');
    const after = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: { authorization: `Bearer ${tokens.access_token}`, 'content-type': 'application/json' },
      body: '{}',
    });
    expect(after.status).toBe(401);
    await client.close().catch(() => undefined);
  });
});

describe('admin', () => {
  let client: Client;
  beforeAll(async () => {
    client = await connect((await signIn(ADMIN)).access_token);
  });
  afterAll(async () => client?.close());

  it('gets admin tools and an admin-scoped key', async () => {
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names).toEqual(
      expect.arrayContaining(['admin_server_overview', 'admin_list_users', 'admin_job_queues']),
    );
    const keys = ((await api('/api-keys', { token: adminToken })).data as Json[]).filter(
      (k) => k.name === 'Claude (immich-mcp)',
    );
    expect([...(keys[0]?.permissions as string[])].sort()).toEqual(
      [...USER_PERMISSIONS, ...ADMIN_PERMISSIONS].sort(),
    );
  });

  it('admin tools work', async () => {
    const overview = parsed(await client.callTool({ name: 'admin_server_overview', arguments: {} }));
    expect((overview.totals as Json).photos).toBeGreaterThanOrEqual(3);
    expect((overview.totals as Json).uploaded_files).toMatch(/GiB$/);
    const users = parsed<Json[]>(await client.callTool({ name: 'admin_list_users', arguments: {} }));
    expect(users.map((u) => u.email)).toContain(MEMBER.email);
    const queues = parsed<{ busy: Json[]; idle: string[] }>(
      await client.callTool({ name: 'admin_job_queues', arguments: {} }),
    );
    expect([...queues.busy.map((q) => q.queue), ...queues.idle]).toContain('thumbnailGeneration');
    for (const q of queues.busy) expect(q).not.toHaveProperty('completed');
    for (const action of ['pause', 'resume', 'start']) {
      const res = await client.callTool({
        name: 'admin_queue_control',
        arguments: { queue: 'sidecar', action },
      });
      expect(res.isError, text(res)).toBeFalsy();
    }
  });
});
