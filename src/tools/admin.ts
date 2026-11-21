import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  getAboutInfo,
  getQueues,
  getServerStatistics,
  getStorage,
  QueueCommand,
  QueueName,
  runQueueCommandLegacy,
  searchUsersAdmin,
  updateQueue,
} from '@immich/sdk';
import { z } from 'zod';
import { compact, guarded, json, type ToolContext } from './context.js';

const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };

const gib = (bytes: number) => `${(bytes / 1024 ** 3).toFixed(1)} GiB`;

/** Registered only for Immich administrators. */
export function registerAdminTools(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    'admin_server_overview',
    {
      title: 'Server overview (admin)',
      description: 'Immich version and build, disk use, and photo, video and storage totals per user.',
      inputSchema: {},
      annotations: READ_ONLY,
    },
    guarded(ctx, async () => {
      const [about, storage, stats] = await Promise.all([
        getAboutInfo(ctx.opts),
        getStorage(ctx.opts),
        getServerStatistics(ctx.opts),
      ]);
      return json({
        version: about.version,
        disk: {
          size: storage.diskSize,
          used: storage.diskUse,
          free: storage.diskAvailable,
          used_percent: storage.diskUsagePercentage,
        },
        totals: { photos: stats.photos, videos: stats.videos, storage: gib(stats.usage) },
        users: stats.usageByUser.map((u) => ({
          name: u.userName,
          photos: u.photos,
          videos: u.videos,
          storage: gib(u.usage),
          quota: u.quotaSizeInBytes ? gib(u.quotaSizeInBytes) : undefined,
        })),
      });
    }),
  );

  server.registerTool(
    'admin_list_users',
    {
      title: 'Users (admin)',
      description: 'Every Immich user with email, admin flag, status and quota.',
      inputSchema: {},
      annotations: READ_ONLY,
    },
    guarded(ctx, async () =>
      json(
        (await searchUsersAdmin({}, ctx.opts)).map((u) =>
          compact({
            id: u.id,
            name: u.name,
            email: u.email,
            admin: u.isAdmin || undefined,
            status: u.status,
            quota: u.quotaSizeInBytes ? gib(u.quotaSizeInBytes) : undefined,
            used: u.quotaUsageInBytes ? gib(u.quotaUsageInBytes) : undefined,
            deleted: u.deletedAt ?? undefined,
          }),
        ),
      ),
    ),
  );

  server.registerTool(
    'admin_job_queues',
    {
      title: 'Job queues (admin)',
      description:
        'Immich background job queues (thumbnails, face recognition, smart search, …): waiting, active, failed, paused.',
      inputSchema: {},
      annotations: READ_ONLY,
    },
    guarded(ctx, async () =>
      json(
        (await getQueues(ctx.opts)).map((q) =>
          compact({ queue: q.name, is_paused: q.isPaused || undefined, ...q.statistics }),
        ),
      ),
    ),
  );

  server.registerTool(
    'admin_queue_control',
    {
      title: 'Start, pause or resume a queue (admin)',
      description:
        '`start` queues the items this job has not processed yet (never a forced re-run of everything); ' +
        '`pause` and `resume` stop and continue a queue.',
      inputSchema: {
        queue: z.enum(Object.values(QueueName) as [string, ...string[]]),
        action: z.enum(['start', 'pause', 'resume']),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    guarded(ctx, async (args: { queue: string; action: 'start' | 'pause' | 'resume' }) => {
      const name = args.queue as QueueName;
      if (args.action === 'start') {
        await runQueueCommandLegacy(
          { name, queueCommandDto: { command: QueueCommand.Start, force: false } },
          ctx.opts,
        );
      } else {
        await updateQueue({ name, queueUpdateDto: { isPaused: args.action === 'pause' } }, ctx.opts);
      }
      return json({ queue: args.queue, done: args.action });
    }),
  );
}
