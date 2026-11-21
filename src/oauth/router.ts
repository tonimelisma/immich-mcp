import express, { type Request, type Response, type Router } from 'express';
import { rateLimit } from 'express-rate-limit';
import { authorizationHandler } from '@modelcontextprotocol/sdk/server/auth/handlers/authorize.js';
import { metadataHandler } from '@modelcontextprotocol/sdk/server/auth/handlers/metadata.js';
import { clientRegistrationHandler } from '@modelcontextprotocol/sdk/server/auth/handlers/register.js';
import { revocationHandler } from '@modelcontextprotocol/sdk/server/auth/handlers/revoke.js';
import { tokenHandler } from '@modelcontextprotocol/sdk/server/auth/handlers/token.js';
import type { OAuthMetadata, OAuthProtectedResourceMetadata } from '@modelcontextprotocol/sdk/shared/auth.js';
import { randomUUID } from 'node:crypto';
import { basePath, type Config } from '../config.js';
import type { SecretBox } from '../crypto.js';
import { describeError, LoginFailed, signInAndCreateKey } from '../immich.js';
import type { Store } from '../store.js';
import { renderLoginPage, renderMessagePage } from './login-page.js';
import { ImmichOAuthProvider, SCOPE } from './provider.js';

export interface OAuthRoutes {
  router: Router;
  provider: ImmichOAuthProvider;
  resourceMetadataUrl: string;
}

const formField = (body: unknown, name: string): string => {
  const value = (body as Record<string, unknown> | undefined)?.[name];
  return typeof value === 'string' ? value : '';
};

/**
 * OAuth 2.1 authorization server under `<base>/oauth/*`, so the MCP can share an origin with Immich.
 * Discovery documents are served at every location clients look for them.
 */
export function oauthRoutes(
  config: Config,
  store: Store,
  box: SecretBox,
  options: { fetch?: typeof fetch; log?: (message: string) => void } = {},
): OAuthRoutes {
  const log = options.log ?? ((message: string) => console.log(message));
  const base = basePath(config);
  const at = (path: string) => new URL(`${base}${path}`, config.publicUrl.origin).href;
  const loginPath = `${base}/oauth/login`;
  const provider = new ImmichOAuthProvider(store, config, loginPath);

  const issuer = config.publicUrl.href;
  const metadata: OAuthMetadata = {
    issuer,
    authorization_endpoint: at('/oauth/authorize'),
    token_endpoint: at('/oauth/token'),
    registration_endpoint: at('/oauth/register'),
    revocation_endpoint: at('/oauth/revoke'),
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['client_secret_post', 'client_secret_basic', 'none'],
    revocation_endpoint_auth_methods_supported: ['client_secret_post', 'client_secret_basic', 'none'],
    scopes_supported: [SCOPE],
    authorization_response_iss_parameter_supported: true,
  };
  const resourceMetadata: OAuthProtectedResourceMetadata = {
    resource: config.publicUrl.href,
    authorization_servers: [issuer],
    scopes_supported: [SCOPE],
    bearer_methods_supported: ['header'],
    resource_name: 'Immich',
    resource_documentation: 'https://github.com/tonimelisma/immich-mcp',
  };
  const resourceMetadataUrl = new URL(`/.well-known/oauth-protected-resource${base}`, config.publicUrl.origin)
    .href;

  const router = express.Router();
  for (const path of new Set([
    `/.well-known/oauth-authorization-server${base}`,
    `/.well-known/openid-configuration${base}`,
    `${base}/.well-known/oauth-authorization-server`,
    `${base}/.well-known/openid-configuration`,
  ])) {
    router.use(path, metadataHandler(metadata));
  }
  router.use(`/.well-known/oauth-protected-resource${base}`, metadataHandler(resourceMetadata));

  router.use(`${base}/oauth/authorize`, (_req, res, next) => {
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader(
      'Content-Security-Policy',
      "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'",
    );
    next();
  });
  router.use(`${base}/oauth/authorize`, authorizationHandler({ provider }));
  router.use(`${base}/oauth/token`, tokenHandler({ provider }));
  // Client secrets never expire: an expiring secret would silently end every sign-in after it.
  router.use(
    `${base}/oauth/register`,
    clientRegistrationHandler({ clientsStore: provider.clientsStore, clientSecretExpirySeconds: 0 }),
  );
  router.use(`${base}/oauth/revoke`, revocationHandler({ provider }));

  const loginLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 20,
    standardHeaders: true,
    legacyHeaders: false,
  });
  router.post(
    loginPath,
    loginLimiter,
    express.urlencoded({ extended: false, limit: '8kb' }),
    async (req: Request, res: Response) => {
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('X-Frame-Options', 'DENY');
      res.setHeader(
        'Content-Security-Policy',
        "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'",
      );
      const requestId = formField(req.body, 'request_id');
      const email = formField(req.body, 'email').trim();
      const password = formField(req.body, 'password');
      const now = Math.floor(Date.now() / 1000);
      const pending = requestId ? store.getPending(requestId, now) : undefined;
      const client = pending && store.getClient(pending.clientId);
      if (!pending || !client) {
        res
          .status(400)
          .type('html')
          .send(
            renderMessagePage(
              'Sign-in expired',
              'This sign-in request has expired. Start connecting again from your app.',
            ),
          );
        return;
      }
      const again = (status: number, error: string) =>
        res
          .status(status)
          .type('html')
          .send(
            renderLoginPage({
              action: loginPath,
              requestId,
              clientName: client.client_name,
              redirectUri: pending.redirectUri,
              immichUrl: config.immichPublicUrl,
              keyName: config.apiKeyName,
              email,
              error,
            }),
          );
      if (!email || !password) {
        again(400, 'Enter your email and password.');
        return;
      }
      try {
        // Signing in again from the same app replaces the earlier sign-in and deletes its API key.
        const signIn = await signInAndCreateKey({
          immichUrl: config.immichUrl,
          email,
          password,
          keyName: config.apiKeyName,
          clientIp: req.ip,
          fetch: options.fetch,
          replaceKeyIdsFor: (userId) => store.grantsFor(userId, client.client_id).map((g) => g.apiKeyId),
        });
        for (const old of store.grantsFor(signIn.user.userId, client.client_id)) store.deleteGrant(old.id);
        const grantId = randomUUID();
        store.saveGrant({
          id: grantId,
          clientId: client.client_id,
          userId: signIn.user.userId,
          email: signIn.user.userEmail,
          name: signIn.user.name,
          isAdmin: signIn.user.isAdmin,
          apiKeyId: signIn.apiKeyId,
          apiKeySealed: box.seal(signIn.apiKeySecret),
          scopes: pending.scopes,
          resource: pending.resource,
          createdAt: now,
        });
        const redirect = provider.issueCode(grantId, requestId);
        log(
          `sign-in: ${signIn.user.userEmail} (${signIn.user.isAdmin ? 'admin' : 'user'}) via ${client.client_name ?? client.client_id}`,
        );
        res.redirect(302, redirect.href);
      } catch (error) {
        if (error instanceof LoginFailed) {
          log(`sign-in failed for ${email} from ${req.ip}`);
          again(401, error.message);
          return;
        }
        log(`sign-in error for ${email}: ${describeError(error)}`);
        again(502, `Immich could not complete the sign-in (${describeError(error)}).`);
      }
    },
  );

  return { router, provider, resourceMetadataUrl };
}
