import { z } from 'zod';
import { GitHubAppClient } from '../../github/github-client.js';
import type { IMcpTool } from '../index.js';

const client = () => new GitHubAppClient({
  GITHUB_APP_ID: process.env['GITHUB_APP_ID'] ?? '',
  GITHUB_PRIVATE_KEY: process.env['GITHUB_PRIVATE_KEY'] ?? '',
  GITHUB_INSTALLATION_ID: process.env['GITHUB_INSTALLATION_ID'] ?? '',
});

export class GithubValidateChangeTool implements IMcpTool {
  schema = {
    method: 'github_validate_change',
    description: 'Validate a proposed change against allowed files and size limits.',
    params: z.object({
      files: z.array(z.string()),
      allowedFiles: z.array(z.string()).optional(),
      maxFiles: z.number().optional(),
    }),
    outputSchema: { type: 'object', additionalProperties: true },
  };

  async handler(params: { files: string[]; allowedFiles?: string[]; maxFiles?: number }) {
    const invalidFiles = (params.allowedFiles ?? []).length
      ? params.files.filter((file) => !params.allowedFiles?.includes(file))
      : [];

    return {
      valid: invalidFiles.length === 0 && (!params.maxFiles || params.files.length <= params.maxFiles),
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
      repo: z.string(),
      head: z.string(),
      base: z.string(),
      title: z.string(),
      body: z.string(),
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
