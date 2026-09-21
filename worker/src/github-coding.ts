import { createGitHubAppJwt } from './github-auth.js';

type Obj = Record<string, unknown>;
type Env = {
  GITHUB_APP_ID: string;
  GITHUB_PRIVATE_KEY: string;
  GITHUB_INSTALLATION_ID: string;
};

type Hunk = { oldStart: number; lines: string[] };
type FilePatch = {
  oldPath: string;
  newPath: string;
  hunks: Hunk[];
  isNew: boolean;
  isDeleted: boolean;
};

const required = (args: Obj, key: string): string => {
  const value = args[key];
  if (typeof value !== 'string' || !value) throw new Error(`${key} must be a non-empty string`);
  return value;
};

const repoName = (args: Obj): string => {
  const repo = required(args, 'repo');
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) throw new Error('repo must be owner/name');
  return repo;
};

async function installationToken(env: Env): Promise<string> {
  if (!env.GITHUB_APP_ID || !env.GITHUB_PRIVATE_KEY || !env.GITHUB_INSTALLATION_ID)
    throw new Error('GitHub App secrets missing');
  const jwt = await createGitHubAppJwt(env);
  const response = await fetch(
    `https://api.github.com/app/installations/${env.GITHUB_INSTALLATION_ID}/access_tokens`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${jwt}`,
        Accept: 'application/vnd.github+json',
        'Content-Type': 'application/json',
        'User-Agent': 'Bluesky-Community-Manager',
      },
      body: JSON.stringify({ permissions: { contents: 'write', pull_requests: 'write' } }),
    }
  );
  if (!response.ok) throw new Error(`GitHub App authentication failed (${response.status})`);
  return ((await response.json()) as { token: string }).token;
}

async function github<T>(env: Env, path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`https://api.github.com${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${await installationToken(env)}`,
      Accept: 'application/vnd.github+json',
      'Content-Type': 'application/json',
      'User-Agent': 'Bluesky-Community-Manager',
    },
  });
  if (!response.ok)
    throw new Error(`GitHub API failed (${response.status}): ${await response.text()}`);
  return response.status === 204 ? ({} as T) : (response.json() as Promise<T>);
}

function parsePatch(diff: string): FilePatch[] {
  return diff
    .split(/^diff --git /gm)
    .filter(Boolean)
    .flatMap(chunk => {
      const lines = chunk.split('\n');
      const oldHeader = lines.find(line => line.startsWith('--- '));
      const newHeader = lines.find(line => line.startsWith('+++ '));
      if (!oldHeader || !newHeader) return [];
      const oldPath = oldHeader.includes('/dev/null')
        ? '/dev/null'
        : oldHeader.replace('--- a/', '').trim();
      const newPath = newHeader.includes('/dev/null')
        ? '/dev/null'
        : newHeader.replace('+++ b/', '').trim();
      const hunks: Hunk[] = [];
      let current: Hunk | undefined;
      for (const line of lines) {
        const match = line.match(/^@@ -(\d+),?\d* \+\d+,?\d* @@/);
        if (match) {
          current = { oldStart: Number(match[1]), lines: [] };
          hunks.push(current);
        } else if (current && /^[ +\-]/.test(line)) current.lines.push(line);
      }
      return [
        {
          oldPath,
          newPath,
          hunks,
          isNew: oldPath === '/dev/null',
          isDeleted: newPath === '/dev/null',
        },
      ];
    });
}

function applyPatch(original: string, hunks: Hunk[]): string {
  const source = original ? original.split('\n') : [],
    output: string[] = [];
  let index = 0;
  for (const hunk of hunks) {
    while (index < hunk.oldStart - 1) output.push(source[index++]!);
    for (const line of hunk.lines) {
      const content = line.slice(1);
      if (line[0] === ' ') {
        if (source[index] !== content)
          throw new Error(`Patch context mismatch at line ${index + 1}`);
        output.push(content);
        index++;
      } else if (line[0] === '-') {
        if (source[index] !== content)
          throw new Error(`Patch removal mismatch at line ${index + 1}`);
        index++;
      } else if (line[0] === '+') output.push(content);
    }
  }
  return output.concat(source.slice(index)).join('\n');
}

const contentPath = (path: string) => path.split('/').map(encodeURIComponent).join('/');

export async function githubGetFile(env: Env, args: Obj) {
  const repo = repoName(args);
  const path = required(args, 'path');
  const ref = required(args, 'ref');
  const file = await github<{
    type: string;
    path: string;
    sha: string;
    size: number;
    encoding?: string;
    content?: string;
  }>(env, `/repos/${repo}/contents/${contentPath(path)}?ref=${encodeURIComponent(ref)}`);
  if (file.type !== 'file' || file.encoding !== 'base64' || typeof file.content !== 'string') {
    throw new Error(`GitHub did not return readable file content for ${path}`);
  }
  const bytes = Uint8Array.from(atob(file.content.replace(/\s/g, '')), character =>
    character.charCodeAt(0)
  );
  return {
    path: file.path,
    sha: file.sha,
    size: file.size,
    content: new TextDecoder().decode(bytes),
  };
}

export async function githubGetDiff(env: Env, args: Obj) {
  return github(
    env,
    `/repos/${repoName(args)}/compare/${encodeURIComponent(required(args, 'base'))}...${encodeURIComponent(required(args, 'head'))}`
  );
}
export async function githubGetBranchStatus(env: Env, args: Obj) {
  return github(
    env,
    `/repos/${repoName(args)}/branches/${encodeURIComponent(required(args, 'branch'))}`
  );
}
export async function githubCreateBranch(env: Env, args: Obj) {
  return github(env, `/repos/${repoName(args)}/git/refs`, {
    method: 'POST',
    body: JSON.stringify({
      ref: `refs/heads/${required(args, 'branch')}`,
      sha: required(args, 'sha'),
    }),
  });
}
export async function githubApplyPatch(env: Env, args: Obj) {
  const repo = repoName(args),
    branchName = required(args, 'branch'),
    files = parsePatch(required(args, 'patch'));
  if (!files.length) throw new Error('Patch does not contain any file changes');
  const branch = await github<{ commit: { sha: string; commit: { tree: { sha: string } } } }>(
    env,
    `/repos/${repo}/branches/${encodeURIComponent(branchName)}`
  );
  const tree: Array<{ path: string; mode: string; type: string; sha: string | null }> = [];
  for (const file of files) {
    if (file.isDeleted) {
      tree.push({ path: file.oldPath, mode: '100644', type: 'blob', sha: null });
      continue;
    }
    let original = '';
    if (!file.isNew) {
      const current = await github<{ content: string }>(
        env,
        `/repos/${repo}/contents/${contentPath(file.oldPath)}?ref=${encodeURIComponent(branchName)}`
      );
      original = new TextDecoder().decode(
        Uint8Array.from(atob(current.content.replace(/\s/g, '')), c => c.charCodeAt(0))
      );
    }
    const content = applyPatch(original, file.hunks);
    const blob = await github<{ sha: string }>(env, `/repos/${repo}/git/blobs`, {
      method: 'POST',
      body: JSON.stringify({ content, encoding: 'utf-8' }),
    });
    tree.push({ path: file.newPath, mode: '100644', type: 'blob', sha: blob.sha });
    if (!file.isNew && file.oldPath !== file.newPath)
      tree.push({ path: file.oldPath, mode: '100644', type: 'blob', sha: null });
  }
  const madeTree = await github<{ sha: string }>(env, `/repos/${repo}/git/trees`, {
    method: 'POST',
    body: JSON.stringify({ base_tree: branch.commit.commit.tree.sha, tree }),
  });
  if (madeTree.sha === branch.commit.commit.tree.sha)
    throw new Error('Patch produced no file changes; refusing to create an empty commit');
  return {
    prepared: true,
    treeSha: madeTree.sha,
    parentSha: branch.commit.sha,
    message: typeof args.message === 'string' ? args.message : 'Apply patch',
    files: files.map(file => (file.isDeleted ? file.oldPath : file.newPath)),
  };
}
export async function githubValidateChange(_env: Env, args: Obj) {
  const files = Array.isArray(args.files)
    ? args.files.filter((x): x is string => typeof x === 'string')
    : [];
  const allowed = Array.isArray(args.allowedFiles)
    ? args.allowedFiles.filter((x): x is string => typeof x === 'string')
    : [];
  const invalidFiles = allowed.length ? files.filter(file => !allowed.includes(file)) : [];
  const maxFiles = typeof args.maxFiles === 'number' ? args.maxFiles : undefined;
  return {
    valid: invalidFiles.length === 0 && (maxFiles === undefined || files.length <= maxFiles),
    files,
    invalidFiles,
  };
}
export async function githubCommitChanges(env: Env, args: Obj) {
  const repo = repoName(args),
    branch = required(args, 'branch');
  const treeSha = required(args, 'treeSha');
  const parentSha = required(args, 'parentSha');
  const parent = await github<{ tree: { sha: string } }>(
    env,
    `/repos/${repo}/git/commits/${parentSha}`
  );
  if (parent.tree.sha === treeSha)
    throw new Error('Prepared tree matches the parent commit; refusing to create an empty commit');
  const commit = await github<{ sha: string }>(env, `/repos/${repo}/git/commits`, {
    method: 'POST',
    body: JSON.stringify({
      message: required(args, 'message'),
      tree: treeSha,
      parents: [parentSha],
    }),
  });
  await github(env, `/repos/${repo}/git/refs/heads/${encodeURIComponent(branch)}`, {
    method: 'PATCH',
    body: JSON.stringify({ sha: commit.sha }),
  });
  return commit;
}
export async function githubCreatePullRequest(env: Env, args: Obj) {
  const repo = repoName(args);
  return github(env, `/repos/${repo}/pulls`, {
    method: 'POST',
    body: JSON.stringify({
      head: required(args, 'head'),
      base: required(args, 'base'),
      title: required(args, 'title'),
      body: required(args, 'body'),
    }),
  });
}
export async function githubCreateFixWorkflow(_env: Env, args: Obj) {
  return {
    workflow: 'github_fix',
    status: 'ready',
    repo: repoName(args),
    branch: required(args, 'branch'),
    base: required(args, 'base'),
    summary: required(args, 'summary'),
    allowedFiles: Array.isArray(args.allowedFiles) ? args.allowedFiles : [],
    steps: [
      'inspect',
      'create_branch',
      'apply_patch',
      'review_diff',
      'validate_change',
      'create_pull_request',
    ],
  };
}
