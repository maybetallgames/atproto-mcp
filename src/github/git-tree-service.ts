import type { GitHubAppClient } from './github-client.js';

export interface IGitTreeFile {
  path: string;
  content: string;
}

export interface IGitTreeEntry {
  path: string;
  mode: '100644';
  type: 'blob';
  sha: string | null;
}

export class GitTreeService {
  constructor(
    private readonly github: GitHubAppClient,
    private readonly repo?: string
  ) {}

  async createBlob(repo: string, content: string): Promise<{ sha: string }> {
    return this.github.request(`/repos/${repo}/git/blobs`, {
      method: 'POST',
      body: JSON.stringify({ content, encoding: 'utf-8' }),
    });
  }

  async createCommitFromTree(params: {
    repo: string;
    branch: string;
    message: string;
    treeEntries: IGitTreeEntry[];
    parentSha: string;
  }) {
    const parent = await this.github.request(
      `/repos/${params.repo}/git/commits/${params.parentSha}`
    );
    const tree = await this.github.request(`/repos/${params.repo}/git/trees`, {
      method: 'POST',
      body: JSON.stringify({
        base_tree: parent.tree.sha,
        tree: params.treeEntries,
      }),
    });
    const commit = await this.github.request(`/repos/${params.repo}/git/commits`, {
      method: 'POST',
      body: JSON.stringify({
        message: params.message,
        tree: tree.sha,
        parents: [params.parentSha],
      }),
    });

    await this.github.request(
      `/repos/${params.repo}/git/refs/heads/${encodeURIComponent(params.branch)}`,
      {
        method: 'PATCH',
        body: JSON.stringify({ sha: commit.sha }),
      }
    );
    return commit;
  }

  async createCommitFromFiles(branch: string, files: IGitTreeFile[], message: string) {
    if (!this.repo) throw new Error('Repository is required');
    const branchInfo = await this.github.request(
      `/repos/${this.repo}/branches/${encodeURIComponent(branch)}`
    );

    const parentSha = branchInfo.commit.sha;
    const baseTreeSha = branchInfo.commit.commit.tree.sha;

    const blobs = await Promise.all(
      files.map(async file => {
        const blob = await this.github.request(`/repos/${this.repo}/git/blobs`, {
          method: 'POST',
          body: JSON.stringify({
            content: file.content,
            encoding: 'utf-8',
          }),
        });

        return {
          path: file.path,
          mode: '100644',
          type: 'blob',
          sha: blob.sha,
        };
      })
    );

    const tree = await this.github.request(`/repos/${this.repo}/git/trees`, {
      method: 'POST',
      body: JSON.stringify({
        base_tree: baseTreeSha,
        tree: blobs,
      }),
    });

    const commit = await this.github.request(`/repos/${this.repo}/git/commits`, {
      method: 'POST',
      body: JSON.stringify({
        message,
        tree: tree.sha,
        parents: [parentSha],
      }),
    });

    await this.github.request(`/repos/${this.repo}/git/refs/heads/${encodeURIComponent(branch)}`, {
      method: 'PATCH',
      body: JSON.stringify({
        sha: commit.sha,
      }),
    });

    return commit;
  }
}
