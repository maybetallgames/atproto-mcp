import { GitHubAppClient } from './github-client.js';

export interface GitTreeFile {
  path: string;
  content: string;
}

export class GitTreeService {
  constructor(
    private readonly github: GitHubAppClient,
    private readonly repo: string,
  ) {}

  async createCommitFromFiles(
    branch: string,
    files: GitTreeFile[],
    message: string,
  ) {
    const branchInfo = await this.github.request(
      `/repos/${this.repo}/branches/${encodeURIComponent(branch)}`
    );

    const parentSha = branchInfo.commit.sha;
    const baseTreeSha = branchInfo.commit.commit.tree.sha;

    const blobs = await Promise.all(
      files.map(async (file) => {
        const blob = await this.github.request(
          `/repos/${this.repo}/git/blobs`,
          {
            method: 'POST',
            body: JSON.stringify({
              content: file.content,
              encoding: 'utf-8',
            }),
          }
        );

        return {
          path: file.path,
          mode: '100644',
          type: 'blob',
          sha: blob.sha,
        };
      })
    );

    const tree = await this.github.request(
      `/repos/${this.repo}/git/trees`,
      {
        method: 'POST',
        body: JSON.stringify({
          base_tree: baseTreeSha,
          tree: blobs,
        }),
      }
    );

    const commit = await this.github.request(
      `/repos/${this.repo}/git/commits`,
      {
        method: 'POST',
        body: JSON.stringify({
          message,
          tree: tree.sha,
          parents: [parentSha],
        }),
      }
    );

    await this.github.request(
      `/repos/${this.repo}/git/refs/heads/${encodeURIComponent(branch)}`,
      {
        method: 'PATCH',
        body: JSON.stringify({
          sha: commit.sha,
        }),
      }
    );

    return commit;
  }
}
