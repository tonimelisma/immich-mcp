import express, { type Request, type Response, type Router } from 'express';
import { rateLimit } from 'express-rate-limit';
import { authorizationHandler } from '@modelcontextprotocol/sdk/server/auth/handlers/authorize.js';
import { metadataHandler } from '@modelcontextprotocol/sdk/server/auth/handlers/metadata.js';
import { clientRegistrationHandler } from '@modelcontextprotocol/sdk/server/auth/handlers/register.js';
import { revocationHandler } from '@modelcontextprotocol/sdk/server/auth/handlers/revoke.js';
import { tokenHandler } from '@modelcontextprotocol/sdk/server/auth/handlers/token.js';
import type {
  OAuthClientInformationFull,
  OAuthMetadata,
  OAuthProtectedResourceMetadata,
} from '@modelcontextprotocol/sdk/shared/auth.js';
import { randomUUID } from 'node:crypto';
import { basePath, type Config } from '../config.js';
import { newToken, type SecretBox } from '../crypto.js';
import { describeError, LoginFailed, signInAndCreateKey } from '../immich.js';
import type { PendingAuthorization, Store } from '../store.js';
import { renderLoginPage, renderMessagePage, signInPageHeaders } from './login-page.js';
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

  // The sign-in page's headers depend on the redirect URI, so ImmichOAuthProvider.authorize sets them.
  router.use(`${base}/oauth/authorize`, authorizationHandler({ provider }));
  router.use(`${base}/oauth/token`, tokenHandler({ provider }));
  // Client secrets never expire: an expiring secret would silently end every sign-in after it.
  router.use(
    `${base}/oauth/register`,
    clientRegistrationHandler({ clientsStore: provider.clientsStore, clientSecretExpirySeconds: 0 }),
  );
  router.use(`${base}/oauth/revoke`, revocationHandler({ provider }));

  /** Clients count as the same app when they register the same redirect URIs (claude.ai registers anew). */
  const sameApp = (a: string[], b: string[]) =>
    JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());

  type Outcome = { redirect: string } | { status: number; error: string };
  // A second submit of the same form (impatient click, reload) joins the first instead of racing it.
  const inflight = new Map<string, Promise<Outcome>>();
  const completed = new Map<string, { redirect: string; expiresAt: number }>();

  const completeSignIn = async (
    requestId: string,
    pending: PendingAuthorization,
    client: OAuthClientInformationFull,
    email: string,
    password: string,
    clientIp: string | undefined,
  ): Promise<Outcome> => {
    const started = Date.now();
    let signIn;
    try {
      signIn = await signInAndCreateKey({
        immichUrl: config.immichUrl,
        email,
        password,
        keyName: config.apiKeyName,
        keyGraceMs: config.keyGraceSeconds * 1000,
        clientIp,
        fetch: options.fetch,
      });
    } catch (error) {
      if (error instanceof LoginFailed) {
        log(`sign-in failed for ${email} from ${clientIp}`);
        return { status: 401, error: error.message };
      }
      log(`sign-in error for ${email}: ${describeError(error)}`);
      return { status: 502, error: `Immich could not complete the sign-in (${describeError(error)}).` };
    }
    const user = signIn.user;
    // Signing in again from the same app replaces the earlier sign-in and deletes its API key.
    const earlier = store
      .grantsForUser(user.userId)
      .filter((g) => sameApp(store.getClient(g.clientId)?.redirect_uris ?? [], client.redirect_uris));
    const grantId = randomUUID();
    try {
      for (const old of earlier) store.deleteGrant(old.id);
      store.saveGrant({
        id: grantId,
        clientId: client.client_id,
        userId: user.userId,
        email: user.userEmail,
        name: user.name,
        isAdmin: user.isAdmin,
        apiKeyId: signIn.apiKeyId,
        apiKeySealed: box.seal(signIn.apiKeySecret),
        scopes: pending.scopes,
        resource: pending.resource,
        createdAt: Math.floor(started / 1000),
      });
      const redirect = provider.issueCode(grantId, requestId).href;
      // Keep the keys of this user's other live sign-ins (other apps); every other key with this
      // server's name is left over from replaced, expired or failed sign-ins.
      const live = () => store.grantsForUser(user.userId).map((g) => g.apiKeyId);
      void signIn.finish({ keep: live, discard: earlier.map((g) => g.apiKeyId) }).then((deleted) => {
        if (deleted.length) log(`sign-in: deleted ${deleted.length} unused API key(s) of ${user.userEmail}`);
      });
      const seconds = ((Date.now() - started) / 1000).toFixed(1);
      log(
        `sign-in: ${user.userEmail} (${user.isAdmin ? 'admin' : 'user'}) via ${client.client_name ?? client.client_id} in ${seconds} s`,
      );
      return { redirect };
    } catch (error) {
      store.deleteGrant(grantId);
      void signIn.finish({
        keep: () => store.grantsForUser(user.userId).map((g) => g.apiKeyId),
        discard: [signIn.apiKeyId],
      });
      log(`sign-in error for ${email}: ${describeError(error)}`);
      return {
        status: 400,
        error: 'This sign-in request has expired. Start connecting again from your app.',
      };
    }
  };

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
      const requestId = formField(req.body, 'request_id');
      const email = formField(req.body, 'email').trim();
      const password = formField(req.body, 'password');
      const nowMs = Date.now();
      for (const [id, done] of completed) if (done.expiresAt <= nowMs) completed.delete(id);

      const done = completed.get(requestId);
      if (done) {
        res.setHeader('Cache-Control', 'no-store');
        res.redirect(302, done.redirect);
        return;
      }
      const pending = requestId ? store.getPending(requestId, Math.floor(nowMs / 1000)) : undefined;
      const client = pending && store.getClient(pending.clientId);
      if (!pending || !client) {
        res.setHeader('Cache-Control', 'no-store');
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
      const nonce = newToken(16);
      res.set(signInPageHeaders(pending.redirectUri, nonce));
      const again = (status: number, error: string) =>
        res
          .status(status)
          .type('html')
          .send(
            renderLoginPage({
              nonce,
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
      let attempt = inflight.get(requestId);
      if (!attempt) {
        attempt = completeSignIn(requestId, pending, client, email, password, req.ip).finally(() =>
          inflight.delete(requestId),
        );
        inflight.set(requestId, attempt);
      }
      const outcome = await attempt;
      if ('redirect' in outcome) {
        completed.set(requestId, { redirect: outcome.redirect, expiresAt: pending.expiresAt * 1000 });
        res.redirect(302, outcome.redirect);
      } else {
        again(outcome.status, outcome.error);
      }
    },
  );

  return { router, provider, resourceMetadataUrl };
}
