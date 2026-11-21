export interface Config {
  /** Public URL of the MCP endpoint, e.g. https://photos.example.com/mcp. Also the OAuth issuer. */
  publicUrl: URL;
  /** URL this server uses to reach Immich, e.g. http://immich_server:2283. */
  immichUrl: string;
  /** URL people open Immich at, used for links in tool results. */
  immichPublicUrl: string;
  host: string;
  port: number;
  dataDir: string;
  /** Base64 32-byte key for encrypting stored Immich API keys; generated into dataDir when unset. */
  encryptionKey?: string;
  /** Redirect URIs a client may register: exact URIs, or `scheme://host:*` for any port and path. */
  allowedRedirectUris: string[];
  accessTokenTtlSeconds: number;
  refreshTokenTtlSeconds: number;
  /** Express `trust proxy` setting, so rate limits see the real client address. */
  trustProxy: string | number | boolean;
  apiKeyName: string;
  /** Unused keys younger than this are not swept (see KEY_GRACE_MS). */
  keyGraceSeconds: number;
}

export const DEFAULT_REDIRECT_URIS = [
  'https://claude.ai/api/mcp/auth_callback',
  'https://claude.com/api/mcp/auth_callback',
  'http://localhost:*',
  'http://127.0.0.1:*',
];

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function seconds(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`);
  return value;
}

function parseTrustProxy(raw: string | undefined): string | number | boolean {
  if (raw === undefined || raw === '') return 'loopback';
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  if (/^\d+$/.test(raw)) return Number(raw);
  return raw;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const publicUrl = new URL(required(env, 'PUBLIC_URL'));
  if (publicUrl.search || publicUrl.hash) throw new Error('PUBLIC_URL must not have a query or fragment');
  if (publicUrl.pathname.endsWith('/') && publicUrl.pathname !== '/') {
    publicUrl.pathname = publicUrl.pathname.replace(/\/+$/, '');
  }
  const immichUrl = required(env, 'IMMICH_URL').replace(/\/+$/, '');
  const immichPublicUrl = (env.IMMICH_PUBLIC_URL || publicUrl.origin).replace(/\/+$/, '');
  return {
    publicUrl,
    immichUrl,
    immichPublicUrl,
    host: env.HOST || '0.0.0.0',
    port: seconds(env, 'PORT', 8080),
    dataDir: env.DATA_DIR || './data',
    encryptionKey: env.ENCRYPTION_KEY || undefined,
    allowedRedirectUris: env.ALLOWED_REDIRECT_URIS
      ? env.ALLOWED_REDIRECT_URIS.split(',')
          .map((s) => s.trim())
          .filter(Boolean)
      : DEFAULT_REDIRECT_URIS,
    accessTokenTtlSeconds: seconds(env, 'ACCESS_TOKEN_TTL', 3600),
    refreshTokenTtlSeconds: seconds(env, 'REFRESH_TOKEN_TTL', 90 * 24 * 3600),
    trustProxy: parseTrustProxy(env.TRUST_PROXY),
    apiKeyName: env.API_KEY_NAME || 'Claude (immich-mcp)',
    keyGraceSeconds: env.KEY_GRACE_SECONDS === '0' ? 0 : seconds(env, 'KEY_GRACE_SECONDS', 120),
  };
}

/** The path the MCP endpoint is served at, '' when it is the origin root. */
export function basePath(config: Config): string {
  return config.publicUrl.pathname === '/' ? '' : config.publicUrl.pathname;
}

export function redirectUriAllowed(uri: string, allowed: string[]): boolean {
  let parsed: URL;
  try {
    parsed = new URL(uri);
  } catch {
    return false;
  }
  if (parsed.hash || parsed.username || parsed.password) return false;
  return allowed.some((pattern) => {
    // `scheme://host:*` allows any port and path on that host (loopback callbacks of desktop clients).
    const anyPort = /^(https?):\/\/([^/:@]+):\*$/.exec(pattern);
    if (anyPort) return parsed.protocol === `${anyPort[1]}:` && parsed.hostname === anyPort[2];
    return parsed.href === new URL(pattern).href;
  });
}
