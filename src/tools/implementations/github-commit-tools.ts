import { z } from 'zod';
import { GitHubAppClient } from '../../github/github-client.js';
import type { IMcpTool } from '../index.js';

const client = () => new GitHubAppClient({
  GITHUB_APP_ID: process.env['GITHUB_APP_ID'] ?? '',
  GITHUB_PRIVATE_KEY: process.env['GITHUB_PRIVATE_KEY'] ?? '',
  GITHUB_INSTALLATION_ID: process.env['GITHUB_INSTALLATION_ID'] ?? '',
});

export class GithubCommitChangesTool implements IMcpTool {
  schema = {
    method: 'github_commit_changes',
    description: 'Create a commit after preparing repository changes.',
    params: z.object({
      repo: z.string(),
      branch: z.string(),
      message: z.string(),
      treeSha: z.string(),
      parentSha: z.string(),
    }),
    outputSchema: { type: 'object', additionalProperties: true },
  };

  async handler(params: { repo: string; branch: string; message: string; treeSha: string; parentSha: string }) {
    const commit = await client().request(`/repos/${params.repo}/git/commits`, {
      method: 'POST',
      body: JSON.stringify({
        message: params.message,
        tree: params.treeSha,
        parents: [params.parentSha],
      }),
    });

    await client().request(`/repos/${params.repo}/git/refs/heads/${encodeURIComponent(params.branch)}`, {
      method: 'PATCH',
      body: JSON.stringify({ sha: commit.sha }),
    });

    return commit;
  }
}
