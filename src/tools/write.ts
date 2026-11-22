import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  createPerson,
  getPerson,
  mergePeople,
  reassignFacesById,
  tagAssets,
  untagAssets,
  updateAssets,
  updatePerson,
  upsertTags,
  type AssetBulkUpdateDto,
  type PersonUpdateDto,
} from '@immich/sdk';
import { z } from 'zod';
import {
  compact,
  defineTool,
  EDIT,
  json,
  summarizePerson,
  ToolInputError,
  UUID,
  type ToolContext,
} from './context.js';
import { resolvePeople, resolvePerson, resolveTags } from './read.js';

const ids = z.array(z.string().regex(UUID, 'photo ids')).min(1).max(500);
const birthDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'use YYYY-MM-DD')
  .nullable();

export function registerWriteTools(server: McpServer, ctx: ToolContext): void {
  defineTool(
    server,
    ctx,
    'update_photos',
    {
      title: 'Edit photo details',
      description:
        'Set details on one or more photos: description, favorite, star rating (1-5, -1 = rejected, null = unrated), ' +
        'date taken (ISO 8601, with offset or with `time_zone`), and location. Every field given is applied to every photo listed.',
      inputSchema: {
        ids,
        description: z.string().max(5000).optional().describe('Replaces the description; "" clears it.'),
        favorite: z.boolean().optional(),
        rating: z.number().int().min(-1).max(5).nullable().optional(),
        taken_at: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})?$/, 'ISO 8601 date-time')
          .optional(),
        time_zone: z.string().optional().describe('IANA zone for taken_at, e.g. Europe/Helsinki.'),
        latitude: z.number().min(-90).max(90).optional(),
        longitude: z.number().min(-180).max(180).optional(),
      },
      annotations: EDIT,
    },
    async (args) => {
      if ((args.latitude === undefined) !== (args.longitude === undefined)) {
        throw new ToolInputError('Give latitude and longitude together.');
      }
      if (args.rating === 0)
        throw new ToolInputError('Rating 0 is not valid in Immich; use null for unrated.');
      const dto: AssetBulkUpdateDto = { ids: args.ids };
      if (args.description !== undefined) dto.description = args.description;
      if (args.favorite !== undefined) dto.isFavorite = args.favorite;
      if (args.rating !== undefined) dto.rating = args.rating as number;
      if (args.taken_at !== undefined) dto.dateTimeOriginal = args.taken_at;
      if (args.time_zone !== undefined) dto.timeZone = args.time_zone;
      if (args.latitude !== undefined) dto.latitude = args.latitude;
      if (args.longitude !== undefined) dto.longitude = args.longitude;
      if (Object.keys(dto).length === 1)
        throw new ToolInputError('Nothing to change: give at least one field.');
      await updateAssets({ assetBulkUpdateDto: dto }, ctx.opts);
      return json({ updated: args.ids.length });
    },
  );

  defineTool(
    server,
    ctx,
    'tag_photos',
    {
      title: 'Tag photos',
      description: 'Add tags to photos. Missing tags are created; nested tags are written Parent/Child.',
      inputSchema: { ids, tags: z.array(z.string().min(1)).min(1).max(20) },
      annotations: EDIT,
    },
    async (args) => {
      const tags = await upsertTags({ tagUpsertDto: { tags: args.tags } }, ctx.opts);
      for (const tag of tags) await tagAssets({ id: tag.id, bulkIdsDto: { ids: args.ids } }, ctx.opts);
      return json({ tagged: args.ids.length, tags: tags.map((t) => t.value) });
    },
  );

  defineTool(
    server,
    ctx,
    'untag_photos',
    {
      title: 'Remove tags from photos',
      description: 'Remove tags from photos. The tags themselves stay.',
      inputSchema: { ids, tags: z.array(z.string().min(1)).min(1).max(20).describe('Tag names or ids.') },
      annotations: EDIT,
    },
    async (args) => {
      const chosen = await resolveTags(ctx, args.tags);
      for (const tag of chosen) await untagAssets({ id: tag.id, bulkIdsDto: { ids: args.ids } }, ctx.opts);
      return json({ untagged: args.ids.length, tags: chosen.map((t) => t.value) });
    },
  );

  defineTool(
    server,
    ctx,
    'update_person',
    {
      title: 'Edit a person',
      description:
        'Rename a person, set or clear their birth date (YYYY-MM-DD, null clears), hide or favorite them.',
      inputSchema: {
        person: z.string().describe('Person name or id.'),
        name: z.string().max(200).optional(),
        birth_date: birthDate.optional(),
        hidden: z.boolean().optional(),
        favorite: z.boolean().optional(),
      },
      annotations: EDIT,
    },
    async (args) => {
      const id = await resolvePerson(ctx, args.person);
      const dto: PersonUpdateDto = {};
      if (args.name !== undefined) dto.name = args.name;
      if (args.birth_date !== undefined) (dto as { birthDate?: string | null }).birthDate = args.birth_date;
      if (args.hidden !== undefined) dto.isHidden = args.hidden;
      if (args.favorite !== undefined) dto.isFavorite = args.favorite;
      if (Object.keys(dto).length === 0)
        throw new ToolInputError('Nothing to change: give at least one field.');
      return json(summarizePerson(await updatePerson({ id, personUpdateDto: dto }, ctx.opts)));
    },
  );

  defineTool(
    server,
    ctx,
    'create_person',
    {
      title: 'Create a person',
      description: 'Create a new, empty person, to reassign faces to with reassign_face.',
      inputSchema: { name: z.string().min(1).max(200), birth_date: birthDate.optional() },
      annotations: { ...EDIT, idempotentHint: false },
    },
    async (args) => {
      const person = await createPerson(
        { personCreateDto: compact({ name: args.name, birthDate: args.birth_date ?? undefined }) },
        ctx.opts,
      );
      return json(summarizePerson(person));
    },
  );

  defineTool(
    server,
    ctx,
    'merge_people',
    {
      title: 'Merge people',
      description:
        'Merge people Immich split into several into one: all faces of `from` move to `into`, and the `from` people ' +
        'disappear. Cannot be undone with this connection. The name and birth date kept are the first ones set, `into` first. ' +
        'Immich also merges the matching people of other users who share face groups with this user.',
      inputSchema: {
        into: z.string().describe('Person name or id that remains.'),
        from: z.array(z.string()).min(1).max(50).describe('Person names or ids merged into it.'),
      },
      annotations: { ...EDIT, destructiveHint: true, idempotentHint: false },
    },
    async (args) => {
      const into = await resolvePerson(ctx, args.into);
      const from = await resolvePeople(ctx, args.from);
      if (from.includes(into)) throw new ToolInputError('`into` cannot also be in `from`.');
      const results = await mergePeople({ mergePersonDto: { ids: [into, ...from] } }, ctx.opts);
      const failed = results.filter((r) => !r.success);
      const person = await getPerson({ id: into }, ctx.opts);
      return json(
        compact({
          into: summarizePerson(person),
          merged: results.length - failed.length,
          failed: failed.map((r) => `${r.id}: ${r.error ?? 'failed'}`),
        }),
      );
    },
  );

  defineTool(
    server,
    ctx,
    'reassign_face',
    {
      title: 'Reassign a face',
      description:
        'Move one detected face to another person, for faces Immich got wrong. Face ids come from get_photo_details.',
      inputSchema: {
        face_id: z.string().regex(UUID, 'face id'),
        person: z.string().describe('Person name or id the face belongs to.'),
      },
      annotations: EDIT,
    },
    async (args) => {
      const id = await resolvePerson(ctx, args.person);
      const person = await reassignFacesById({ id, faceDto: { id: args.face_id } }, ctx.opts);
      return json({ face_id: args.face_id, now: summarizePerson(person) });
    },
  );
}
