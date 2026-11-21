import {
  createApiKey,
  deleteApiKey,
  getApiKeys,
  isHttpError,
  login,
  logout,
  Permission,
  type LoginResponseDto,
} from '@immich/sdk';

/** What the tools need. Nothing here deletes data: no `*.delete` permission is ever requested. */
export const USER_PERMISSIONS: Permission[] = [
  Permission.UserRead,
  Permission.AssetRead,
  Permission.AssetView,
  Permission.AssetUpdate,
  Permission.AlbumRead,
  Permission.PersonRead,
  Permission.PersonStatistics,
  Permission.PersonCreate,
  Permission.PersonUpdate,
  Permission.PersonMerge,
  Permission.FaceRead,
  Permission.FaceUpdate,
  Permission.TagRead,
  Permission.TagCreate,
  Permission.TagAsset,
];

/** Added only for Immich administrators. Queue control is limited to start, pause and resume. */
export const ADMIN_PERMISSIONS: Permission[] = [
  Permission.ServerAbout,
  Permission.ServerStorage,
  Permission.ServerStatistics,
  Permission.AdminUserRead,
  Permission.QueueRead,
  Permission.QueueUpdate,
  Permission.JobCreate,
];

export function permissionsFor(isAdmin: boolean): Permission[] {
  return isAdmin ? [...USER_PERMISSIONS, ...ADMIN_PERMISSIONS] : [...USER_PERMISSIONS];
}

export interface RequestOpts {
  baseUrl: string;
  headers: Record<string, string>;
  fetch?: typeof fetch;
}

/** Per-call options; the SDK's global defaults are never used, so concurrent users cannot mix. */
export function apiKeyOpts(baseUrl: string, apiKey: string, fetchImpl?: typeof fetch): RequestOpts {
  return { baseUrl: `${baseUrl}/api`, headers: { 'x-api-key': apiKey }, fetch: fetchImpl };
}

function sessionOpts(baseUrl: string, accessToken: string, fetchImpl?: typeof fetch): RequestOpts {
  return { baseUrl: `${baseUrl}/api`, headers: { authorization: `Bearer ${accessToken}` }, fetch: fetchImpl };
}

export class LoginFailed extends Error {}

export interface SignIn {
  user: LoginResponseDto;
  apiKeyId: string;
  apiKeySecret: string;
}

/**
 * Signs in with the user's password, creates the API key this server will act with, deletes the keys
 * earlier sign-ins of the same client left behind, and logs the password session out again.
 * The password is used for this one request and never stored.
 */
export async function signInAndCreateKey(options: {
  immichUrl: string;
  email: string;
  password: string;
  keyName: string;
  /** API keys of earlier sign-ins by this user, to delete now; looked up once Immich says who signed in. */
  replaceKeyIdsFor: (userId: string) => string[];
  clientIp?: string;
  fetch?: typeof fetch;
}): Promise<SignIn> {
  const base = {
    baseUrl: `${options.immichUrl}/api`,
    fetch: options.fetch,
    headers: {} as Record<string, string>,
  };
  if (options.clientIp) base.headers['x-forwarded-for'] = options.clientIp;
  let user: LoginResponseDto;
  try {
    user = await login({ loginCredentialDto: { email: options.email, password: options.password } }, base);
  } catch (error) {
    if (isHttpError(error) && (error.status === 401 || error.status === 400)) {
      throw new LoginFailed('Wrong email or password.');
    }
    throw error;
  }
  const session = sessionOpts(options.immichUrl, user.accessToken, options.fetch);
  try {
    const existing = new Set((await getApiKeys(session)).map((k) => k.id));
    for (const id of options.replaceKeyIdsFor(user.userId)) {
      if (existing.has(id)) await deleteApiKey({ id }, session);
    }
    const created = await createApiKey(
      { apiKeyCreateDto: { name: options.keyName, permissions: permissionsFor(user.isAdmin) } },
      session,
    );
    return { user, apiKeyId: created.apiKey?.id ?? created.id, apiKeySecret: created.secret };
  } finally {
    await logout(session).catch(() => undefined);
  }
}

/** True when Immich says the key is no longer valid (revoked in Account settings, or the user removed). */
export function isRevoked(error: unknown): boolean {
  return isHttpError(error) && error.status === 401;
}

export function describeError(error: unknown): string {
  if (isHttpError(error)) {
    const data = error.data as { message?: unknown } | undefined;
    const message = Array.isArray(data?.message) ? data.message.join('; ') : data?.message;
    return `Immich returned ${error.status}${message ? `: ${String(message)}` : ''}`;
  }
  return error instanceof Error ? error.message : String(error);
}
