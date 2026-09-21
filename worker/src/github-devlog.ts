import { createGitHubAppJwt } from './github-auth.js';

export type Env = {
  GITHUB_APP_ID: string;
  GITHUB_PRIVATE_KEY: string;
  GITHUB_INSTALLATION_ID: string;
  STATE: { get(k: string): Promise<string | null>; put(k: string, v: string): Promise<void> };
};

type RawCommitFile = {
  filename: string;
  status?: string;
  additions?: number;
  deletions?: number;
  changes?: number;
  patch?: string;
};
type RawCommit = {
  sha: string;
  commit: {
    message: string;
    author?: { name?: string; date?: string };
    committer?: { name?: string; date?: string };
  };
  author?: { login?: string } | null;
  files?: RawCommitFile[];
};
type Commit = {
  sha: string;
  message: string;
  date: string;
  author: string;
};
type CommitDetail = Commit & {
  files: Array<{
    filename: string;
    status: string;
    additions: number;
    deletions: number;
    changes: number;
    patch?: string;
  }>;
};
type RawPull = {
  number: number;
  title: string;
  merged_at: string | null;
  merge_commit_sha: string | null;
  head?: { ref?: string };
  base?: { ref?: string };
};
type Pull = {
  number: number;
  title: string;
  mergedAt: string;
  mergeCommitSha: string | null;
  head: string;
  base: string;
};
type State = {
  lastPostedCommit: string;
  lastPostedAt: string;
  posts: { uri: string; commitReferences: string[] }[];
};

const KEY = 'devlog:checkpoint';
const ACTIVITY_KEY = 'github:activity-checkpoint';

const clampLimit = (value: unknown, fallback = 10, max = 50): number => {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.max(1, Math.min(max, Math.trunc(value)));
};

async function token(env: Env): Promise<string> {
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
        'User-Agent': 'Bluesky-Bot-Devlog',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ permissions: { contents: 'read', pull_requests: 'read' } }),
    }
  );
  if (!response.ok) throw new Error(`GitHub App authentication failed (${response.status})`);
  return ((await response.json()) as { token: string }).token;
}

async function get<T>(env: Env, path: string): Promise<T> {
  const response = await fetch(`https://api.github.com/repos/maybetallgames/LetsDive/${path}`, {
    headers: {
      Authorization: `Bearer ${await token(env)}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'Bluesky-Bot-Devlog',
    },
  });
  if (!response.ok) throw new Error(`GitHub read failed (${response.status})`);
  return response.json() as Promise<T>;
}

const compactCommit = (commit: RawCommit): Commit => ({
  sha: commit.sha,
  message: commit.commit.message,
  date: commit.commit.committer?.date ?? commit.commit.author?.date ?? '',
  author: commit.author?.login ?? commit.commit.author?.name ?? '',
});

const compactPull = (pull: RawPull): Pull => ({
  number: pull.number,
  title: pull.title,
  mergedAt: pull.merged_at ?? '',
  mergeCommitSha: pull.merge_commit_sha,
  head: pull.head?.ref ?? '',
  base: pull.base?.ref ?? '',
});

export async function state(env: Env): Promise<State> {
  const raw = await env.STATE.get(KEY);
  return raw ? (JSON.parse(raw) as State) : { lastPostedCommit: '', lastPostedAt: '', posts: [] };
}

export async function commits(env: Env, since?: string, limit = 10): Promise<Commit[]> {
  const date = since ?? (await state(env)).lastPostedAt;
  if (date && !Number.isFinite(Date.parse(date))) throw new Error('Invalid since date');
  const pageSize = clampLimit(limit);
  const rows = await get<RawCommit[]>(
    env,
    `commits?per_page=${pageSize}${date ? `&since=${encodeURIComponent(date)}` : ''}`
  );
  return rows.slice(0, pageSize).map(compactCommit);
}

export async function details(
  env: Env,
  sha: string,
  includePatch = false,
  maxChars = 12000
): Promise<CommitDetail> {
  if (!/^[a-f0-9]{40}$/i.test(sha)) throw new Error('Invalid commit SHA');
  const raw = await get<RawCommit>(env, `commits/${sha}`);
  let remaining = Math.max(1000, Math.min(50000, Math.trunc(maxChars)));
  return {
    ...compactCommit(raw),
    files: (raw.files ?? []).map(file => {
      let patch: string | undefined;
      if (includePatch && typeof file.patch === 'string' && remaining > 0) {
        patch = file.patch.slice(0, remaining);
        remaining -= patch.length;
      }
      return {
        filename: file.filename,
        status: file.status ?? '',
        additions: file.additions ?? 0,
        deletions: file.deletions ?? 0,
        changes: file.changes ?? 0,
        ...(patch ? { patch } : {}),
      };
    }),
  };
}

export async function prs(env: Env, since?: string, limit = 10): Promise<Pull[]> {
  const date = since ?? (await state(env)).lastPostedAt;
  if (date && !Number.isFinite(Date.parse(date))) throw new Error('Invalid since date');
  const pageSize = clampLimit(limit);
  const rows = await get<RawPull[]>(
    env,
    `pulls?state=closed&sort=updated&direction=desc&per_page=${Math.min(100, Math.max(pageSize * 3, pageSize))}`
  );
  return rows
    .filter(p => p.merged_at && (!date || Date.parse(p.merged_at) > Date.parse(date)))
    .slice(0, pageSize)
    .map(compactPull);
}

export async function recentActivity(
  env: Env,
  args: { since?: string; limit?: number; advanceCheckpoint?: boolean }
) {
  const checkedAt = new Date().toISOString();
  const savedCheckpoint = await env.STATE.get(ACTIVITY_KEY);
  const fallback = (await state(env)).lastPostedAt;
  const since = (args.since ?? savedCheckpoint ?? fallback) || undefined;
  if (since && !Number.isFinite(Date.parse(since))) throw new Error('Invalid since date');
  const limit = clampLimit(args.limit);
  const [recentCommits, mergedPRs] = await Promise.all([
    commits(env, since, limit),
    prs(env, since, limit),
  ]);
  const mergeShas = new Set(
    mergedPRs.map(pr => pr.mergeCommitSha).filter((sha): sha is string => Boolean(sha))
  );
  const dedupedCommits = recentCommits.filter(commit => !mergeShas.has(commit.sha));
  if (args.advanceCheckpoint) await env.STATE.put(ACTIVITY_KEY, checkedAt);
  return {
    since: since ?? null,
    checkedAt,
    checkpointAdvanced: Boolean(args.advanceCheckpoint),
    counts: { commits: dedupedCommits.length, mergedPRs: mergedPRs.length },
    commits: dedupedCommits,
    mergedPRs,
  };
}

const noise =
  /(^|\/)(package(-lock)?\.json|pnpm-lock\.yaml|yarn\.lock|dist|build|node_modules)(\/|$)|\.(meta|lock|snap)$|\.generated\./i;
const priority =
  /gameplay|combat|damage|weapon|rocket|projectile|enemy|\bai\b|navigation|procedural|generator|visual|effect|animation|level|terrain|\bfix\b|bug/i;

export async function devlog(env: Env) {
  const saved = await state(env);
  const [recent, merged] = await Promise.all([commits(env, undefined, 30), prs(env, undefined, 30)]);
  const posted = new Set(saved.posts.flatMap(p => p.commitReferences));
  const unseen = recent.filter(c => c.sha !== saved.lastPostedCommit && !posted.has(c.sha));
  const full = await Promise.all(unseen.slice(0, 30).map(c => details(env, c.sha)));
  const relevant = full.filter(
    c =>
      !/^\s*(chore\(?(deps|format)|style|format|deps)[:)]/i.test(c.message) &&
      c.files.some(f => !noise.test(f.filename) && !/\.(md|txt|json|ya?ml)$/i.test(f.filename))
  );
  relevant.sort((a, b) => Number(priority.test(b.message)) - Number(priority.test(a.message)));
  const refs = relevant.map(c => c.sha);
  const lines = relevant.slice(0, 5).map(
    c =>
      `${c.sha.slice(0, 7)}: ${c.message.split('\n')[0]} (${c.files
        .filter(f => !noise.test(f.filename))
        .map(f => f.filename)
        .slice(0, 4)
        .join(', ')})`
  );
  lines.push(
    ...merged
      .filter(p => p.mergeCommitSha && refs.includes(p.mergeCommitSha))
      .slice(0, 5)
      .map(p => `Merged PR #${p.number}: ${p.title}`)
  );
  return {
    shouldPost: relevant.length > 0,
    text: relevant[0]?.message.split('\n')[0] ?? '',
    technicalSummary: lines.join('\n') || 'No new meaningful changes.',
    mediaNeeded: relevant.some(c => /visual|effect|animation|level|weapon/i.test(c.message))
      ? 'Screenshot or gameplay clip if available.'
      : '',
    commitReferences: refs,
  };
}

export async function record(env: Env, uri: string, refs: string[]): Promise<State> {
  if (!/^at:\/\/[^/]+\/app\.bsky\.feed\.post\/[^/]+$/.test(uri))
    throw new Error('Successful Bluesky post URI required');
  const saved = await state(env);
  if (saved.posts.some(p => p.uri === uri)) return saved;
  const recent = await commits(env, undefined, 50);
  const valid = new Set(recent.map(c => c.sha));
  if (!refs.length || refs.some(r => !valid.has(r)))
    throw new Error('Invalid or old commit references');
  const newest = recent.find(c => refs.includes(c.sha))!;
  const updated = {
    lastPostedCommit: newest.sha,
    lastPostedAt: newest.date || new Date().toISOString(),
    posts: [...saved.posts, { uri, commitReferences: refs }].slice(-200),
  };
  await env.STATE.put(KEY, JSON.stringify(updated));
  return updated;
}
