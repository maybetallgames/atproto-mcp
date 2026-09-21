import { beforeEach, describe, expect, it, vi } from 'vitest';
import { GithubApplyPatchTool } from '../tools/implementations/github-coding-tools.js';
import { GithubCommitChangesTool } from '../tools/implementations/github-commit-tools.js';

describe('GitHub patch workflow', () => {
  const request = vi.fn();
  const github = { request };

  beforeEach(() => request.mockReset());

  it('prepares a changed tree without creating or advancing a commit', async () => {
    request
      .mockResolvedValueOnce({ commit: { sha: 'parent', commit: { tree: { sha: 'base-tree' } } } })
      .mockResolvedValueOnce({ type: 'file', content: Buffer.from('old').toString('base64') })
      .mockResolvedValueOnce({ sha: 'blob' })
      .mockResolvedValueOnce({ sha: 'changed-tree' });

    const result = await new GithubApplyPatchTool(github).handler({
      repo: 'owner/repo',
      branch: 'fix/test',
      patch:
        'diff --git a/file.txt b/file.txt\n--- a/file.txt\n+++ b/file.txt\n@@ -1 +1 @@\n-old\n+new',
      message: 'Fix file',
    });

    expect(result).toMatchObject({
      prepared: true,
      treeSha: 'changed-tree',
      parentSha: 'parent',
      files: ['file.txt'],
    });
    expect(request.mock.calls.some(([path]) => path.endsWith('/git/commits'))).toBe(false);
    expect(request.mock.calls.some(([, options]) => options?.method === 'PATCH')).toBe(false);
  });

  it('refuses to create a commit whose tree matches its parent', async () => {
    request.mockResolvedValueOnce({ tree: { sha: 'same-tree' } });

    await expect(
      new GithubCommitChangesTool(github).handler({
        repo: 'owner/repo',
        branch: 'fix/test',
        message: 'No-op',
        treeSha: 'same-tree',
        parentSha: 'parent',
      })
    ).rejects.toThrow('refusing to create an empty commit');
    expect(request).toHaveBeenCalledTimes(1);
  });
});
