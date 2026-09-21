import { beforeEach, describe, expect, it, vi } from 'vitest';

const { request } = vi.hoisted(() => ({
  request: vi.fn(),
}));

vi.mock('../../../github/github-client.js', () => ({
  GitHubAppClient: vi.fn(() => ({ request })),
}));

import {
  CreateDevlogUpdateTool,
  GithubGetRecentCommitsTool,
  GithubGetRecentPrsTool,
} from '../github-devlog-tools.js';

describe('GitHub devlog tool structured content', () => {
  beforeEach(() => {
    request.mockReset();
  });

  it('wraps recent commits in the schema result object', async () => {
    request.mockResolvedValueOnce([
      {
        sha: 'abc123',
        commit: {
          message: 'Fix validation',
          author: { name: 'Developer', date: '2026-09-21T00:00:00Z' },
        },
      },
    ]);

    await expect(
      new GithubGetRecentCommitsTool().handler({ since: '2026-09-20T00:00:00Z' })
    ).resolves.toEqual({
      result: [
        {
          sha: 'abc123',
          message: 'Fix validation',
          author: 'Developer',
          timestamp: '2026-09-21T00:00:00Z',
        },
      ],
    });
  });

  it('wraps recent pull requests in the schema result object', async () => {
    const mergedPull = {
      number: 42,
      title: 'Fix MCP response validation',
      merged_at: '2026-09-21T00:00:00Z',
    };
    request.mockResolvedValueOnce([mergedPull, { number: 41, merged_at: null }]);

    await expect(
      new GithubGetRecentPrsTool().handler({ since: '2026-09-20T00:00:00Z' })
    ).resolves.toEqual({ result: [mergedPull] });
  });

  it('keeps create_devlog_update compatible with wrapped list responses', async () => {
    request.mockResolvedValueOnce([]).mockResolvedValueOnce([]);

    await expect(
      new CreateDevlogUpdateTool().handler({ checkpoint: '2026-09-20T00:00:00Z' })
    ).resolves.toMatchObject({
      shouldPost: false,
      commitReferences: [],
    });
  });
});
