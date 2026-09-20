export type Env = {
  GITHUB_APP_ID: string;
  GITHUB_PRIVATE_KEY: string;
  GITHUB_INSTALLATION_ID: string;
  STATE: { get(k: string): Promise<string | null>; put(k: string, v: string): Promise<void> };
};
type Commit = {
  sha: string;
  commit: { message: string; committer?: { date: string } };
  files?: { filename: string }[];
};
type Pull = {
  number: number;
  title: string;
  merged_at: string | null;
  merge_commit_sha: string | null;
};
type State = {
  lastPostedCommit: string;
  lastPostedAt: string;
  posts: { uri: string; commitReferences: string[] }[];
};
const KEY = 'devlog:checkpoint';
const encode = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replaceAll('=', '');
async function token(env: Env): Promise<string> {
  if (!env.GITHUB_APP_ID || !env.GITHUB_PRIVATE_KEY || !env.GITHUB_INSTALLATION_ID)
    throw new Error('GitHub App secrets missing');
  const now = Math.floor(Date.now() / 1000),
    utf = new TextEncoder();
  const header = encode(utf.encode(JSON.stringify({ alg: 'RS256', typ: 'JWT' })));
  const payload = encode(
    utf.encode(JSON.stringify({ iat: now - 60, exp: now + 540, iss: env.GITHUB_APP_ID }))
  );
  const pem = env.GITHUB_PRIVATE_KEY.replace(/\\n/g, '\n').replace(
    /-----BEGIN PRIVATE KEY-----|-----END PRIVATE KEY-----|\s/g,
    ''
  );
  const key = await crypto.subtle.importKey(
    'pkcs8',
    Uint8Array.from(atob(pem), c => c.charCodeAt(0)),
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const jwt = `${header}.${payload}.${encode(new Uint8Array(await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, utf.encode(`${header}.${payload}`))))}`;
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
export async function state(env: Env): Promise<State> {
  const raw = await env.STATE.get(KEY);
  return raw ? (JSON.parse(raw) as State) : { lastPostedCommit: '', lastPostedAt: '', posts: [] };
}
export async function commits(env: Env, since?: string): Promise<Commit[]> {
  const date = since ?? (await state(env)).lastPostedAt;
  if (date && !Number.isFinite(Date.parse(date))) throw new Error('Invalid since date');
  return get<Commit[]>(
    env,
    `commits?per_page=100${date ? `&since=${encodeURIComponent(date)}` : ''}`
  );
}
export async function details(env: Env, sha: string): Promise<Commit> {
  if (!/^[a-f0-9]{40}$/i.test(sha)) throw new Error('Invalid commit SHA');
  return get<Commit>(env, `commits/${sha}`);
}
export async function prs(env: Env, since?: string): Promise<Pull[]> {
  const date = since ?? (await state(env)).lastPostedAt;
  if (date && !Number.isFinite(Date.parse(date))) throw new Error('Invalid since date');
  return (
    await get<Pull[]>(env, 'pulls?state=closed&sort=updated&direction=desc&per_page=100')
  ).filter(p => p.merged_at && (!date || Date.parse(p.merged_at) > Date.parse(date)));
}
const noise =
  /(^|\/)(package(-lock)?\.json|pnpm-lock\.yaml|yarn\.lock|dist|build|node_modules)(\/|$)|\.(meta|lock|snap)$|\.generated\./i;
const priority =
  /gameplay|combat|damage|weapon|rocket|projectile|enemy|\bai\b|navigation|procedural|generator|visual|effect|animation|level|terrain|\bfix\b|bug/i;
export async function devlog(env: Env) {
  const saved = await state(env);
  const [recent, merged] = await Promise.all([commits(env), prs(env)]);
  const posted = new Set(saved.posts.flatMap(p => p.commitReferences));
  const unseen = recent.filter(c => c.sha !== saved.lastPostedCommit && !posted.has(c.sha));
  const full = await Promise.all(unseen.slice(0, 30).map(c => details(env, c.sha)));
  const relevant = full.filter(
    c =>
      !/^\s*(chore\(?(deps|format)|style|format|deps)[:)]/i.test(c.commit.message) &&
      (c.files ?? []).some(
        f => !noise.test(f.filename) && !/\.(md|txt|json|ya?ml)$/i.test(f.filename)
      )
  );
  relevant.sort(
    (a, b) => Number(priority.test(b.commit.message)) - Number(priority.test(a.commit.message))
  );
  const refs = relevant.map(c => c.sha);
  const lines = relevant.slice(0, 5).map(
    c =>
      `${c.sha.slice(0, 7)}: ${c.commit.message.split('\n')[0]} (${c.files
        ?.filter(f => !noise.test(f.filename))
        .map(f => f.filename)
        .slice(0, 4)
        .join(', ')})`
  );
  lines.push(
    ...merged
      .filter(p => p.merge_commit_sha && refs.includes(p.merge_commit_sha))
      .slice(0, 5)
      .map(p => `Merged PR #${p.number}: ${p.title}`)
  );
  return {
    shouldPost: relevant.length > 0,
    text: relevant[0]?.commit.message.split('\n')[0] ?? '',
    technicalSummary: lines.join('\n') || 'No new meaningful changes.',
    mediaNeeded: relevant.some(c => /visual|effect|animation|level|weapon/i.test(c.commit.message))
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
  const recent = await commits(env);
  const valid = new Set(recent.map(c => c.sha));
  if (!refs.length || refs.some(r => !valid.has(r)))
    throw new Error('Invalid or old commit references');
  const newest = recent.find(c => refs.includes(c.sha))!;
  const updated = {
    lastPostedCommit: newest.sha,
    lastPostedAt: newest.commit.committer?.date ?? new Date().toISOString(),
    posts: [...saved.posts, { uri, commitReferences: refs }].slice(-200),
  };
  await env.STATE.put(KEY, JSON.stringify(updated));
  return updated;
}
