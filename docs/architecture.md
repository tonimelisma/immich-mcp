# Architecture

A single Node.js process (TypeScript, MCP SDK, `@immich/sdk`, Express, SQLite) that is both the OAuth
authorization server and the MCP resource server for one Immich instance. It shares Immich's domain behind a
reverse proxy: the MCP paths go to it, everything else stays with Immich.

## Components

- `src/index.ts` starts the process: loads the config, opens the store and the encryption key, serves.
- `src/config.ts` reads the environment (`PUBLIC_URL`, `IMMICH_URL`, timeouts, allow-lists); it is the one owner
  of settings and their defaults.
- `src/server.ts` builds the Express app: `/healthz` on the MCP path, the OAuth routes, and the MCP endpoint
  (streamable HTTP, a fresh `McpServer` per request, bound to the caller's grant). It logs every request the
  transport rejects with its `mcp-protocol-version`.
- `src/oauth/` is the authorization server: discovery documents, dynamic client registration limited to the
  redirect URI allow-list, the sign-in page (`login-page.ts`, strict CSP), PKCE S256 codes, access tokens and
  rotating refresh tokens (`provider.ts`). See [ADR 0001](adr/0001-sign-in-as-the-user-with-a-key-that-cannot-delete.md).
- `src/immich.ts` talks to Immich: the password sign-in that creates the scoped API key and logs the password
  session out, the sweep of stale keys, timeouts and error classification. `USER_PERMISSIONS` and
  `ADMIN_PERMISSIONS` there are the only list of what a key may do.
- `src/tools/` holds the tools: `read.ts` (search, view, details, lists, `about_connection`), `write.ts` (edit
  details, tags, people and faces), `admin.ts` (admins only). `context.ts`'s `defineTool()` registers each
  tool, types its arguments from the schema, applies the Immich deadline, turns errors into tool errors and
  logs one line per call.
- `src/store.ts` is the SQLite store (`DATA_DIR`); `src/crypto.ts` seals the Immich key (AES-256-GCM) and hashes
  tokens and PKCE verifiers.
- `src/version.ts` reads the version from `package.json`, the one place it is written.

## Data

- The store holds clients, pending authorizations, codes, grants (one per user and app, with the sealed Immich
  key) and token hashes. Nothing else about the library is stored: every answer comes from Immich.
- The encryption key is `ENCRYPTION_KEY` or a file generated into `DATA_DIR` on first start.
- Passwords pass through to Immich once and are never stored or logged.

## Flows

- **Sign-in**: the client discovers the server, registers, and sends the user to `/mcp/oauth/authorize`. The
  sign-in page posts the Immich email and password; the server signs in to Immich, creates the key with the
  permissions for that user (admin ones only for admins), logs the password session out, and redirects with
  a code. In the background it deletes the keys this sign-in replaces and unused stray keys of its own name
  older than `KEY_GRACE_SECONDS`. A repeated submit joins the sign-in in flight.
- **Tool call**: the bearer token resolves to a grant; the tool runs with the grant's key under
  `IMMICH_TIMEOUT`, and its Immich requests abort when the deadline passes or the client hangs up. Names of
  people, albums and tags are resolved to ids. Results drop empty values and carry links built from
  `IMMICH_PUBLIC_URL`.
- **Release**: see [ADR 0002](adr/0002-attested-release-from-ci-green-main.md) and the Git section of
  `CLAUDE.md`.

## Failure handling

- Immich slow or busy: the call ends with "Immich did not answer within N s" before the client's own 60 s
  limit, so the outcome is never unknown.
- Key deleted in Immich: the call fails with a reconnect message and the grant is ended, so the next request
  gets 401 and the client signs in again.
- Refresh token reuse after rotation ends the grant.
- Key sweeps never throw; a key already gone counts as deleted.
