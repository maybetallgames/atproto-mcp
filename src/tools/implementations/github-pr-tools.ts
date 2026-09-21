import { z } from 'zod';
import { GitHubAppClient } from '../../github/github-client.js';
import type { IMcpTool } from '../index.js';

const client = () =>
  new GitHubAppClient({
    GITHUB_APP_ID: process.env['GITHUB_APP_ID'] ?? '',
    GITHUB_PRIVATE_KEY: process.env['GITHUB_PRIVATE_KEY'] ?? '',
    GITHUB_INSTALLATION_ID: process.env['GITHUB_INSTALLATION_ID'] ?? '',
  });

export class GithubValidateChangeTool implements IMcpTool {
  schema = {
    method: 'github_validate_change',
    description: 'Validate a proposed change against allowed files and size limits.',
    params: z.object({
      files: z.array(z.string()).describe('Repository paths changed by the proposal.'),
      allowedFiles: z
        .array(z.string())
        .optional()
        .describe('Optional allowlist of repository paths.'),
      maxFiles: z.number().optional().describe('Maximum permitted number of changed files.'),
    }),
    outputSchema: { type: 'object', additionalProperties: true },
  };

  async handler(params: { files: string[]; allowedFiles?: string[]; maxFiles?: number }) {
    const invalidFiles = (params.allowedFiles ?? []).length
      ? params.files.filter(file => !params.allowedFiles?.includes(file))
      : [];

    return {
      valid:
        invalidFiles.length === 0 && (!params.maxFiles || params.files.length <= params.maxFiles),
      files: params.files,
      invalidFiles,
    };
  }
}

export class GithubCreatePullRequestTool implements IMcpTool {
  schema = {
    method: 'github_create_pull_request',
    description: 'Create a pull request for a completed coding workflow.',
    params: z.object({
      repo: z.string().describe('GitHub repository in owner/name form.'),
      head: z.string().describe('Pull request head branch.'),
      base: z.string().describe('Pull request base branch.'),
      title: z.string().describe('Pull request title.'),
      body: z.string().describe('Pull request description.'),
    }),
    outputSchema: { type: 'object', additionalProperties: true },
  };

  async handler(params: { repo: string; head: string; base: string; title: string; body: string }) {
    return client().request(`/repos/${params.repo}/pulls`, {
      method: 'POST',
      body: JSON.stringify(params),
    });
  }
}
