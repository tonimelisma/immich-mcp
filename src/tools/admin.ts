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
import { compact, defineTool, EDIT, json, READ_ONLY, type ToolContext } from './context.js';

const gib = (bytes: number) => `${(bytes / 1024 ** 3).toFixed(1)} GiB`;

/** Registered only for Immich administrators. */
export function registerAdminTools(server: McpServer, ctx: ToolContext): void {
  defineTool(
    server,
    ctx,
    'admin_server_overview',
    {
      title: 'Server overview (admin)',
      description:
        'Immich version and build, disk use, and photo and video totals per user, with the size of the files uploaded ' +
        'to Immich (Immich does not count files in external libraries).',
      inputSchema: {},
      annotations: READ_ONLY,
    },
    async () => {
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
        totals: { photos: stats.photos, videos: stats.videos, uploaded_files: gib(stats.usage) },
        users: stats.usageByUser.map((u) =>
          compact({
            name: u.userName,
            photos: u.photos,
            videos: u.videos,
            uploaded_files: gib(u.usage),
            quota: u.quotaSizeInBytes ? gib(u.quotaSizeInBytes) : undefined,
          }),
        ),
        note:
          stats.usage === 0 && stats.photos + stats.videos > 0
            ? 'uploaded_files is 0 although there are photos: they are probably in external libraries, which Immich does not count.'
            : 'uploaded_files counts files uploaded to Immich; files in external libraries are not included.',
      });
    },
  );

  defineTool(
    server,
    ctx,
    'admin_list_users',
    {
      title: 'Users (admin)',
      description: 'Every Immich user with email, admin flag, status and quota.',
      inputSchema: {},
      annotations: READ_ONLY,
    },
    async () =>
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
  );

  defineTool(
    server,
    ctx,
    'admin_job_queues',
    {
      title: 'Job queues (admin)',
      description:
        'Immich background job queues (thumbnails, face recognition, smart search, …): for each busy queue the jobs ' +
        'waiting, active, delayed and failed, and whether it is paused; `failed` counts the failed jobs of queues with ' +
        'no other work, and the rest are listed as idle.',
      inputSchema: {},
      annotations: READ_ONLY,
    },
    async () => {
      const busy = [];
      const failedOnly: Record<string, number> = {};
      const idle: string[] = [];
      for (const q of await getQueues(ctx.opts)) {
        // `completed` is always 0 (Immich does not keep finished jobs) and `paused` repeats is_paused.
        const { active, waiting, delayed, failed } = q.statistics;
        const counts = compact({
          active: active || undefined,
          waiting: waiting || undefined,
          delayed: delayed || undefined,
          failed: failed || undefined,
        });
        if (active || waiting || delayed || q.isPaused)
          busy.push({ queue: q.name, paused: q.isPaused || undefined, ...counts });
        else if (failed) failedOnly[q.name] = failed;
        else idle.push(q.name);
      }
      return json({ busy, failed: failedOnly, idle });
    },
  );

  defineTool(
    server,
    ctx,
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
      annotations: EDIT,
    },
    async (args) => {
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
    },
  );
}
