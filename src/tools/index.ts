/**
 * MCP Tools for AT Protocol operations
 *
 * Comprehensive tools that enable LLMs to interact directly with the AT Protocol ecosystem
 */

import type { z } from 'zod';
import type { AtpClient } from '../utils/atp-client.js';
import { Logger } from '../utils/logger.js';
import {
  AddBookmarkTool,
  AddToListTool,
  AnalyzeAccountTool,
  AnalyzeImageTool,
  AnalyzeModerationStatusTool,
  BatchActionTool,
  BlockUserTool,
  CreateDevlogUpdateTool,
  CreateListTool,
  CreatePostTool,
  CreateThreadTool,
  DeletePostTool,
  DiscoverCommunitiesTool,
  DiscoverTool,
  FindInfluentialUsersTool,
  FindSimilarUsersTool,
  FollowUserTool,
  GenerateLinkPreviewTool,
  GetAuthorFeedTool,
  GetBookmarksTool,
  GetCommunityActivityTool,
  GetConversationMessagesTool,
  GetCustomFeedTool,
  GetListTool,
  GetNotificationsTool,
  GetPostContextTool,
  GetStarterPackTool,
  GetTimelineTool,
  GetUserConnectionsTool,
  GetUserProfileTool,
  GetUserSummaryTool,
  GithubApplyPatchTool,
  GithubCommitChangesTool,
  GithubCreateBranchTool,
  GithubCreateFixWorkflowTool,
  GithubCreatePullRequestTool,
  GithubGetBranchStatusTool,
  GithubGetCommitDetailsTool,
  GithubGetDiffTool,
  GithubGetFileTool,
  GithubGetRecentCommitsTool,
  GithubGetRecentPrsTool,
  GithubValidateChangeTool,
  LikePostTool,
  ListConversationsTool,
  MarkNotificationsSeenTool,
  MuteUserTool,
  RemoveBookmarkTool,
  RemoveFromListTool,
  ReplyToPostTool,
  ReportContentTool,
  ReportUserTool,
  RepostTool,
  SearchActorsTool,
  SearchPostsTool,
  SearchStarterPacksTool,
  SendDirectMessageTool,
  UnblockUserTool,
  UnfollowUserTool,
  UnlikePostTool,
  UnmuteUserTool,
  UnrepostTool,
  UpdateProfileTool,
  UploadImageTool,
  UploadVideoTool,
} from './implementations/index.js';

/**
 * Tool interface for MCP tools
 */
export interface IMcpTool {
  schema: {
    method: string;
    description: string;
    params?: z.ZodSchema;
    annotations?: IToolAnnotations;
    outputSchema?: Record<string, unknown>;
  };
  handler: (params: any) => Promise<any>;
}

export interface IToolAnnotations {
  title?: string;
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
}

export function createTools(atpClient: AtpClient): IMcpTool[] {
  const logger = new Logger('ToolsFactory');

  const toolFactories: Array<() => IMcpTool> = [
    // GitHub devlog tools
    () => new GithubGetRecentCommitsTool(),
    () => new GithubGetCommitDetailsTool(),
    () => new GithubGetRecentPrsTool(),
    () => new CreateDevlogUpdateTool(),

    // GitHub coding workflow
    () => new GithubGetFileTool(),
    () => new GithubGetDiffTool(),
    () => new GithubGetBranchStatusTool(),
    () => new GithubCreateBranchTool(),
    () => new GithubApplyPatchTool(),
    () => new GithubValidateChangeTool(),
    () => new GithubCommitChangesTool(),
    () => new GithubCreatePullRequestTool(),
    () => new GithubCreateFixWorkflowTool(),

    // Core social operations
    () => new CreatePostTool(atpClient),
    () => new CreateThreadTool(atpClient),
    () => new ReplyToPostTool(atpClient),
    () => new LikePostTool(atpClient),
    () => new UnlikePostTool(atpClient),
    () => new RepostTool(atpClient),
    () => new UnrepostTool(atpClient),

    // User operations
    () => new FollowUserTool(atpClient),
    () => new UnfollowUserTool(atpClient),
    () => new GetUserProfileTool(atpClient),

    // Data retrieval
    () => new SearchPostsTool(atpClient),
    () => new SearchActorsTool(atpClient),
    () => new GetAuthorFeedTool(atpClient),
    () => new GetTimelineTool(atpClient),
    () => new GetUserConnectionsTool(atpClient),
    () => new GetNotificationsTool(atpClient),
    () => new MarkNotificationsSeenTool(atpClient),
    () => new GetCommunityActivityTool(atpClient),

    // Direct messages
    () => new ListConversationsTool(atpClient),
    () => new GetConversationMessagesTool(atpClient),
    () => new SendDirectMessageTool(atpClient),

    // Content management
    () => new DeletePostTool(atpClient),
    () => new UpdateProfileTool(atpClient),

    // Private bookmarks
    () => new AddBookmarkTool(atpClient),
    () => new RemoveBookmarkTool(atpClient),
    () => new GetBookmarksTool(atpClient),

    // Content moderation
    () => new MuteUserTool(atpClient),
    () => new UnmuteUserTool(atpClient),
    () => new BlockUserTool(atpClient),
    () => new UnblockUserTool(atpClient),
    () => new ReportContentTool(atpClient),
    () => new ReportUserTool(atpClient),
    () => new AnalyzeModerationStatusTool(atpClient),

    // Advanced social features
    () => new CreateListTool(atpClient),
    () => new AddToListTool(atpClient),
    () => new RemoveFromListTool(atpClient),
    () => new GetListTool(atpClient),
    () => new GetCustomFeedTool(atpClient),

    // Enhanced media support
    () => new UploadImageTool(atpClient),
    () => new UploadVideoTool(atpClient),
    () => new GenerateLinkPreviewTool(atpClient),

    // Analytics
    () => new AnalyzeAccountTool(atpClient),
    () => new FindInfluentialUsersTool(atpClient),

    // Discovery
    () => new DiscoverTool(atpClient),
    () => new FindSimilarUsersTool(atpClient),
    () => new DiscoverCommunitiesTool(atpClient),

    // Starter packs
    () => new SearchStarterPacksTool(atpClient),
    () => new GetStarterPackTool(atpClient),

    // Batch operations
    () => new BatchActionTool(atpClient),

    // Composite operations
    () => new GetUserSummaryTool(atpClient),
    () => new GetPostContextTool(atpClient),

    // Rich media
    () => new AnalyzeImageTool(atpClient),
  ];

  const tools: IMcpTool[] = [];

  for (const make of toolFactories) {
    try {
      tools.push(make());
    } catch (error) {
      logger.error('Failed to construct an MCP tool; skipping it', error);
    }
  }

  logger.info(`Created ${tools.length} AT Protocol MCP tools`);
  return tools;
}
