import { z } from 'zod';
import { GitHubAppClient } from '../../github/github-client.js';
import type { IMcpTool } from '../index.js';

const repo = 'maybetallgames/LetsDive';

function client(): GitHubAppClient {
  return new GitHubAppClient({
    GITHUB_APP_ID: process.env.GITHUB_APP_ID ?? '',
    GITHUB_PRIVATE_KEY: process.env.GITHUB_PRIVATE_KEY ?? '',
    GITHUB_INSTALLATION_ID: process.env.GITHUB_INSTALLATION_ID ?? '',
  });
}

export class GithubGetRecentCommitsTool implements IMcpTool {
  schema = {
    method: 'github_get_recent_commits',
    description: 'Return recent Lets Dive commits after a timestamp checkpoint.',
    params: z.object({ since: z.string() }),
  };

  async handler({ since }: { since: string }) {
    const commits = await client().request(`/repos/${repo}/commits?since=${encodeURIComponent(since)}`);
    return commits.map((commit: any) => ({
      sha: commit.sha,
      message: commit.commit.message,
      author: commit.commit.author?.name,
      timestamp: commit.commit.author?.date,
    }));
  }
}

export class GithubGetCommitDetailsTool implements IMcpTool {
  schema = {
    method: 'github_get_commit_details',
    description: 'Return commit details and changed files.',
    params: z.object({ sha: z.string() }),
  };

  async handler({ sha }: { sha: string }) {
    return client().request(`/repos/${repo}/commits/${sha}`);
  }
}

export class GithubGetRecentPrsTool implements IMcpTool {
  schema = {
    method: 'github_get_recent_prs',
    description: 'Return recently merged pull requests.',
    params: z.object({ since: z.string() }),
  };

  async handler({ since }: { since: string }) {
    return client().request(`/repos/${repo}/pulls?state=closed&sort=updated`);
  }
}

export class CreateDevlogUpdateTool implements IMcpTool {
  schema = {
    method: 'create_devlog_update',
    description: 'Create a Bluesky-ready Lets Dive development update from GitHub changes.',
    params: z.object({ checkpoint: z.string() }),
  };

  async handler({ checkpoint }: { checkpoint: string }) {
    const commits = await new GithubGetRecentCommitsTool().handler({ since: checkpoint });

    if (!commits.length) {
      return {
        shouldPost: false,
        text: '',
        technicalSummary: 'No new development changes.',
        mediaNeeded: '',
        commitReferences: [],
      };
    }

    return {
      shouldPost: true,
      text: `🛠️ Let's Dive update: ${commits[0].message}`,
      technicalSummary: commits.map((c: any) => c.message).join('\n'),
      mediaNeeded: '',
      commitReferences: commits.map((c: any) => c.sha),
    };
  }
}
