import { z } from 'zod';
import { BaseTool, ToolAuthMode } from './base-tool.js';
import type { AtpClient } from '../../utils/atp-client.js';

const CommunityActivitySchema = z.object({
  since: z.string().optional().describe('ISO 8601 timestamp. Only activity after this time is returned.'),
  limit: z.number().int().min(1).max(100).default(100).describe('Maximum notifications to inspect (1-100).'),
});

type ActivityKind = 'like' | 'follow' | 'reply' | 'mention' | 'quote' | 'repost';

const INCLUDED_REASONS = new Set<ActivityKind>([
  'like',
  'follow',
  'reply',
  'mention',
  'quote',
  'repost',
]);

export class GetCommunityActivityTool extends BaseTool {
  public readonly schema = {
    method: 'get_community_activity',
    description:
      'Get recent Bluesky community activity for an agent/community-manager loop. Returns likes, new followers, replies, mentions, quotes, and reposts grouped into a compact summary. Requires authentication. This tool is read-only and does not mark notifications seen or publish replies. Inspect reply/mention thread context before deciding how to respond.',
    params: CommunityActivitySchema,
    annotations: {
      title: 'Get Bluesky community activity',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  };

  constructor(atpClient: AtpClient) {
    super(atpClient, 'GetCommunityActivity', ToolAuthMode.PRIVATE);
  }

  protected async execute(params: { since?: string; limit?: number }): Promise<any> {
    try {
      const response = await this.executeAtpOperation(
        async () => {
          const agent = this.atpClient.getAgent();
          return await agent.listNotifications({
            limit: params.limit ?? 100,
            seenAt: params.since,
          });
        },
        'listNotifications',
        { limit: params.limit ?? 100, since: params.since }
      );

      const activity = response.data.notifications
        .filter((notification: any) => INCLUDED_REASONS.has(notification.reason as ActivityKind))
        .filter(
          (notification: any) =>
            !params.since || new Date(notification.indexedAt).getTime() > new Date(params.since).getTime()
        )
        .map((notification: any) => ({
          id: `${notification.uri}:${notification.cid}:${notification.reason}`,
          kind: notification.reason as ActivityKind,
          uri: notification.uri,
          cid: notification.cid,
          indexedAt: notification.indexedAt,
          isRead: notification.isRead,
          author: {
            did: notification.author.did,
            handle: notification.author.handle,
            displayName: notification.author.displayName,
            avatar: notification.author.avatar,
          },
          record: notification.record,
        }));

      const grouped = {
        likes: activity.filter((item: any) => item.kind === 'like'),
        followers: activity.filter((item: any) => item.kind === 'follow'),
        replies: activity.filter((item: any) => item.kind === 'reply'),
        mentions: activity.filter((item: any) => item.kind === 'mention'),
        quotes: activity.filter((item: any) => item.kind === 'quote'),
        reposts: activity.filter((item: any) => item.kind === 'repost'),
      };

      return {
        success: true,
        checkedAt: new Date().toISOString(),
        since: params.since,
        total: activity.length,
        counts: {
          likes: grouped.likes.length,
          followers: grouped.followers.length,
          replies: grouped.replies.length,
          mentions: grouped.mentions.length,
          quotes: grouped.quotes.length,
          reposts: grouped.reposts.length,
        },
        activity,
        grouped,
        cursor: response.data.cursor,
      };
    } catch (error) {
      this.logger.error('Failed to retrieve community activity', error);
      this.formatError(error);
    }
  }
}
