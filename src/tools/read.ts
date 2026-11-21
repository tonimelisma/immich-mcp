import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import {
  AssetMediaSize,
  AssetOrder,
  AssetTypeEnum,
  getAllAlbums,
  getAllPeople,
  getAllTags,
  getAssetInfo,
  getAssetOcr,
  getFaces,
  getPersonStatistics,
  getSearchSuggestions,
  getMyUser,
  getServerVersion,
  searchAssets,
  searchPerson,
  searchSmart,
  SearchSuggestionType,
  viewAsset,
  AlbumUserRole,
  type AlbumResponseDto,
  type AssetResponseDto,
  type MetadataSearchDto,
  type SmartSearchDto,
} from '@immich/sdk';
import { z } from 'zod';
import { permissionsFor } from '../immich.js';
import {
  compact,
  guarded,
  json,
  localTime,
  photoUrl,
  placeOf,
  summarizeAsset,
  summarizePerson,
  ToolInputError,
  UUID,
  type ToolContext,
} from './context.js';

const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };

const date = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}(T[\d:.]+(Z|[+-]\d{2}:?\d{2})?)?$/, 'use YYYY-MM-DD or an ISO 8601 date-time');

/** Accepts person ids or names; a name must match exactly one person. */
export async function resolvePeople(ctx: ToolContext, refs: string[]): Promise<string[]> {
  const ids: string[] = [];
  for (const ref of refs) {
    if (UUID.test(ref)) {
      ids.push(ref);
      continue;
    }
    const found = await searchPerson({ name: ref, withHidden: true }, ctx.opts);
    const exact = found.filter((p) => p.name.toLowerCase() === ref.toLowerCase());
    const pick = exact.length ? exact : found;
    if (pick.length === 1 && pick[0]) {
      ids.push(pick[0].id);
    } else if (pick.length === 0) {
      throw new ToolInputError(`No person named "${ref}". Use list_people to see the names.`);
    } else {
      const options = pick.slice(0, 10).map((p) => `${p.name || '(unnamed)'} [${p.id}]`);
      throw new ToolInputError(`"${ref}" matches several people; pass one id instead: ${options.join(', ')}`);
    }
  }
  return ids;
}

export async function resolvePerson(ctx: ToolContext, ref: string): Promise<string> {
  const [id] = await resolvePeople(ctx, [ref]);
  return id as string;
}

/** Accepts album ids or names; a name must match exactly one album the user can see. */
export async function resolveAlbum(ctx: ToolContext, ref: string): Promise<string> {
  if (UUID.test(ref)) return ref;
  const albums = await getAllAlbums({}, ctx.opts);
  const lower = ref.toLowerCase();
  const exact = albums.filter((a) => a.albumName.toLowerCase() === lower);
  const pick = exact.length ? exact : albums.filter((a) => a.albumName.toLowerCase().includes(lower));
  if (pick.length === 1 && pick[0]) return pick[0].id;
  if (pick.length === 0) throw new ToolInputError(`No album named "${ref}". Use list_albums to see them.`);
  throw new ToolInputError(
    `"${ref}" matches several albums; pass one id instead: ${pick
      .slice(0, 10)
      .map((a) => `${a.albumName} [${a.id}]`)
      .join(', ')}`,
  );
}

export const searchInput = {
  query: z
    .string()
    .optional()
    .describe(
      'What the photo shows, in natural language ("kids on a beach at sunset"). Uses Immich smart search.',
    ),
  text_in_photo: z
    .string()
    .optional()
    .describe('Text visible in the photo (signs, documents), found by OCR.'),
  people: z
    .array(z.string())
    .optional()
    .describe('Person names or ids; every listed person must be in the photo.'),
  city: z.string().optional(),
  state: z.string().optional(),
  country: z
    .string()
    .optional()
    .describe('Place names as Immich stores them; search_suggestions lists them.'),
  taken_after: date.optional().describe('Earliest date taken, YYYY-MM-DD or ISO date-time.'),
  taken_before: date.optional().describe('Latest date taken, YYYY-MM-DD or ISO date-time.'),
  type: z.enum(['photo', 'video']).optional(),
  favorite: z.boolean().optional(),
  rating: z.number().int().min(-1).max(5).optional().describe('Exact star rating, -1 = rejected.'),
  album: z.string().optional().describe('Album name or id.'),
  tags: z.array(z.string()).optional().describe('Tag names or ids; the photo must have all of them.'),
  file_name: z.string().optional().describe('Part of the original file name (not with query).'),
  description: z.string().optional().describe('Text in the photo description (not with query).'),
  camera_make: z.string().optional(),
  camera_model: z.string().optional(),
  order: z
    .enum(['newest', 'oldest'])
    .optional()
    .describe('Sort by date taken (not with query, which ranks by relevance).'),
  page: z.number().int().min(1).optional(),
  limit: z.number().int().min(1).max(100).optional().describe('Results per page, default 25.'),
};

type SearchArgs = {
  [K in keyof typeof searchInput]?: z.infer<(typeof searchInput)[K]>;
};

const endOfDay = (value: string) => (value.length === 10 ? `${value}T23:59:59.999Z` : value);
const startOfDay = (value: string) => (value.length === 10 ? `${value}T00:00:00.000Z` : value);

async function resolveTags(ctx: ToolContext, refs: string[]): Promise<string[]> {
  const all = await getAllTags(ctx.opts);
  return refs.map((ref) => {
    if (UUID.test(ref)) return ref;
    const tag = all.find(
      (t) => t.value.toLowerCase() === ref.toLowerCase() || t.name.toLowerCase() === ref.toLowerCase(),
    );
    if (!tag) throw new ToolInputError(`No tag "${ref}". Use list_tags to see them.`);
    return tag.id;
  });
}

export async function runSearch(ctx: ToolContext, args: SearchArgs): Promise<CallToolResult> {
  const size = args.limit ?? 25;
  const page = args.page ?? 1;
  const common = compact({
    personIds: args.people?.length ? await resolvePeople(ctx, args.people) : undefined,
    albumIds: args.album ? [await resolveAlbum(ctx, args.album)] : undefined,
    tagIds: args.tags?.length ? await resolveTags(ctx, args.tags) : undefined,
    city: args.city,
    state: args.state,
    country: args.country,
    takenAfter: args.taken_after ? startOfDay(args.taken_after) : undefined,
    takenBefore: args.taken_before ? endOfDay(args.taken_before) : undefined,
    type:
      args.type === 'photo' ? AssetTypeEnum.Image : args.type === 'video' ? AssetTypeEnum.Video : undefined,
    isFavorite: args.favorite,
    rating: args.rating,
    make: args.camera_make,
    model: args.camera_model,
    ocr: args.text_in_photo,
  });
  let result;
  if (args.query) {
    if (args.file_name || args.description || args.order) {
      throw new ToolInputError('file_name, description and order cannot be combined with query; drop one.');
    }
    const dto: SmartSearchDto = { ...common, query: args.query, page, size, withExif: true };
    result = await searchSmart({ smartSearchDto: dto }, ctx.opts);
  } else {
    const dto: MetadataSearchDto = {
      ...common,
      originalFileName: args.file_name,
      description: args.description,
      order: args.order === 'oldest' ? AssetOrder.Asc : AssetOrder.Desc,
      page,
      size,
      withExif: true,
      withPeople: true,
    };
    result = await searchAssets({ metadataSearchDto: dto }, ctx.opts);
  }
  const assets = result.assets;
  return json({
    page,
    count: assets.count,
    next_page: assets.nextPage ? Number(assets.nextPage) : undefined,
    photos: assets.items.map((a) => summarizeAsset(ctx, a)),
  });
}

/** The owner's name when it is someone else's album shared with this user. */
function ownerName(ctx: ToolContext, users: AlbumResponseDto['albumUsers']): string | undefined {
  const owner = users.find((u) => u.role === AlbumUserRole.Owner);
  return owner && owner.user.id !== ctx.grant.userId ? owner.user.name : undefined;
}

function details(ctx: ToolContext, asset: AssetResponseDto) {
  const e = asset.exifInfo;
  return compact({
    id: asset.id,
    url: photoUrl(ctx, asset.id),
    type: asset.type.toLowerCase(),
    file: asset.originalFileName,
    taken: localTime(asset),
    time_zone: e?.timeZone ?? undefined,
    place: placeOf(asset),
    gps:
      e?.latitude != null && e?.longitude != null
        ? { latitude: e.latitude, longitude: e.longitude }
        : undefined,
    description: e?.description || undefined,
    favorite: asset.isFavorite,
    rating: e?.rating ?? undefined,
    archived: asset.isArchived || undefined,
    tags: asset.tags?.map((t) => t.value),
    camera: [e?.make, e?.model].filter(Boolean).join(' ') || undefined,
    lens: e?.lensModel ?? undefined,
    exposure: compact({
      aperture: e?.fNumber ? `f/${e.fNumber}` : undefined,
      shutter: e?.exposureTime ? `${e.exposureTime} s` : undefined,
      iso: e?.iso ?? undefined,
      focal_length: e?.focalLength ? `${e.focalLength} mm` : undefined,
    }),
    size: compact({
      width: e?.exifImageWidth ?? asset.width ?? undefined,
      height: e?.exifImageHeight ?? asset.height ?? undefined,
      bytes: e?.fileSizeInByte ?? undefined,
    }),
    duration: asset.type === AssetTypeEnum.Video ? asset.duration : undefined,
    stack: asset.stack ? { id: asset.stack.id, photos: asset.stack.assetCount } : undefined,
  });
}

export function registerReadTools(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    'search_photos',
    {
      title: 'Search photos',
      description:
        'Find photos and videos in Immich. Combine a natural-language `query` (smart search) with filters for people, ' +
        'place, dates, type, album, tags, rating and text in the photo. Without `query` it is a plain filter, sorted by date. ' +
        'Returns ids for view_photos and get_photo_details.',
      inputSchema: searchInput,
      annotations: READ_ONLY,
    },
    guarded(ctx, (args: SearchArgs) => runSearch(ctx, args)),
  );

  server.registerTool(
    'view_photos',
    {
      title: 'View photos',
      description:
        'Show photos to you as images so you can look at them. `large` (about 1440 px, default for up to 3 photos) ' +
        'or `small` (about 250 px, default for more). Up to 4 large or 16 small per call. Videos show their poster frame.',
      inputSchema: {
        ids: z.array(z.string().regex(UUID, 'photo ids')).min(1).max(16),
        size: z.enum(['small', 'large']).optional(),
      },
      annotations: READ_ONLY,
    },
    guarded(ctx, async ({ ids, size }: { ids: string[]; size?: 'small' | 'large' }) => {
      const chosen = size ?? (ids.length <= 3 ? 'large' : 'small');
      if (chosen === 'large' && ids.length > 4)
        throw new ToolInputError('At most 4 large photos per call; use size "small" or fewer ids.');
      const content: CallToolResult['content'] = [];
      for (const id of ids) {
        const [info, blob] = await Promise.all([
          getAssetInfo({ id }, ctx.opts),
          viewAsset(
            { id, size: chosen === 'large' ? AssetMediaSize.Preview : AssetMediaSize.Thumbnail },
            ctx.opts,
          ),
        ]);
        const s = summarizeAsset(ctx, info);
        content.push({
          type: 'text',
          text: [s.id, s.taken, s.place, s.people?.join(', ')].filter(Boolean).join(' · '),
        });
        content.push({
          type: 'image',
          mimeType: blob.type || 'image/jpeg',
          data: Buffer.from(await blob.arrayBuffer()).toString('base64'),
        });
      }
      return { content };
    }),
  );

  server.registerTool(
    'get_photo_details',
    {
      title: 'Photo details',
      description:
        'Full details of photos: date and time zone, place and GPS, camera and exposure, description, rating, tags, ' +
        'and each detected face with its face id, box and person (for reassign_face). Optionally the text found in the photo.',
      inputSchema: {
        ids: z.array(z.string().regex(UUID, 'photo ids')).min(1).max(20),
        include_text: z.boolean().optional().describe('Also return text recognised in the photo (OCR).'),
      },
      annotations: READ_ONLY,
    },
    guarded(ctx, async ({ ids, include_text }: { ids: string[]; include_text?: boolean }) => {
      const out = [];
      for (const id of ids) {
        const [asset, faces, ocr] = await Promise.all([
          getAssetInfo({ id }, ctx.opts),
          getFaces({ id }, ctx.opts),
          include_text ? getAssetOcr({ id }, ctx.opts) : Promise.resolve([]),
        ]);
        out.push({
          ...details(ctx, asset),
          faces: faces.map((f) =>
            compact({
              face_id: f.id,
              person: f.person ? `${f.person.name || '(unnamed)'} [${f.person.id}]` : '(not recognised)',
              box: { x1: f.boundingBoxX1, y1: f.boundingBoxY1, x2: f.boundingBoxX2, y2: f.boundingBoxY2 },
              image_size: `${f.imageWidth}x${f.imageHeight}`,
            }),
          ),
          text: include_text ? ocr.map((o) => o.text).join('\n') || undefined : undefined,
        });
      }
      return json(out);
    }),
  );

  server.registerTool(
    'list_people',
    {
      title: 'List people',
      description:
        'People Immich recognises, with ids, names and birth dates. Filter by name; `with_counts` adds the number of photos ' +
        '(for up to 50 results).',
      inputSchema: {
        name: z.string().optional(),
        include_hidden: z.boolean().optional(),
        include_unnamed: z.boolean().optional().describe('Include people without a name (default false).'),
        with_counts: z.boolean().optional(),
        page: z.number().int().min(1).optional(),
        limit: z.number().int().min(1).max(500).optional().describe('Default 100.'),
      },
      annotations: READ_ONLY,
    },
    guarded(
      ctx,
      async (args: {
        name?: string;
        include_hidden?: boolean;
        include_unnamed?: boolean;
        with_counts?: boolean;
        page?: number;
        limit?: number;
      }) => {
        const limit = args.limit ?? 100;
        let people;
        let total: number | undefined;
        let hasMore = false;
        if (args.name) {
          people = await searchPerson({ name: args.name, withHidden: args.include_hidden }, ctx.opts);
        } else {
          const res = await getAllPeople(
            { withHidden: args.include_hidden, page: args.page ?? 1, size: limit },
            ctx.opts,
          );
          people = res.people;
          total = res.total;
          hasMore = !!res.hasNextPage;
        }
        if (!args.include_unnamed) people = people.filter((p) => p.name);
        const rows: Record<string, unknown>[] = people.map((p) => summarizePerson(p));
        if (args.with_counts) {
          if (rows.length > 50)
            throw new ToolInputError('with_counts works for up to 50 people; narrow the list.');
          await Promise.all(
            people.map(async (p, i) => {
              const row = rows[i];
              if (row) row.photos = (await getPersonStatistics({ id: p.id }, ctx.opts)).assets;
            }),
          );
        }
        return json(compact({ total, has_more: hasMore || undefined, people: rows }));
      },
    ),
  );

  server.registerTool(
    'list_albums',
    {
      title: 'List albums',
      description:
        'Albums the user owns or that are shared with them. Use the id or name as `album` in search_photos.',
      inputSchema: { name: z.string().optional().describe('Part of the album name.') },
      annotations: READ_ONLY,
    },
    guarded(ctx, async ({ name }: { name?: string }) => {
      const albums = await getAllAlbums({}, ctx.opts);
      const lower = name?.toLowerCase();
      return json(
        albums
          .filter((a) => !lower || a.albumName.toLowerCase().includes(lower))
          .map((a) =>
            compact({
              id: a.id,
              name: a.albumName,
              photos: a.assetCount,
              from: a.startDate?.slice(0, 10),
              to: a.endDate?.slice(0, 10),
              description: a.description,
              owner: ownerName(ctx, a.albumUsers),
              shared: a.shared || undefined,
            }),
          ),
      );
    }),
  );

  server.registerTool(
    'list_tags',
    {
      title: 'List tags',
      description: 'All tags, with ids. Nested tags are written Parent/Child.',
      inputSchema: {},
      annotations: READ_ONLY,
    },
    guarded(ctx, async () => json((await getAllTags(ctx.opts)).map((t) => ({ id: t.id, tag: t.value })))),
  );

  server.registerTool(
    'search_suggestions',
    {
      title: 'Places and cameras',
      description:
        'The values Immich has for a field, to get spellings right for search_photos: countries, states (optionally within ' +
        'a country), cities (optionally within a country and state), camera makes, camera models.',
      inputSchema: {
        field: z.enum(['country', 'state', 'city', 'camera_make', 'camera_model']),
        country: z.string().optional(),
        state: z.string().optional(),
        camera_make: z.string().optional(),
      },
      annotations: READ_ONLY,
    },
    guarded(
      ctx,
      async (args: {
        field: 'country' | 'state' | 'city' | 'camera_make' | 'camera_model';
        country?: string;
        state?: string;
        camera_make?: string;
      }) => {
        const type = {
          country: SearchSuggestionType.Country,
          state: SearchSuggestionType.State,
          city: SearchSuggestionType.City,
          camera_make: SearchSuggestionType.CameraMake,
          camera_model: SearchSuggestionType.CameraModel,
        }[args.field];
        const values = await getSearchSuggestions(
          { $type: type, country: args.country, state: args.state, make: args.camera_make },
          ctx.opts,
        );
        return json(values.filter(Boolean).sort((a, b) => a.localeCompare(b)));
      },
    ),
  );

  server.registerTool(
    'about_connection',
    {
      title: 'About this connection',
      description: 'Who is signed in, the Immich version, and what this connection may do.',
      inputSchema: {},
      annotations: READ_ONLY,
    },
    guarded(ctx, async () => {
      // getMyUser needs the key, so this also confirms Immich still accepts it; the version endpoint is public.
      const [me, version] = await Promise.all([getMyUser(ctx.opts), getServerVersion(ctx.opts)]);
      return json({
        user: me.name,
        email: me.email,
        admin: ctx.grant.isAdmin,
        immich: `${ctx.immichPublicUrl} v${version.major}.${version.minor}.${version.patch}`,
        permissions: permissionsFor(ctx.grant.isAdmin),
        cannot: 'delete or trash anything, change albums, sharing or settings',
      });
    }),
  );
}
