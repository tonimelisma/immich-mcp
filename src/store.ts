import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { OAuthClientInformationFull } from '@modelcontextprotocol/sdk/shared/auth.js';

export interface PendingAuthorization {
  id: string;
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  state?: string;
  scopes: string[];
  resource?: string;
  expiresAt: number;
}

export interface AuthorizationCode {
  grantId: string;
  clientId: string;
  codeChallenge: string;
  redirectUri: string;
  resource?: string;
  expiresAt: number;
}

/** One sign-in: an Immich user, the client they signed in to, and the API key created for it. */
export interface Grant {
  id: string;
  clientId: string;
  userId: string;
  email: string;
  name: string;
  isAdmin: boolean;
  apiKeyId: string;
  apiKeySealed: string;
  scopes: string[];
  resource?: string;
  createdAt: number;
}

export interface RefreshToken {
  grantId: string;
  expiresAt: number;
  usedAt?: number;
}

export interface AccessToken {
  grantId: string;
  expiresAt: number;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS clients (
  client_id TEXT PRIMARY KEY,
  info TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS pending_authorizations (
  id TEXT PRIMARY KEY,
  client_id TEXT NOT NULL,
  redirect_uri TEXT NOT NULL,
  code_challenge TEXT NOT NULL,
  state TEXT,
  scopes TEXT NOT NULL,
  resource TEXT,
  expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS grants (
  id TEXT PRIMARY KEY,
  client_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  email TEXT NOT NULL,
  name TEXT NOT NULL,
  is_admin INTEGER NOT NULL,
  api_key_id TEXT NOT NULL,
  api_key_sealed TEXT NOT NULL,
  scopes TEXT NOT NULL,
  resource TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS grants_user_client ON grants (user_id, client_id);
CREATE TABLE IF NOT EXISTS authorization_codes (
  code_hash TEXT PRIMARY KEY,
  grant_id TEXT NOT NULL REFERENCES grants (id) ON DELETE CASCADE,
  client_id TEXT NOT NULL,
  code_challenge TEXT NOT NULL,
  redirect_uri TEXT NOT NULL,
  resource TEXT,
  expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS access_tokens (
  token_hash TEXT PRIMARY KEY,
  grant_id TEXT NOT NULL REFERENCES grants (id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS refresh_tokens (
  token_hash TEXT PRIMARY KEY,
  grant_id TEXT NOT NULL REFERENCES grants (id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL,
  used_at INTEGER
);
`;

type Row = Record<string, unknown>;

const str = (v: unknown): string => String(v);
const optStr = (v: unknown): string | undefined => (v === null || v === undefined ? undefined : String(v));
const num = (v: unknown): number => Number(v);

export class Store {
  readonly db: DatabaseSync;

  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
    this.db.exec(SCHEMA);
  }

  static open(dataDir: string): Store {
    mkdirSync(dataDir, { recursive: true });
    return new Store(join(dataDir, 'immich-mcp.sqlite'));
  }

  close(): void {
    this.db.close();
  }

  // Clients

  getClient(clientId: string): OAuthClientInformationFull | undefined {
    const row = this.db.prepare('SELECT info FROM clients WHERE client_id = ?').get(clientId) as
      Row | undefined;
    return row ? (JSON.parse(str(row.info)) as OAuthClientInformationFull) : undefined;
  }

  saveClient(client: OAuthClientInformationFull, now: number): void {
    this.db
      .prepare('INSERT INTO clients (client_id, info, created_at) VALUES (?, ?, ?)')
      .run(client.client_id, JSON.stringify(client), now);
  }

  // Pending authorizations (the login form is open)

  savePending(p: PendingAuthorization): void {
    this.db
      .prepare(
        `INSERT INTO pending_authorizations
         (id, client_id, redirect_uri, code_challenge, state, scopes, resource, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        p.id,
        p.clientId,
        p.redirectUri,
        p.codeChallenge,
        p.state ?? null,
        JSON.stringify(p.scopes),
        p.resource ?? null,
        p.expiresAt,
      );
  }

  getPending(id: string, now: number): PendingAuthorization | undefined {
    const row = this.db
      .prepare('SELECT * FROM pending_authorizations WHERE id = ? AND expires_at > ?')
      .get(id, now) as Row | undefined;
    if (!row) return undefined;
    return {
      id: str(row.id),
      clientId: str(row.client_id),
      redirectUri: str(row.redirect_uri),
      codeChallenge: str(row.code_challenge),
      state: optStr(row.state),
      scopes: JSON.parse(str(row.scopes)) as string[],
      resource: optStr(row.resource),
      expiresAt: num(row.expires_at),
    };
  }

  deletePending(id: string): void {
    this.db.prepare('DELETE FROM pending_authorizations WHERE id = ?').run(id);
  }

  // Grants

  saveGrant(g: Grant): void {
    this.db
      .prepare(
        `INSERT INTO grants
         (id, client_id, user_id, email, name, is_admin, api_key_id, api_key_sealed, scopes, resource, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        g.id,
        g.clientId,
        g.userId,
        g.email,
        g.name,
        g.isAdmin ? 1 : 0,
        g.apiKeyId,
        g.apiKeySealed,
        JSON.stringify(g.scopes),
        g.resource ?? null,
        g.createdAt,
      );
  }

  private grantFrom(row: Row): Grant {
    return {
      id: str(row.id),
      clientId: str(row.client_id),
      userId: str(row.user_id),
      email: str(row.email),
      name: str(row.name),
      isAdmin: num(row.is_admin) === 1,
      apiKeyId: str(row.api_key_id),
      apiKeySealed: str(row.api_key_sealed),
      scopes: JSON.parse(str(row.scopes)) as string[],
      resource: optStr(row.resource),
      createdAt: num(row.created_at),
    };
  }

  getGrant(id: string): Grant | undefined {
    const row = this.db.prepare('SELECT * FROM grants WHERE id = ?').get(id) as Row | undefined;
    return row ? this.grantFrom(row) : undefined;
  }

  grantsForUser(userId: string): Grant[] {
    return (this.db.prepare('SELECT * FROM grants WHERE user_id = ?').all(userId) as Row[]).map((row) =>
      this.grantFrom(row),
    );
  }

  /** Removes the grant and, through the foreign keys, every code and token issued under it. */
  deleteGrant(id: string): void {
    this.db.prepare('DELETE FROM grants WHERE id = ?').run(id);
  }

  // Authorization codes

  saveCode(codeHash: string, c: AuthorizationCode): void {
    this.db
      .prepare(
        `INSERT INTO authorization_codes
         (code_hash, grant_id, client_id, code_challenge, redirect_uri, resource, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(codeHash, c.grantId, c.clientId, c.codeChallenge, c.redirectUri, c.resource ?? null, c.expiresAt);
  }

  private codeFrom(row: Row): AuthorizationCode {
    return {
      grantId: str(row.grant_id),
      clientId: str(row.client_id),
      codeChallenge: str(row.code_challenge),
      redirectUri: str(row.redirect_uri),
      resource: optStr(row.resource),
      expiresAt: num(row.expires_at),
    };
  }

  getCode(codeHash: string, now: number): AuthorizationCode | undefined {
    const row = this.db
      .prepare('SELECT * FROM authorization_codes WHERE code_hash = ? AND expires_at > ?')
      .get(codeHash, now) as Row | undefined;
    return row ? this.codeFrom(row) : undefined;
  }

  /** Returns the code and deletes it, so it works exactly once. */
  takeCode(codeHash: string, now: number): AuthorizationCode | undefined {
    const row = this.db
      .prepare('DELETE FROM authorization_codes WHERE code_hash = ? AND expires_at > ? RETURNING *')
      .get(codeHash, now) as Row | undefined;
    return row ? this.codeFrom(row) : undefined;
  }

  // Tokens

  saveAccessToken(tokenHash: string, t: AccessToken): void {
    this.db
      .prepare('INSERT INTO access_tokens (token_hash, grant_id, expires_at) VALUES (?, ?, ?)')
      .run(tokenHash, t.grantId, t.expiresAt);
  }

  getAccessToken(tokenHash: string, now: number): AccessToken | undefined {
    const row = this.db
      .prepare('SELECT grant_id, expires_at FROM access_tokens WHERE token_hash = ? AND expires_at > ?')
      .get(tokenHash, now) as Row | undefined;
    return row ? { grantId: str(row.grant_id), expiresAt: num(row.expires_at) } : undefined;
  }

  deleteAccessToken(tokenHash: string): void {
    this.db.prepare('DELETE FROM access_tokens WHERE token_hash = ?').run(tokenHash);
  }

  saveRefreshToken(tokenHash: string, t: RefreshToken): void {
    this.db
      .prepare('INSERT INTO refresh_tokens (token_hash, grant_id, expires_at, used_at) VALUES (?, ?, ?, ?)')
      .run(tokenHash, t.grantId, t.expiresAt, t.usedAt ?? null);
  }

  getRefreshToken(tokenHash: string, now: number): RefreshToken | undefined {
    const row = this.db
      .prepare('SELECT * FROM refresh_tokens WHERE token_hash = ? AND expires_at > ?')
      .get(tokenHash, now) as Row | undefined;
    if (!row) return undefined;
    return {
      grantId: str(row.grant_id),
      expiresAt: num(row.expires_at),
      usedAt: row.used_at === null ? undefined : num(row.used_at),
    };
  }

  markRefreshTokenUsed(tokenHash: string, now: number): void {
    this.db
      .prepare('UPDATE refresh_tokens SET used_at = ? WHERE token_hash = ? AND used_at IS NULL')
      .run(now, tokenHash);
  }

  deleteRefreshToken(tokenHash: string): void {
    this.db.prepare('DELETE FROM refresh_tokens WHERE token_hash = ?').run(tokenHash);
  }

  /** Grants whose every refresh token has expired are dead; returns them so their API keys can be reported. */
  purgeExpired(now: number): Grant[] {
    this.db.prepare('DELETE FROM pending_authorizations WHERE expires_at <= ?').run(now);
    this.db.prepare('DELETE FROM authorization_codes WHERE expires_at <= ?').run(now);
    this.db.prepare('DELETE FROM access_tokens WHERE expires_at <= ?').run(now);
    this.db.prepare('DELETE FROM refresh_tokens WHERE expires_at <= ?').run(now);
    const dead = (
      this.db
        .prepare(
          `SELECT * FROM grants g WHERE created_at <= ?
           AND NOT EXISTS (SELECT 1 FROM refresh_tokens r WHERE r.grant_id = g.id)
           AND NOT EXISTS (SELECT 1 FROM access_tokens a WHERE a.grant_id = g.id)
           AND NOT EXISTS (SELECT 1 FROM authorization_codes c WHERE c.grant_id = g.id)`,
        )
        .all(now - 3600) as Row[]
    ).map((row) => this.grantFrom(row));
    for (const g of dead) this.deleteGrant(g.id);
    return dead;
  }
}
