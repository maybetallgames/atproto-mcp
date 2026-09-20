import { z } from 'zod';
import type { IMcpTool } from '../index.js';

/**
 * Composite workflow metadata tool.
 * This provides a single entry point for clients that want to run the safe
 * fix workflow: inspect -> validate -> commit -> PR.
 * Individual operations remain separate tools so clients can review each step.
 */
export class GithubCreateFixWorkflowTool implements IMcpTool {
  schema = {
    method: 'github_create_fix_workflow',
    description: 'Describe a safe GitHub fix workflow request before executing branch, patch, validation, commit, and PR steps.',
    params: z.object({
      repo: z.string(),
      branch: z.string(),
      base: z.string(),
      summary: z.string(),
      allowedFiles: z.array(z.string()).optional(),
    }),
    outputSchema: { type: 'object', additionalProperties: true },
  };

  async handler(params: {
    repo: string;
    branch: string;
    base: string;
    summary: string;
    allowedFiles?: string[];
  }) {
    return {
      workflow: 'github_fix',
      status: 'ready',
      repo: params.repo,
      branch: params.branch,
      base: params.base,
      summary: params.summary,
      allowedFiles: params.allowedFiles ?? [],
      steps: [
        'inspect',
        'create_branch',
        'apply_patch',
        'review_diff',
        'validate_change',
        'commit',
        'create_pull_request',
      ],
    };
  }
}
