import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { AssetResponseDto, PersonResponseDto } from '@immich/sdk';
import { describeError, isRevoked, type RequestOpts } from '../immich.js';
import type { Grant } from '../store.js';

export interface ToolContext {
  grant: Grant;
  opts: RequestOpts;
  immichPublicUrl: string;
  /** Called when Immich rejects the key, so the next request asks the client to sign in again. */
  onRevoked: () => void;
}

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function json(value: unknown): CallToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(value, null, 1) }] };
}

export function fail(message: string): CallToolResult {
  return { isError: true, content: [{ type: 'text', text: message }] };
}

/** Thrown by helpers for mistakes the caller can fix, such as an ambiguous name. */
export class ToolInputError extends Error {}

/** Wraps a handler: input mistakes and Immich errors become tool errors, a revoked key ends the sign-in. */
export function guarded<A>(ctx: ToolContext, handler: (args: A) => Promise<CallToolResult>) {
  return async (args: A): Promise<CallToolResult> => {
    try {
      return await handler(args);
    } catch (error) {
      if (error instanceof ToolInputError) return fail(error.message);
      if (isRevoked(error)) {
        ctx.onRevoked();
        return fail(
          'Immich no longer accepts this connection (its API key was deleted). Reconnect to sign in again.',
        );
      }
      return fail(describeError(error));
    }
  };
}

const compact = <T extends Record<string, unknown>>(value: T): Partial<T> =>
  Object.fromEntries(
    Object.entries(value).filter(
      ([, v]) => v !== undefined && v !== null && v !== '' && !(Array.isArray(v) && !v.length),
    ),
  ) as Partial<T>;

/** Immich's localDateTime is the wall-clock time where the photo was taken, written as if it were UTC. */
export function localTime(asset: Pick<AssetResponseDto, 'localDateTime'>): string {
  return asset.localDateTime.slice(0, 16).replace('T', ' ');
}

export function placeOf(asset: AssetResponseDto): string | undefined {
  const e = asset.exifInfo;
  const parts = [e?.city, e?.state, e?.country].filter((p): p is string => !!p);
  return parts.length ? parts.join(', ') : undefined;
}

export function photoUrl(ctx: ToolContext, id: string): string {
  return `${ctx.immichPublicUrl}/photos/${id}`;
}

/** The short form used in lists. */
export function summarizeAsset(ctx: ToolContext, asset: AssetResponseDto) {
  return compact({
    id: asset.id,
    taken: localTime(asset),
    type: asset.type.toLowerCase(),
    file: asset.originalFileName,
    place: placeOf(asset),
    people: asset.people?.filter((p) => p.name).map((p) => p.name),
    favorite: asset.isFavorite || undefined,
    rating: asset.exifInfo?.rating ?? undefined,
    description: asset.exifInfo?.description || undefined,
    archived: asset.isArchived || undefined,
    url: photoUrl(ctx, asset.id),
  });
}

export function summarizePerson(person: PersonResponseDto) {
  return compact({
    id: person.id,
    name: person.name || '(unnamed)',
    birth_date: person.birthDate ?? undefined,
    hidden: person.isHidden || undefined,
    favorite: person.isFavorite || undefined,
  });
}

export { compact };
