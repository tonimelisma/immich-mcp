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

/** Keys this young are never swept, so two simultaneous sign-ins cannot delete each other's new key. */
export const KEY_GRACE_MS = 2 * 60 * 1000;

export interface SignIn {
  user: LoginResponseDto;
  apiKeyId: string;
  apiKeySecret: string;
  /**
   * Finishes in the background, after the browser has been sent on: deletes the keys with this
   * server's name that `keep` does not list (left by earlier, expired or failed sign-ins), then logs
   * the password session out. `keep` is read after Immich lists the keys, and keys younger than
   * two minutes are spared, so a concurrent sign-in of the same user keeps its new key; `discard`
   * names keys to delete regardless (those of the sign-ins this one replaced, or its own when it
   * could not be completed).
   * Returns the ids of the keys it deleted. Never throws.
   */
  finish: (options: { keep: () => string[]; discard: string[] }) => Promise<string[]>;
}

/**
 * Signs in with the user's password and creates the API key this server will act with. Only the two
 * calls the browser has to wait for happen here; cleanup is left to `finish`.
 * The password is used for this one request and never stored.
 */
export async function signInAndCreateKey(options: {
  immichUrl: string;
  email: string;
  password: string;
  keyName: string;
  /** Overrides KEY_GRACE_MS. */
  keyGraceMs?: number;
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
  const finish: SignIn['finish'] = async ({ keep: keepIds, discard: discardIds }) => {
    const deleted: string[] = [];
    try {
      const keys = await getApiKeys(session);
      const keep = new Set(keepIds());
      const discard = new Set(discardIds);
      const youngerThan = Date.now() - (options.keyGraceMs ?? KEY_GRACE_MS);
      const stale = keys.filter(
        (k) =>
          discard.has(k.id) ||
          (k.name === options.keyName && !keep.has(k.id) && Date.parse(k.createdAt) < youngerThan),
      );
      for (const key of stale) {
        // A key deleted meanwhile answers 400/404; that is the wanted state.
        await deleteApiKey({ id: key.id }, session).then(
          () => deleted.push(key.id),
          () => undefined,
        );
      }
    } catch {
      // Listing failed: leave the keys; the next sign-in tries again.
    }
    await logout(session).catch(() => undefined);
    return deleted;
  };
  let created;
  try {
    created = await createApiKey(
      { apiKeyCreateDto: { name: options.keyName, permissions: permissionsFor(user.isAdmin) } },
      session,
    );
  } catch (error) {
    await logout(session).catch(() => undefined);
    throw error;
  }
  return { user, apiKeyId: created.apiKey?.id ?? created.id, apiKeySecret: created.secret, finish };
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
