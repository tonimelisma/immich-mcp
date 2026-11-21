import type { Response } from 'express';
import type { OAuthRegisteredClientsStore } from '@modelcontextprotocol/sdk/server/auth/clients.js';
import {
  InvalidClientMetadataError,
  InvalidGrantError,
  InvalidTokenError,
} from '@modelcontextprotocol/sdk/server/auth/errors.js';
import type {
  AuthorizationParams,
  OAuthServerProvider,
} from '@modelcontextprotocol/sdk/server/auth/provider.js';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import type {
  OAuthClientInformationFull,
  OAuthTokenRevocationRequest,
  OAuthTokens,
} from '@modelcontextprotocol/sdk/shared/auth.js';
import { randomUUID } from 'node:crypto';
import { redirectUriAllowed, type Config } from '../config.js';
import { hashToken, newToken } from '../crypto.js';
import type { Grant, Store } from '../store.js';
import { renderLoginPage } from './login-page.js';

export const PENDING_TTL_SECONDS = 15 * 60;
export const CODE_TTL_SECONDS = 60;
/** A refresh token presented again within this window gets a fresh pair (clients retry); later, it is replay. */
export const REFRESH_REUSE_GRACE_SECONDS = 60;

export const SCOPE = 'immich';

const nowSeconds = () => Math.floor(Date.now() / 1000);

export interface GrantAuthExtra extends Record<string, unknown> {
  grantId: string;
}

class ClientsStore implements OAuthRegisteredClientsStore {
  constructor(
    private readonly store: Store,
    private readonly config: Config,
  ) {}

  getClient(clientId: string) {
    return this.store.getClient(clientId);
  }

  registerClient(client: Omit<OAuthClientInformationFull, 'client_id' | 'client_id_issued_at'>) {
    const rejected = client.redirect_uris.filter(
      (uri) => !redirectUriAllowed(uri, this.config.allowedRedirectUris),
    );
    if (rejected.length > 0) {
      throw new InvalidClientMetadataError(`redirect_uri not allowed on this server: ${rejected.join(', ')}`);
    }
    const now = nowSeconds();
    const full: OAuthClientInformationFull = { ...client, client_id: randomUUID(), client_id_issued_at: now };
    this.store.saveClient(full, now);
    return full;
  }
}

export class ImmichOAuthProvider implements OAuthServerProvider {
  readonly clientsStore: ClientsStore;

  constructor(
    private readonly store: Store,
    private readonly config: Config,
    private readonly loginPath: string,
  ) {
    this.clientsStore = new ClientsStore(store, config);
  }

  /** Shows the Immich sign-in form; the login route finishes the flow. */
  async authorize(
    client: OAuthClientInformationFull,
    params: AuthorizationParams,
    res: Response,
  ): Promise<void> {
    const id = newToken();
    this.store.savePending({
      id,
      clientId: client.client_id,
      redirectUri: params.redirectUri,
      codeChallenge: params.codeChallenge,
      state: params.state,
      scopes: params.scopes?.length ? params.scopes : [SCOPE],
      resource: params.resource?.href,
      expiresAt: nowSeconds() + PENDING_TTL_SECONDS,
    });
    res
      .status(200)
      .type('html')
      .send(
        renderLoginPage({
          action: this.loginPath,
          requestId: id,
          clientName: client.client_name,
          redirectUri: params.redirectUri,
          immichUrl: this.config.immichPublicUrl,
          keyName: this.config.apiKeyName,
        }),
      );
  }

  /** Called by the login route once Immich accepted the password and the grant exists. */
  issueCode(grantId: string, pendingId: string): URL {
    const pending = this.store.getPending(pendingId, nowSeconds());
    if (!pending) throw new InvalidGrantError('sign-in request expired');
    this.store.deletePending(pendingId);
    const code = newToken();
    this.store.saveCode(hashToken(code), {
      grantId,
      clientId: pending.clientId,
      codeChallenge: pending.codeChallenge,
      redirectUri: pending.redirectUri,
      resource: pending.resource,
      expiresAt: nowSeconds() + CODE_TTL_SECONDS,
    });
    const target = new URL(pending.redirectUri);
    target.searchParams.set('code', code);
    if (pending.state !== undefined) target.searchParams.set('state', pending.state);
    target.searchParams.set('iss', this.config.publicUrl.href);
    return target;
  }

  async challengeForAuthorizationCode(client: OAuthClientInformationFull, authorizationCode: string) {
    const code = this.store.getCode(hashToken(authorizationCode), nowSeconds());
    if (!code || code.clientId !== client.client_id)
      throw new InvalidGrantError('invalid authorization code');
    return code.codeChallenge;
  }

  async exchangeAuthorizationCode(
    client: OAuthClientInformationFull,
    authorizationCode: string,
    _codeVerifier?: string,
    redirectUri?: string,
    resource?: URL,
  ): Promise<OAuthTokens> {
    // The SDK's token handler has already checked the PKCE verifier against challengeForAuthorizationCode.
    const hash = hashToken(authorizationCode);
    // Check the client before consuming, so another client presenting the code cannot burn it.
    if (this.store.getCode(hash, nowSeconds())?.clientId !== client.client_id) {
      throw new InvalidGrantError('invalid authorization code');
    }
    const code = this.store.takeCode(hash, nowSeconds());
    if (!code) throw new InvalidGrantError('invalid authorization code');
    if (redirectUri !== undefined && redirectUri !== code.redirectUri) {
      throw new InvalidGrantError('redirect_uri does not match the authorization request');
    }
    if (resource && code.resource && resource.href !== code.resource) {
      throw new InvalidGrantError('resource does not match the authorization request');
    }
    const grant = this.store.getGrant(code.grantId);
    if (!grant) throw new InvalidGrantError('the sign-in was revoked');
    return this.issueTokens(grant);
  }

  async exchangeRefreshToken(client: OAuthClientInformationFull, refreshToken: string): Promise<OAuthTokens> {
    const now = nowSeconds();
    const hash = hashToken(refreshToken);
    const token = this.store.getRefreshToken(hash, now);
    if (!token) throw new InvalidGrantError('invalid refresh token');
    const grant = this.store.getGrant(token.grantId);
    if (!grant || grant.clientId !== client.client_id) throw new InvalidGrantError('invalid refresh token');
    if (token.usedAt !== undefined && now - token.usedAt > REFRESH_REUSE_GRACE_SECONDS) {
      // A rotated-out token came back: someone holds a copy. End the whole sign-in.
      this.store.deleteGrant(grant.id);
      throw new InvalidGrantError('refresh token reuse detected; sign in again');
    }
    this.store.markRefreshTokenUsed(hash, now);
    return this.issueTokens(grant);
  }

  private issueTokens(grant: Grant): OAuthTokens {
    const now = nowSeconds();
    const accessToken = newToken();
    const refreshToken = newToken();
    this.store.saveAccessToken(hashToken(accessToken), {
      grantId: grant.id,
      expiresAt: now + this.config.accessTokenTtlSeconds,
    });
    this.store.saveRefreshToken(hashToken(refreshToken), {
      grantId: grant.id,
      expiresAt: now + this.config.refreshTokenTtlSeconds,
    });
    return {
      access_token: accessToken,
      token_type: 'Bearer',
      expires_in: this.config.accessTokenTtlSeconds,
      refresh_token: refreshToken,
      scope: grant.scopes.join(' '),
    };
  }

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    const access = this.store.getAccessToken(hashToken(token), nowSeconds());
    const grant = access && this.store.getGrant(access.grantId);
    if (!access || !grant) throw new InvalidTokenError('invalid or expired access token');
    const extra: GrantAuthExtra = { grantId: grant.id };
    return {
      token,
      clientId: grant.clientId,
      scopes: grant.scopes,
      expiresAt: access.expiresAt,
      resource: new URL(grant.resource ?? this.config.publicUrl.href),
      extra,
    };
  }

  async revokeToken(client: OAuthClientInformationFull, request: OAuthTokenRevocationRequest): Promise<void> {
    const hash = hashToken(request.token);
    const now = nowSeconds();
    const refresh = this.store.getRefreshToken(hash, now);
    if (refresh) {
      const grant = this.store.getGrant(refresh.grantId);
      // Revoking a refresh token ends the sign-in it belongs to.
      if (grant?.clientId === client.client_id) this.store.deleteGrant(grant.id);
      return;
    }
    const access = this.store.getAccessToken(hash, now);
    if (access && this.store.getGrant(access.grantId)?.clientId === client.client_id) {
      this.store.deleteAccessToken(hash);
    }
  }
}
