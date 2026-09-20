const CHECKPOINT_KEY = "community-manager:last-checked-at";
const REASONS = new Set(["like", "follow", "reply", "mention", "quote", "repost"]);
type Obj = Record<string, unknown>;
type Session = { accessJwt: string; did: string };

const tools = [
  { name: "get_community_activity", description: "Get new Bluesky likes, followers, replies, mentions, quotes, and reposts. Uses a saved checkpoint when since is omitted. Set advanceCheckpoint only after successfully processing the response.", inputSchema: { type: "object", properties: { since: { type: "string", format: "date-time" }, limit: { type: "integer", minimum: 1, maximum: 100, default: 100 }, advanceCheckpoint: { type: "boolean", default: false } }, additionalProperties: false }, annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true } },
  { name: "get_post_context", description: "Read a Bluesky post and its surrounding thread before deciding whether or how to reply.", inputSchema: { type: "object", properties: { uri: { type: "string", pattern: "^at://" }, depth: { type: "integer", minimum: 0, maximum: 20, default: 6 }, parentHeight: { type: "integer", minimum: 0, maximum: 100, default: 20 } }, required: ["uri"], additionalProperties: false }, annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true } },
  { name: "reply_to_post", description: "Publish a Bluesky reply. During rollout, only use for a comment or mention on this account's own post after inspecting the thread. confirm must be true.", inputSchema: { type: "object", properties: { text: { type: "string", minLength: 1, maxLength: 3000 }, root: { type: "string", pattern: "^at://" }, parent: { type: "string", pattern: "^at://" }, langs: { type: "array", items: { type: "string" } }, confirm: { const: true } }, required: ["text", "root", "parent", "confirm"], additionalProperties: false }, annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true } }
];

function json(data: unknown, status = 200, headers: HeadersInit = {}): Response { return Response.json(data, { status, headers }); }
function rpc(id: unknown, result: unknown): Response { return json({ jsonrpc: "2.0", id, result }); }
function result(value: unknown): Obj { return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }], structuredContent: value }; }
function required(args: Obj, key: string): string { const value = args[key]; if (typeof value !== "string" || !value) throw new Error(`${key} must be a non-empty string`); return value; }

async function xrpc<T>(env: Env, path: string, options: { method?: "GET" | "POST"; session?: Session; query?: URLSearchParams; body?: unknown } = {}): Promise<T> {
  const url = new URL(`/xrpc/${path}`, env.ATPROTO_SERVICE || "https://bsky.social");
  if (options.query) url.search = options.query.toString();
  const response = await fetch(url, { method: options.method ?? "GET", headers: { ...(options.session ? { Authorization: `Bearer ${options.session.accessJwt}` } : {}), ...(options.body === undefined ? {} : { "Content-Type": "application/json" }) }, body: options.body === undefined ? undefined : JSON.stringify(options.body) });
  if (!response.ok) throw new Error(`Bluesky API ${path} failed (${response.status}): ${await response.text()}`);
  return (await response.json()) as T;
}

async function session(env: Env): Promise<Session> { return xrpc(env, "com.atproto.server.createSession", { method: "POST", body: { identifier: env.ATPROTO_IDENTIFIER, password: env.ATPROTO_PASSWORD } }); }
function postParts(uri: string): { repo: string; collection: string; rkey: string } { const match = /^at:\/\/([^/]+)\/(app\.bsky\.feed\.post)\/([^/]+)$/.exec(uri); if (!match?.[1] || !match[2] || !match[3]) throw new Error("Expected an app.bsky.feed.post AT-URI"); return { repo: match[1], collection: match[2], rkey: match[3] }; }
async function cid(env: Env, auth: Session, uri: string): Promise<string> { const record = await xrpc<{ cid?: string }>(env, "com.atproto.repo.getRecord", { session: auth, query: new URLSearchParams(postParts(uri)) }); if (!record.cid) throw new Error(`Could not resolve CID for ${uri}`); return record.cid; }

async function activity(env: Env, args: Obj): Promise<Obj> {
  const since = typeof args.since === "string" ? args.since : (await env.STATE.get(CHECKPOINT_KEY)) ?? undefined;
  const limit = typeof args.limit === "number" ? Math.max(1, Math.min(100, Math.trunc(args.limit))) : 100;
  const auth = await session(env); const query = new URLSearchParams({ limit: String(limit) }); if (since) query.set("seenAt", since);
  const response = await xrpc<{ notifications: Obj[]; cursor?: string }>(env, "app.bsky.notification.listNotifications", { session: auth, query });
  const checkedAt = new Date().toISOString();
  const items = response.notifications.filter(item => typeof item.reason === "string" && REASONS.has(item.reason)).filter(item => !since || (typeof item.indexedAt === "string" && Date.parse(item.indexedAt) > Date.parse(since))).map(item => ({ id: `${String(item.uri)}:${String(item.cid)}:${String(item.reason)}`, kind: item.reason, uri: item.uri, cid: item.cid, indexedAt: item.indexedAt, isRead: item.isRead, author: item.author, record: item.record }));
  if (args.advanceCheckpoint === true) await env.STATE.put(CHECKPOINT_KEY, checkedAt);
  return { success: true, checkedAt, since: since ?? null, checkpointAdvanced: args.advanceCheckpoint === true, total: items.length, counts: Object.fromEntries([...REASONS].map(reason => [reason, items.filter(item => item.kind === reason).length])), activity: items, cursor: response.cursor ?? null };
}

async function context(env: Env, args: Obj): Promise<Obj> { const auth = await session(env); const query = new URLSearchParams({ uri: required(args, "uri"), depth: String(typeof args.depth === "number" ? Math.trunc(args.depth) : 6), parentHeight: String(typeof args.parentHeight === "number" ? Math.trunc(args.parentHeight) : 20) }); const response = await xrpc<Obj>(env, "app.bsky.feed.getPostThread", { session: auth, query }); return { success: true, thread: response.thread }; }

async function reply(env: Env, args: Obj): Promise<Obj> {
  if (args.confirm !== true) throw new Error("confirm must be true before publishing");
  const text = required(args, "text"), root = required(args, "root"), parent = required(args, "parent"), auth = await session(env);
  const [rootCid, parentCid] = await Promise.all([cid(env, auth, root), cid(env, auth, parent)]);
  const record: Obj = { $type: "app.bsky.feed.post", text, createdAt: new Date().toISOString(), reply: { root: { uri: root, cid: rootCid }, parent: { uri: parent, cid: parentCid } } };
  if (Array.isArray(args.langs)) record.langs = args.langs.filter(value => typeof value === "string");
  const response = await xrpc<{ uri: string; cid: string }>(env, "com.atproto.repo.createRecord", { method: "POST", session: auth, body: { repo: auth.did, collection: "app.bsky.feed.post", record } });
  return { success: true, uri: response.uri, cid: response.cid, replyTo: { root, parent } };
}

async function invoke(env: Env, name: unknown, args: Obj): Promise<Obj> { if (name === "get_community_activity") return result(await activity(env, args)); if (name === "get_post_context") return result(await context(env, args)); if (name === "reply_to_post") return result(await reply(env, args)); throw new Error(`Unknown tool: ${String(name)}`); }
async function authorized(request: Request, env: Env): Promise<boolean> { const supplied = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? ""; const [a, b] = await Promise.all([crypto.subtle.digest("SHA-256", new TextEncoder().encode(supplied)), crypto.subtle.digest("SHA-256", new TextEncoder().encode(env.MCP_BEARER_TOKEN))]); const left = new Uint8Array(a), right = new Uint8Array(b); let diff = 0; for (let i = 0; i < left.length; i += 1) diff |= left[i]! ^ right[i]!; return diff === 0; }

async function mcp(request: Request, env: Env): Promise<Response> {
  if (request.method !== "POST") return new Response("Method not allowed", { status: 405 });
  const message = (await request.json()) as Obj, id = message.id ?? null;
  if (message.method === "initialize") return rpc(id, { protocolVersion: "2025-06-18", capabilities: { tools: { listChanged: false } }, serverInfo: { name: "Bluesky Community Manager", version: "0.1.0" } });
  if (message.method === "notifications/initialized") return new Response(null, { status: 202 });
  if (message.method === "ping") return rpc(id, {});
  if (message.method === "tools/list") return rpc(id, { tools });
  if (message.method === "tools/call") { const params = (message.params ?? {}) as Obj; try { return rpc(id, await invoke(env, params.name, (params.arguments ?? {}) as Obj)); } catch (error) { return rpc(id, { isError: true, content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }] }); } }
  return json({ jsonrpc: "2.0", id, error: { code: -32601, message: `Method not found: ${String(message.method)}` } });
}

export default { async fetch(request, env) { const url = new URL(request.url); if (url.pathname === "/health") return json({ ok: true, service: "bluesky-community-manager" }); if (url.pathname !== "/mcp") return new Response("Not found", { status: 404 }); if (!(await authorized(request, env))) return json({ error: "unauthorized" }, 401, { "WWW-Authenticate": 'Bearer realm="bluesky-community-manager"' }); return mcp(request, env); } } satisfies ExportedHandler<Env>;

