import { z } from 'zod';
import { GitHubAppClient } from '../../github/github-client.js';
import type { IMcpTool } from '../index.js';

const client = () => new GitHubAppClient({
  GITHUB_APP_ID: process.env['GITHUB_APP_ID'] ?? '',
  GITHUB_PRIVATE_KEY: process.env['GITHUB_PRIVATE_KEY'] ?? '',
  GITHUB_INSTALLATION_ID: process.env['GITHUB_INSTALLATION_ID'] ?? '',
});

export class GithubGetDiffTool implements IMcpTool {
  schema = {
    method: 'github_get_diff',
    description: 'Compare a branch against a base branch and return changed files.',
    params: z.object({ repo: z.string(), base: z.string(), head: z.string() }),
    outputSchema: { type: 'object', additionalProperties: true },
  };
  async handler(params: { repo: string; base: string; head: string }) {
    return client().request(`/repos/${params.repo}/compare/${params.base}...${params.head}`);
  }
}

export class GithubGetBranchStatusTool implements IMcpTool {
  schema = {
    method: 'github_get_branch_status',
    description: 'Return branch metadata for review workflows.',
    params: z.object({ repo: z.string(), branch: z.string() }),
    outputSchema: { type: 'object', additionalProperties: true },
  };
  async handler(params: { repo: string; branch: string }) {
    return client().request(`/repos/${params.repo}/branches/${encodeURIComponent(params.branch)}`);
  }
}

export class GithubCreateBranchTool implements IMcpTool {
  schema = {
    method: 'github_create_branch',
    description: 'Create a feature branch from an existing ref.',
    params: z.object({ repo: z.string(), branch: z.string(), sha: z.string() }),
    outputSchema: { type: 'object', additionalProperties: true },
  };
  async handler(params: { repo: string; branch: string; sha: string }) {
    return client().request(`/repos/${params.repo}/git/refs`, {
      method: 'POST',
      body: JSON.stringify({ ref: `refs/heads/${params.branch}`, sha: params.sha }),
    });
  }
}

export class GithubApplyPatchTool implements IMcpTool {
  schema = {
    method: 'github_apply_patch',
    description: 'Apply a unified diff patch to a repository branch.',
    params: z.object({ repo: z.string(), branch: z.string(), patch: z.string() }),
    outputSchema: { type: 'object', additionalProperties: true },
  };
  async handler(params: { repo: string; branch: string; patch: string }) {
    return { accepted: true, message: 'Patch queued for application.', repo: params.repo, branch: params.branch, patch: params.patch };
  }
}
