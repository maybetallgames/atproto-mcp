import { z } from 'zod';
import { GitHubAppClient } from '../../github/github-client.js';
import type { IMcpTool } from '../index.js';

const repo = 'maybetallgames/LetsDive';

function client(): GitHubAppClient {
  return new GitHubAppClient({
    GITHUB_APP_ID: process.env['GITHUB_APP_ID'] ?? '',
    GITHUB_PRIVATE_KEY: process.env['GITHUB_PRIVATE_KEY'] ?? '',
    GITHUB_INSTALLATION_ID: process.env['GITHUB_INSTALLATION_ID'] ?? '',
  });
}

export class GithubGetRecentCommitsTool implements IMcpTool {
  schema = {
    method: 'github_get_recent_commits',
    description: 'Return recent Lets Dive commits after a timestamp checkpoint.',
    params: z.object({ since: z.string().describe('ISO timestamp to search after.') }),
    outputSchema: {
      type: 'object',
      properties: { result: { type: 'array', items: { type: 'object' } } },
      required: ['result'],
    },
  };

  async handler({ since }: { since: string }) {
    const commits = await client().request(
      `/repos/${repo}/commits?since=${encodeURIComponent(since)}`
    );
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
    params: z.object({ sha: z.string().describe('Full commit SHA to inspect.') }),
    outputSchema: { type: 'object', additionalProperties: true },
  };

  async handler({ sha }: { sha: string }) {
    return client().request(`/repos/${repo}/commits/${sha}`);
  }
}

export class GithubGetRecentPrsTool implements IMcpTool {
  schema = {
    method: 'github_get_recent_prs',
    description: 'Return recently merged pull requests.',
    params: z.object({ since: z.string().describe('ISO timestamp to search after.') }),
    outputSchema: {
      type: 'object',
      properties: { result: { type: 'array', items: { type: 'object' } } },
      required: ['result'],
    },
  };

  async handler({ since }: { since: string }) {
    const pulls = await client().request(
      `/repos/${repo}/pulls?state=closed&sort=updated&direction=desc&per_page=100`
    );
    return pulls.filter(
      (pull: any) => pull.merged_at && Date.parse(pull.merged_at) > Date.parse(since)
    );
  }
}

export class CreateDevlogUpdateTool implements IMcpTool {
  schema = {
    method: 'create_devlog_update',
    description: 'Return GitHub facts for a social post; does not publish or change a checkpoint.',
    params: z.object({
      checkpoint: z.string().datetime().describe('Last successfully posted ISO timestamp.'),
    }),
    outputSchema: {
      type: 'object',
      properties: {
        shouldPost: { type: 'boolean' },
        text: { type: 'string' },
        technicalSummary: { type: 'string' },
        mediaNeeded: { type: 'string' },
        commitReferences: { type: 'array', items: { type: 'string' } },
      },
      required: ['shouldPost', 'text', 'technicalSummary', 'mediaNeeded', 'commitReferences'],
    },
  };

  async handler({ checkpoint }: { checkpoint: string }) {
    const [commits, pulls] = await Promise.all([
      new GithubGetRecentCommitsTool().handler({ since: checkpoint }),
      new GithubGetRecentPrsTool().handler({ since: checkpoint }),
    ]);
    const merged = pulls.filter(
      (pull: any) => pull.merged_at && Date.parse(pull.merged_at) > Date.parse(checkpoint)
    );
    const detail = await Promise.all(
      commits
        .slice(0, 30)
        .map((commit: any) => new GithubGetCommitDetailsTool().handler({ sha: commit.sha }))
    );
    const noise =
      /(^|\/)(package(-lock)?\.json|pnpm-lock\.yaml|yarn\.lock|dist|build)(\/|$)|\.(meta|lock|snap)$|\.generated\./i;
    const relevant = detail.filter(
      (commit: any) =>
        !/^\s*(chore\(?(deps|format)|style|format|deps)[:)]/i.test(commit.commit.message) &&
        commit.files?.some(
          (file: any) =>
            !noise.test(file.filename) && !/\.(md|txt|json|ya?ml)$/i.test(file.filename)
        )
    );
    const priority =
      /gameplay|combat|damage|weapon|rocket|projectile|enemy|\bai\b|navigation|procedural|generator|visual|effect|animation|level|terrain|\bfix\b|bug/i;
    relevant.sort(
      (a: any, b: any) =>
        Number(priority.test(b.commit.message)) - Number(priority.test(a.commit.message))
    );
    const refs = relevant.map((commit: any) => commit.sha as string);
    const lines = relevant.slice(0, 5).map(
      (commit: any) =>
        `${commit.sha.slice(0, 7)}: ${commit.commit.message.split('\n')[0]} (${commit.files
          .filter((file: any) => !noise.test(file.filename))
          .map((file: any) => file.filename)
          .slice(0, 4)
          .join(', ')})`
    );
    lines.push(
      ...merged
        .filter((pull: any) => refs.includes(pull.merge_commit_sha))
        .slice(0, 5)
        .map((pull: any) => `Merged PR #${pull.number}: ${pull.title}`)
    );
    return {
      shouldPost: relevant.length > 0,
      text: relevant[0]?.commit.message.split('\n')[0] ?? '',
      technicalSummary: lines.join('\n') || 'No new meaningful changes.',
      mediaNeeded: relevant.some((commit: any) =>
        /visual|effect|animation|level|weapon/i.test(commit.commit.message)
      )
        ? 'Screenshot or gameplay clip if available.'
        : '',
      commitReferences: refs,
    };
  }
}
