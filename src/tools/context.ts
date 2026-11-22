import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ZodRawShapeCompat, ShapeOutput } from '@modelcontextprotocol/sdk/server/zod-compat.js';
import type { CallToolResult, ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';
import { AssetTypeEnum, type AssetResponseDto, type PersonResponseDto } from '@immich/sdk';
import { describeError, isRevoked, isTimeout, type RequestOpts } from '../immich.js';
import type { Grant } from '../store.js';

export interface ToolContext {
  grant: Grant;
  opts: RequestOpts;
  immichPublicUrl: string;
  /** How long one tool call may wait for Immich, for the message when it does not answer in time. */
  timeoutSeconds: number;
  /** Called when Immich rejects the key, so the next request asks the client to sign in again. */
  onRevoked: () => void;
  log: (message: string) => void;
}

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const READ_ONLY: ToolAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};

export const EDIT: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};

export function json(value: unknown): CallToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(value, null, 1) }] };
}

function fail(message: string): CallToolResult {
  return { isError: true, content: [{ type: 'text', text: message }] };
}

/** Thrown by helpers for mistakes the caller can fix, such as an ambiguous name. */
export class ToolInputError extends Error {}

/** Turns what a handler threw into the tool error the caller sees. */
function errorResult(ctx: ToolContext, error: unknown): CallToolResult {
  if (error instanceof ToolInputError) return fail(error.message);
  if (isRevoked(error)) {
    ctx.onRevoked();
    return fail(
      'Immich no longer accepts this connection (its API key was deleted). Reconnect to sign in again.',
    );
  }
  if (isTimeout(error)) {
    return fail(
      `Immich did not answer within ${ctx.timeoutSeconds} s. It is probably busy (high load or background jobs ` +
        'such as face detection and smart search); try again in a while, or narrow the request.',
    );
  }
  return fail(describeError(error));
}

/**
 * Registers a tool whose handler gets its arguments typed from `inputSchema`. Input mistakes and Immich
 * errors become tool errors, a revoked key ends the sign-in, and every call is logged with its duration.
 */
export function defineTool<Shape extends ZodRawShapeCompat>(
  server: McpServer,
  ctx: ToolContext,
  name: string,
  config: { title: string; description: string; inputSchema: Shape; annotations: ToolAnnotations },
  handler: (args: ShapeOutput<Shape>) => Promise<CallToolResult>,
): void {
  const run = async (args: ShapeOutput<Shape>): Promise<CallToolResult> => {
    const started = Date.now();
    let result: CallToolResult;
    try {
      result = await handler(args);
    } catch (error) {
      result = errorResult(ctx, error);
    }
    const outcome = result.isError
      ? `error: ${(result.content[0] as { text?: string } | undefined)?.text ?? ''}`
      : 'ok';
    ctx.log(`tool ${name} for ${ctx.grant.email}: ${Date.now() - started} ms, ${outcome}`);
    return result;
  };
  // The SDK's callback type is conditional on the schema; `run` has exactly the shape it resolves to.
  server.registerTool(name, config, run as never);
}

/** Drops undefined, null, '' and empty arrays and objects, so results carry only what is known. */
export function compact<T extends Record<string, unknown>>(value: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(value).filter(([, v]) => {
      if (v === undefined || v === null || v === '') return false;
      if (Array.isArray(v)) return v.length > 0;
      if (typeof v === 'object' && Object.getPrototypeOf(v) === Object.prototype)
        return Object.keys(v).length > 0;
      return true;
    }),
  ) as Partial<T>;
}

/** Runs `fn` over `items` with at most `limit` at a time, keeping the order. Spares a busy Immich. */
export async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T, index: number) => Promise<R>) {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i] as T, i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

/** How many Immich requests one tool call makes at once. */
export const CONCURRENCY = 4;

/**
 * When the photo was taken, as the wall-clock time where it was taken. Immich's localDateTime is that time
 * written as if it were UTC; when the file has no time zone, it is plain UTC, and that is said. A date at the
 * Unix epoch means the file had no date at all.
 */
export function takenAt(
  asset: Pick<AssetResponseDto, 'localDateTime' | 'fileCreatedAt'> & {
    exifInfo?: { timeZone?: string | null } | null;
  },
): string {
  if (Date.parse(asset.fileCreatedAt) < 24 * 3600 * 1000) return 'unknown';
  const local = asset.localDateTime.slice(0, 16).replace('T', ' ');
  const noZone =
    !asset.exifInfo?.timeZone && Date.parse(asset.localDateTime) === Date.parse(asset.fileCreatedAt);
  return noZone ? `${local} UTC` : local;
}

export function placeOf(asset: AssetResponseDto): string | undefined {
  const e = asset.exifInfo;
  const parts = [e?.city, e?.state, e?.country].filter((p): p is string => !!p);
  return parts.length ? parts.join(', ') : undefined;
}

export function photoUrl(ctx: ToolContext, id: string): string {
  return `${ctx.immichPublicUrl}/photos/${id}`;
}

/** The same words search_photos takes as `type`. */
export function kindOf(asset: Pick<AssetResponseDto, 'type'>): string {
  if (asset.type === AssetTypeEnum.Image) return 'photo';
  return asset.type.toLowerCase();
}

/** The short form used in lists. */
export function summarizeAsset(ctx: ToolContext, asset: AssetResponseDto) {
  return compact({
    id: asset.id,
    taken: takenAt(asset),
    type: kindOf(asset),
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

/** A video length in milliseconds as "m:ss" or "h:mm:ss". */
export function formatDuration(ms: number): string {
  const total = Math.round(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = String(total % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
}
