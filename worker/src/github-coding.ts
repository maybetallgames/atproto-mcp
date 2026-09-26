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

const integerArg = (
  args: Obj,
  key: string,
  fallback: number,
  minimum: number,
  maximum: number
): number => {
  const value = args[key];
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.max(minimum, Math.min(maximum, Math.trunc(value)));
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
  const headers = new Headers(init.headers);
  headers.set('Authorization', `Bearer ${await installationToken(env)}`);
  if (!headers.has('Accept')) headers.set('Accept', 'application/vnd.github+json');
  headers.set('Content-Type', 'application/json');
  headers.set('User-Agent', 'Bluesky-Community-Manager');
  const response = await fetch(`https://api.github.com${path}`, {
    ...init,
    headers,
  });
  if (!response.ok)
    throw new Error(`GitHub API failed (${response.status}): ${await response.text()}`);
  return response.status === 204 ? ({} as T) : (response.json() as Promise<T>);
}

function parsePatch(diff: string): FilePatch[] {
  const chunks = /^diff --git /m.test(diff) ? diff.split(/^diff --git /gm).filter(Boolean) : [diff];
  return chunks.flatMap(chunk => {
    const lines = chunk.split('\n');
    const oldHeader = lines.find(line => line.startsWith('--- '));
    const newHeader = lines.find(line => line.startsWith('+++ '));
    if (!oldHeader || !newHeader) return [];
    const oldRaw = oldHeader.slice(3).trim().split('\t', 1)[0] ?? '';
    const newRaw = newHeader.slice(3).trim().split('\t', 1)[0] ?? '';
    const oldPath = oldRaw === '/dev/null' ? oldRaw : oldRaw.replace(/^a\//, '');
    const newPath = newRaw === '/dev/null' ? newRaw : newRaw.replace(/^b\//, '');
    const hunks: Hunk[] = [];
    let current: Hunk | undefined;
    for (const line of lines) {
      const match = line.match(/^@@ -(\d+),?\d* \+\d+,?\d* @@/);
      if (match) {
        current = { oldStart: Number(match[1]), lines: [] };
        hunks.push(current);
      } else if (current && /^[ +\-]/.test(line)) current.lines.push(line);
    }
    if (hunks.length === 0)
      throw new Error(
        `Patch for ${newPath === '/dev/null' ? oldPath : newPath} has no valid hunks`
      );
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

async function readFile(
  env: Env,
  repo: string,
  path: string,
  ref: string
): Promise<{ path: string; sha: string; size: number; content: string }> {
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

export async function githubGetFile(env: Env, args: Obj) {
  const repo = repoName(args);
  const path = required(args, 'path');
  const ref = required(args, 'ref');
  const file = await readFile(env, repo, path, ref);
  const lines = file.content.split('\n');
  const knownSha = typeof args.knownSha === 'string' ? args.knownSha : undefined;
  if (knownSha && knownSha === file.sha) {
    return {
      path: file.path,
      sha: file.sha,
      size: file.size,
      totalLines: lines.length,
      unchanged: true,
      truncated: false,
    };
  }
  const startLine = integerArg(args, 'startLine', 1, 1, Math.max(1, lines.length));
  const endLine = integerArg(args, 'endLine', lines.length, startLine, lines.length);
  const maxChars = integerArg(args, 'maxChars', 12000, 1000, 100000);
  const ranged = lines.slice(startLine - 1, endLine).join('\n');
  const content = ranged.slice(0, maxChars);
  return {
    path: file.path,
    sha: file.sha,
    size: file.size,
    unchanged: false,
    startLine,
    endLine,
    totalLines: lines.length,
    truncated: startLine > 1 || endLine < lines.length || content.length < ranged.length,
    content,
  };
}

export async function githubFindInFile(env: Env, args: Obj) {
  const repo = repoName(args);
  const path = required(args, 'path');
  const ref = required(args, 'ref');
  const query = required(args, 'query');
  const contextLines = integerArg(args, 'contextLines', 20, 0, 100);
  const maxMatches = integerArg(args, 'maxMatches', 10, 1, 50);
  const maxChars = integerArg(args, 'maxChars', 12000, 1000, 50000);
  const caseSensitive = args.caseSensitive === true;
  const file = await readFile(env, repo, path, ref);
  const lines = file.content.split('\n');
  const knownSha = typeof args.knownSha === 'string' ? args.knownSha : undefined;
  if (knownSha && knownSha === file.sha) {
    return {
      path: file.path,
      sha: file.sha,
      query,
      totalLines: lines.length,
      matchCount: 0,
      truncated: false,
      unchanged: true,
      matches: [],
    };
  }
  const needle = caseSensitive ? query : query.toLowerCase();
  const matches: Array<{ line: number; startLine: number; endLine: number; snippet: string }> = [];
  let used = 0;
  for (let index = 0; index < lines.length && matches.length < maxMatches; index++) {
    const haystack = caseSensitive ? lines[index]! : lines[index]!.toLowerCase();
    if (!haystack.includes(needle)) continue;
    const startLine = Math.max(1, index + 1 - contextLines);
    const endLine = Math.min(lines.length, index + 1 + contextLines);
    let snippet = lines.slice(startLine - 1, endLine).join('\n');
    const remaining = maxChars - used;
    if (remaining <= 0) break;
    snippet = snippet.slice(0, remaining);
    used += snippet.length;
    matches.push({ line: index + 1, startLine, endLine, snippet });
  }
  return {
    path: file.path,
    sha: file.sha,
    query,
    totalLines: lines.length,
    matchCount: matches.length,
    truncated: matches.length >= maxMatches || used >= maxChars,
    unchanged: false,
    matches,
  };
}

export async function githubSearchCode(env: Env, args: Obj) {
  const repo = repoName(args);
  const query = required(args, 'query');
  const limit = integerArg(args, 'limit', 10, 1, 25);
  const maxChars = integerArg(args, 'maxChars', 12000, 1000, 50000);
  const prefixes = Array.isArray(args.paths)
    ? args.paths.filter((value): value is string => typeof value === 'string' && value.length > 0)
    : [];
  const q = `${query} repo:${repo}`;
  const response = await github<{
    total_count: number;
    incomplete_results: boolean;
    items: Array<{
      path: string;
      sha: string;
      text_matches?: Array<{ fragment?: string }>;
    }>;
  }>(env, `/search/code?q=${encodeURIComponent(q)}&per_page=${Math.min(100, limit * 4)}`, {
    headers: { Accept: 'application/vnd.github.text-match+json' },
  });
  let used = 0;
  const results = response.items
    .filter(item => !prefixes.length || prefixes.some(prefix => item.path.startsWith(prefix)))
    .slice(0, limit)
    .map(item => {
      const fragment = item.text_matches?.map(match => match.fragment ?? '').join('\n') ?? '';
      const remaining = Math.max(0, maxChars - used);
      const snippet = fragment.slice(0, remaining);
      used += snippet.length;
      return { path: item.path, sha: item.sha, snippet };
    });
  return {
    query,
    totalCount: response.total_count,
    incomplete: response.incomplete_results,
    resultCount: results.length,
    truncated: results.length >= limit || used >= maxChars,
    results,
  };
}

export async function githubGetDiff(env: Env, args: Obj) {
  const repo = repoName(args);
  const base = required(args, 'base');
  const head = required(args, 'head');
  const mode = args.mode === 'patch' ? 'patch' : 'summary';
  const maxChars = integerArg(args, 'maxChars', 20000, 1000, 100000);
  const raw = await github<{
    status?: string;
    ahead_by?: number;
    behind_by?: number;
    total_commits?: number;
    files?: Array<{
      filename: string;
      status?: string;
      additions?: number;
      deletions?: number;
      changes?: number;
      patch?: string;
    }>;
  }>(
    env,
    `/repos/${repo}/compare/${encodeURIComponent(base)}...${encodeURIComponent(head)}`
  );
  let remaining = maxChars;
  const files = (raw.files ?? []).map(file => {
    let patch: string | undefined;
    if (mode === 'patch' && typeof file.patch === 'string' && remaining > 0) {
      patch = file.patch.slice(0, remaining);
      remaining -= patch.length;
    }
    return {
      path: file.filename,
      status: file.status ?? '',
      additions: file.additions ?? 0,
      deletions: file.deletions ?? 0,
      changes: file.changes ?? 0,
      ...(patch ? { patch } : {}),
    };
  });
  return {
    status: raw.status ?? '',
    aheadBy: raw.ahead_by ?? 0,
    behindBy: raw.behind_by ?? 0,
    totalCommits: raw.total_commits ?? 0,
    filesChanged: files.length,
    additions: files.reduce((sum, file) => sum + file.additions, 0),
    deletions: files.reduce((sum, file) => sum + file.deletions, 0),
    mode,
    truncated: mode === 'patch' && remaining <= 0,
    files,
  };
}

export async function githubGetBranchStatus(env: Env, args: Obj) {
  const branch = await github<{ name: string; protected?: boolean; commit: { sha: string } }>(
    env,
    `/repos/${repoName(args)}/branches/${encodeURIComponent(required(args, 'branch'))}`
  );
  return { name: branch.name, sha: branch.commit.sha, protected: Boolean(branch.protected) };
}

export async function githubCreateBranch(env: Env, args: Obj) {
  const branch = required(args, 'branch');
  const sha = required(args, 'sha');
  await github(env, `/repos/${repoName(args)}/git/refs`, {
    method: 'POST',
    body: JSON.stringify({ ref: `refs/heads/${branch}`, sha }),
  });
  return { created: true, branch, sha };
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
  return { sha: commit.sha, branch };
}
export async function githubCreatePullRequest(env: Env, args: Obj) {
  const repo = repoName(args);
  const pull = await github<{
    number: number;
    title: string;
    state: string;
    html_url: string;
    head?: { ref?: string; sha?: string };
    base?: { ref?: string };
  }>(env, `/repos/${repo}/pulls`, {
    method: 'POST',
    body: JSON.stringify({
      head: required(args, 'head'),
      base: required(args, 'base'),
      title: required(args, 'title'),
      body: required(args, 'body'),
    }),
  });
  return {
    number: pull.number,
    title: pull.title,
    state: pull.state,
    url: pull.html_url,
    head: pull.head?.ref ?? '',
    headSha: pull.head?.sha ?? '',
    base: pull.base?.ref ?? '',
  };
}

export async function githubMergePullRequest(env: Env, args: Obj) {
  const repo = repoName(args);
  const pullNumber = args.pullNumber;
  if (!Number.isInteger(pullNumber) || (pullNumber as number) < 1)
    throw new Error('pullNumber must be a positive integer');
  const expectedHeadSha = required(args, 'expectedHeadSha');
  if (!/^[a-f0-9]{40}$/i.test(expectedHeadSha))
    throw new Error('expectedHeadSha must be a full 40-character commit SHA');
  const mergeMethod = args.mergeMethod ?? 'squash';
  if (!['merge', 'squash', 'rebase'].includes(String(mergeMethod)))
    throw new Error('mergeMethod must be merge, squash, or rebase');
  const result = await github<{ merged?: boolean; message?: string; sha?: string }>(
    env,
    `/repos/${repo}/pulls/${pullNumber as number}/merge`,
    {
      method: 'PUT',
      body: JSON.stringify({
        sha: expectedHeadSha,
        merge_method: mergeMethod,
        ...(typeof args.commitTitle === 'string' ? { commit_title: args.commitTitle } : {}),
        ...(typeof args.commitMessage === 'string' ? { commit_message: args.commitMessage } : {}),
      }),
    }
  );
  return {
    merged: Boolean(result.merged),
    message: result.message ?? '',
    sha: result.sha ?? '',
    pullNumber,
  };
}

export async function githubSubmitPatchWorkflow(env: Env, args: Obj) {
  const repo = repoName(args);
  const base = required(args, 'base');
  const branch = required(args, 'branch');
  const baseStatus = await githubGetBranchStatus(env, { repo, branch: base });
  await githubCreateBranch(env, { repo, branch, sha: baseStatus.sha });
  const prepared = await githubApplyPatch(env, {
    repo,
    branch,
    patch: required(args, 'patch'),
    message: required(args, 'commitMessage'),
  });
  const validation = await githubValidateChange(env, {
    files: prepared.files,
    allowedFiles: Array.isArray(args.allowedFiles) ? args.allowedFiles : [],
    maxFiles: typeof args.maxFiles === 'number' ? args.maxFiles : undefined,
  });
  if (!validation.valid)
    throw new Error(
      `Change validation failed: ${validation.invalidFiles.join(', ') || 'too many files'}`
    );
  const commit = await githubCommitChanges(env, {
    repo,
    branch,
    message: required(args, 'commitMessage'),
    treeSha: prepared.treeSha,
    parentSha: prepared.parentSha,
  });
  const pullRequest = await githubCreatePullRequest(env, {
    repo,
    head: branch,
    base,
    title: required(args, 'prTitle'),
    body: required(args, 'prBody'),
  });
  return {
    success: true,
    branch,
    commitSha: commit.sha,
    files: prepared.files,
    pullRequest,
  };
}

export async function githubUpdatePatchWorkflow(env: Env, args: Obj) {
  const repo = repoName(args);
  const branch = required(args, 'branch');
  const prepared = await githubApplyPatch(env, {
    repo,
    branch,
    patch: required(args, 'patch'),
    message: required(args, 'commitMessage'),
  });
  const validation = await githubValidateChange(env, {
    files: prepared.files,
    allowedFiles: Array.isArray(args.allowedFiles) ? args.allowedFiles : [],
    maxFiles: typeof args.maxFiles === 'number' ? args.maxFiles : undefined,
  });
  if (!validation.valid)
    throw new Error(
      `Change validation failed: ${validation.invalidFiles.join(', ') || 'too many files'}`
    );
  const commit = await githubCommitChanges(env, {
    repo,
    branch,
    message: required(args, 'commitMessage'),
    treeSha: prepared.treeSha,
    parentSha: prepared.parentSha,
  });
  return {
    success: true,
    branch,
    previousHeadSha: prepared.parentSha,
    commitSha: commit.sha,
    files: prepared.files,
  };
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
      'commit_changes',
      'create_pull_request',
    ],
  };
}
