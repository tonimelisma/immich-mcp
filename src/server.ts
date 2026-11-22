import express, { type Express, type Request, type Response } from 'express';
import { createRequire } from 'node:module';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { requireBearerAuth } from '@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js';
import { basePath, type Config } from './config.js';
import type { SecretBox } from './crypto.js';
import { apiKeyOpts } from './immich.js';
import { oauthRoutes } from './oauth/router.js';
import type { GrantAuthExtra } from './oauth/provider.js';
import type { Grant, Store } from './store.js';
import { registerAdminTools } from './tools/admin.js';
import type { ToolContext } from './tools/context.js';
import { registerReadTools } from './tools/read.js';
import { registerWriteTools } from './tools/write.js';

/** From package.json (next to src/ and dist/), so the version is written in one place. */
export const VERSION: string = (createRequire(import.meta.url)('../package.json') as { version: string })
  .version;

const INSTRUCTIONS = `Tools for one person's Immich photo library, acting as that Immich user.
Find photos with search_photos (natural-language query plus filters), then look at them with view_photos
and read metadata with get_photo_details. Names of people, albums and tags are accepted wherever an id is.
Nothing can be deleted through this server. Link to a photo with the url field of results.`;

export function buildMcpServer(ctx: ToolContext): McpServer {
  const server = new McpServer({ name: 'immich-mcp', version: VERSION }, { instructions: INSTRUCTIONS });
  registerReadTools(server, ctx);
  registerWriteTools(server, ctx);
  if (ctx.grant.isAdmin) registerAdminTools(server, ctx);
  return server;
}

export interface AppOptions {
  config: Config;
  store: Store;
  box: SecretBox;
  /** Replaces fetch for every Immich call, for tests. */
  fetch?: typeof fetch;
  log?: (message: string) => void;
}

export function createApp({ config, store, box, fetch: fetchImpl, log = console.log }: AppOptions): Express {
  const app = express();
  app.set('trust proxy', config.trustProxy);
  app.disable('x-powered-by');
  const base = basePath(config);
  const oauth = oauthRoutes(config, store, box, { fetch: fetchImpl, log });

  app.get(`${base}/healthz`, (_req, res) => {
    res.json({ ok: true, version: VERSION });
  });
  app.use(oauth.router);

  const auth = requireBearerAuth({
    verifier: oauth.provider,
    resourceMetadataUrl: oauth.resourceMetadataUrl,
  });
  const endpoint = base || '/';

  app.post(endpoint, auth, express.json({ limit: '1mb' }), async (req: Request, res: Response) => {
    const extra = req.auth?.extra as GrantAuthExtra | undefined;
    const grant: Grant | undefined = extra && store.getGrant(extra.grantId);
    if (!grant) {
      res.status(401).json({ error: 'invalid_token' });
      return;
    }
    // Each POST carries one call. Its Immich requests stop at the deadline, or as soon as the client hangs up.
    const left = new AbortController();
    const signal = AbortSignal.any([AbortSignal.timeout(config.immichTimeoutSeconds * 1000), left.signal]);
    const ctx: ToolContext = {
      grant,
      opts: apiKeyOpts(config.immichUrl, box.open(grant.apiKeySealed), fetchImpl, signal),
      immichPublicUrl: config.immichPublicUrl,
      timeoutSeconds: config.immichTimeoutSeconds,
      onRevoked: () => {
        log(`Immich rejected the API key of ${grant.email}; ending that sign-in`);
        store.deleteGrant(grant.id);
      },
      log,
    };
    // Stateless: a fresh server and transport per request, so nothing is shared between users or calls.
    const server = buildMcpServer(ctx);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    // The transport answers malformed requests itself (400 with a JSON-RPC error); say why in the log.
    transport.onerror = (error) => {
      const version = req.get('mcp-protocol-version');
      log(
        `MCP request from ${grant.email} rejected: ${error.message}` +
          (version ? ` (mcp-protocol-version: ${version})` : ''),
      );
    };
    res.on('close', () => {
      left.abort();
      void transport.close();
      void server.close();
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (error) {
      log(`MCP request failed: ${error instanceof Error ? error.message : String(error)}`);
      if (!res.headersSent) {
        res
          .status(500)
          .json({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal error' }, id: null });
      }
    }
  });

  const methodNotAllowed = (_req: Request, res: Response) => {
    res
      .status(405)
      .set('Allow', 'POST')
      .json({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed.' }, id: null });
  };
  app.get(endpoint, auth, methodNotAllowed);
  app.delete(endpoint, auth, methodNotAllowed);

  return app;
}
