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
    description: 'Apply a unified diff patch and commit the result to a branch.',
    params: z.object({ repo: z.string(), branch: z.string(), patch: z.string(), message: z.string().optional() }),
    outputSchema: { type: 'object', additionalProperties: true },
  };

  async handler(params: { repo: string; branch: string; patch: string; message?: string }) {
    const github = client();
    const files = parseUnifiedDiff(params.patch);
    const branch = await github.request(`/repos/${params.repo}/branches/${encodeURIComponent(params.branch)}`);

    const treeEntries = [];

    for (const file of files) {
      const current = await github.request(`/repos/${params.repo}/contents/${file.oldPath}?ref=${encodeURIComponent(params.branch)}`);
      const original = Buffer.from(current.content, 'base64').toString('utf8');
      const updated = applyUnifiedPatch(original, file.hunks);

      const blob = await github.request(`/repos/${params.repo}/git/blobs`, {
        method: 'POST',
        body: JSON.stringify({ content: updated, encoding: 'utf-8' }),
      });

      treeEntries.push({
        path: file.newPath,
        mode: '100644',
        type: 'blob',
        sha: blob.sha,
      });
    }

    const tree = await github.request(`/repos/${params.repo}/git/trees`, {
      method: 'POST',
      body: JSON.stringify({ tree: treeEntries }),
    });

    const commit = await github.request(`/repos/${params.repo}/git/commits`, {
      method: 'POST',
      body: JSON.stringify({
        message: params.message ?? 'Apply patch',
        tree: tree.sha,
        parents: [branch.commit.sha],
      }),
    });

    await github.request(`/repos/${params.repo}/git/refs/heads/${encodeURIComponent(params.branch)}`, {
      method: 'PATCH',
      body: JSON.stringify({ sha: commit.sha }),
    });

    return {
      accepted: true,
      commit: commit.sha,
      files: files.map((file) => file.newPath),
    };
  }
}
