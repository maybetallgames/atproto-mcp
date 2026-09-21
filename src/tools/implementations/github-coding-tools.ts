import { z } from 'zod';
import { GitHubAppClient } from '../../github/github-client.js';
import { parseUnifiedDiff, applyUnifiedPatch } from '../../github/patch-utils.js';
import type { IMcpTool } from '../index.js';

const client = () => new GitHubAppClient({
  GITHUB_APP_ID: process.env['GITHUB_APP_ID'] ?? '',
  GITHUB_PRIVATE_KEY: process.env['GITHUB_PRIVATE_KEY'] ?? '',
  GITHUB_INSTALLATION_ID: process.env['GITHUB_INSTALLATION_ID'] ?? '',
});

export class GithubGetDiffTool implements IMcpTool {
  schema = { method: 'github_get_diff', description: 'Compare a branch against a base branch and return changed files.', params: z.object({ repo: z.string(), base: z.string(), head: z.string() }), outputSchema: { type: 'object', additionalProperties: true } };
  async handler(params: { repo: string; base: string; head: string }) {
    return client().request(`/repos/${params.repo}/compare/${params.base}...${params.head}`);
  }
}

export class GithubGetBranchStatusTool implements IMcpTool {
  schema = { method: 'github_get_branch_status', description: 'Return branch metadata for review workflows.', params: z.object({ repo: z.string(), branch: z.string() }), outputSchema: { type: 'object', additionalProperties: true } };
  async handler(params: { repo: string; branch: string }) {
    return client().request(`/repos/${params.repo}/branches/${encodeURIComponent(params.branch)}`);
  }
}

export class GithubCreateBranchTool implements IMcpTool {
  schema = { method: 'github_create_branch', description: 'Create a feature branch from an existing ref.', params: z.object({ repo: z.string(), branch: z.string(), sha: z.string() }), outputSchema: { type: 'object', additionalProperties: true } };
  async handler(params: { repo: string; branch: string; sha: string }) {
    return client().request(`/repos/${params.repo}/git/refs`, { method: 'POST', body: JSON.stringify({ ref: `refs/heads/${params.branch}`, sha: params.sha }) });
  }
}

export class GithubApplyPatchTool implements IMcpTool {
  schema = {
    method: 'github_apply_patch',
    description: 'Parse and prepare a unified diff patch for repository application.',
    params: z.object({ repo: z.string(), branch: z.string(), patch: z.string(), content: z.record(z.string()).optional() }),
    outputSchema: { type: 'object', additionalProperties: true },
  };

  async handler(params: { repo: string; branch: string; patch: string; content?: Record<string, string> }) {
    const files = parseUnifiedDiff(params.patch);

    const updatedFiles = files.map((file) => ({
      path: file.newPath,
      content: params.content?.[file.oldPath]
        ? applyUnifiedPatch(params.content[file.oldPath], file.hunks)
        : null,
    }));

    return {
      accepted: true,
      message: 'Patch parsed successfully. File application requires commit tree creation.',
      repo: params.repo,
      branch: params.branch,
      files: updatedFiles,
    };
  }
}
