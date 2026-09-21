import { z } from 'zod';
import { GitHubAppClient } from '../../github/github-client.js';
import { GitTreeService } from '../../github/git-tree-service.js';
import { applyUnifiedPatch, parseUnifiedDiff } from '../../github/patch-utils.js';
import type { IMcpTool } from '../index.js';

const client = () =>
  new GitHubAppClient({
    GITHUB_APP_ID: process.env['GITHUB_APP_ID'] ?? '',
    GITHUB_PRIVATE_KEY: process.env['GITHUB_PRIVATE_KEY'] ?? '',
    GITHUB_INSTALLATION_ID: process.env['GITHUB_INSTALLATION_ID'] ?? '',
  });

const encodeRepositoryPath = (path: string): string =>
  path.split('/').map(encodeURIComponent).join('/');

export class GithubGetFileTool implements IMcpTool {
  schema = {
    method: 'github_get_file',
    description: 'Read a UTF-8 text file from a GitHub repository at a branch, tag, or commit.',
    params: z.object({
      repo: z.string().describe('GitHub repository in owner/name form.'),
      path: z.string().min(1).describe('Repository-relative file path.'),
      ref: z.string().min(1).describe('Branch, tag, or commit SHA to read.'),
    }),
    outputSchema: { type: 'object', additionalProperties: true },
  };

  async handler(params: { repo: string; path: string; ref: string }) {
    const file = await client().request(
      `/repos/${params.repo}/contents/${encodeRepositoryPath(params.path)}?ref=${encodeURIComponent(params.ref)}`
    );
    if (file.type !== 'file' || file.encoding !== 'base64' || typeof file.content !== 'string') {
      throw new Error(`GitHub did not return readable file content for ${params.path}`);
    }
    return {
      path: file.path,
      sha: file.sha,
      size: file.size,
      content: Buffer.from(file.content, 'base64').toString('utf8'),
    };
  }
}

export class GithubGetDiffTool implements IMcpTool {
  schema = {
    method: 'github_get_diff',
    description: 'Compare a branch against a base branch and return changed files.',
    params: z.object({
      repo: z.string().describe('GitHub repository in owner/name form.'),
      base: z.string().describe('Base branch or commit.'),
      head: z.string().describe('Head branch or commit.'),
    }),
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
    params: z.object({
      repo: z.string().describe('GitHub repository in owner/name form.'),
      branch: z.string().describe('Branch name to inspect.'),
    }),
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
    params: z.object({
      repo: z.string().describe('GitHub repository in owner/name form.'),
      branch: z.string().describe('New branch name.'),
      sha: z.string().describe('Commit SHA at which to create the branch.'),
    }),
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
    description: 'Apply a unified diff patch and commit the result to a branch.',
    params: z.object({
      repo: z.string().describe('GitHub repository in owner/name form.'),
      branch: z.string().describe('Existing branch to update.'),
      patch: z.string().describe('Unified diff to apply.'),
      message: z.string().optional().describe('Commit message; defaults to Apply patch.'),
    }),
    outputSchema: { type: 'object', additionalProperties: true },
  };

  async handler(params: { repo: string; branch: string; patch: string; message?: string }) {
    const github = client();
    const gitTree = new GitTreeService(github);
    const files = parseUnifiedDiff(params.patch);
    if (files.length === 0) throw new Error('Patch does not contain any file changes');
    const branch = await github.request(
      `/repos/${params.repo}/branches/${encodeURIComponent(params.branch)}`
    );
    const treeEntries: Array<{ path: string; mode: '100644'; type: 'blob'; sha: string | null }> =
      [];

    for (const file of files) {
      if (file.isDeletedFile) {
        treeEntries.push({ path: file.oldPath, mode: '100644', type: 'blob', sha: null });
        continue;
      }

      let original = '';
      if (!file.isNewFile) {
        const current = await github.request(
          `/repos/${params.repo}/contents/${file.oldPath}?ref=${encodeURIComponent(params.branch)}`
        );
        original = Buffer.from(current.content, 'base64').toString('utf8');
      }

      const updated = applyUnifiedPatch(original, file.hunks);
      const blob = await gitTree.createBlob(params.repo, updated);

      treeEntries.push({
        path: file.newPath,
        mode: '100644',
        type: 'blob',
        sha: blob.sha,
      });

      if (!file.isNewFile && file.oldPath !== file.newPath) {
        treeEntries.push({ path: file.oldPath, mode: '100644', type: 'blob', sha: null });
      }
    }

    const commit = await gitTree.createCommitFromTree({
      repo: params.repo,
      branch: params.branch,
      message: params.message ?? 'Apply patch',
      treeEntries,
      parentSha: branch.commit.sha,
    });

    return {
      accepted: true,
      commit: commit.sha,
      files: files.map(file => (file.isDeletedFile ? file.oldPath : file.newPath)),
    };
  }
}
