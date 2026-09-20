import { OAuthProvider, type AuthRequest, type OAuthHelpers } from "@cloudflare/workers-oauth-provider";

const CHECKPOINT_KEY = "community-manager:last-checked-at";
const REASONS = new Set(["like", "follow", "reply", "mention", "quote", "repost"]);
const COOKIE_TTL = 600;
const CONSENT_COOKIE = "__Host-bcm_oauth_consent_v2";
const GITHUB_STATE_COOKIE = "__Host-bcm_github_state_v2";
const AUTH_DEBUG_KEY = "community-manager:auth-debug";
const CHATGPT_LEGACY_CLIENT_ID = "AdDBKnyClJsAw-qM";
const CHATGPT_LEGACY_REDIRECT_URI = "https://chatgpt.com/connector/oauth/RR_LLajCMzLQ";

async function ensureChatGptClient(request: Request, env: WorkerEnv): Promise<void> {
  const url = new URL(request.url);
  const clientId = url.searchParams.get("client_id");
  const redirectUri = url.searchParams.get("redirect_uri");
  if (!clientId || !redirectUri) return;

  let redirect: URL;
  try { redirect = new URL(redirectUri); } catch { return; }
  if (redirect.protocol !== "https:" || redirect.hostname !== "chatgpt.com" || !redirect.pathname.startsWith("/connector/oauth/")) return;

  await env.OAUTH_KV.put(
    `client:${clientId}`,
    JSON.stringify({
      clientId,
      redirectUris: [redirectUri],
      clientName: "ChatGPT",
      grantTypes: ["authorization_code", "refresh_token"],
      responseTypes: ["code"],
      registrationDate: Math.floor(Date.now() / 1000),
      tokenEndpointAuthMethod: "none",
      authMethodExplicit: true
    })
  );

  for (let attempt = 0; attempt < 20; attempt++) {
    const visible = await env.OAUTH_PROVIDER.lookupClient(clientId);
    if (visible) {
      await recordAuthStage(env, "oauth_client_visible");
      return;
    }
    await new Promise(resolve => setTimeout(resolve, 100));
  }

  await recordAuthStage(env, "oauth_client_not_visible");
  throw new Error("OAuth client registration did not become visible in time");
}

type Obj = Record<string, unknown>;
type Session = { accessJwt: string; did: string };
type KV = { get(key: string): Promise<string | null>; put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>; delete(key: string): Promise<void> };
type WorkerEnv = {
  ATPROTO_IDENTIFIER: string; ATPROTO_PASSWORD: string; ATPROTO_SERVICE?: string;
  GITHUB_APP_CLIENT_ID: string; GITHUB_APP_CLIENT_SECRET: string; GITHUB_ALLOWED_LOGIN: string;
  COOKIE_ENCRYPTION_KEY: string; STATE: KV; OAUTH_KV: KV; OAUTH_PROVIDER: OAuthHelpers;
};

const tools = [
  { name: "get_community_activity", description: "Get new Bluesky likes, followers, replies, mentions, quotes, and reposts. Uses a saved checkpoint when since is omitted. Set advanceCheckpoint only after successfully processing the response.", inputSchema: { type: "object", properties: { since: { type: "string", format: "date-time" }, limit: { type: "integer", minimum: 1, maximum: 100, default: 100 }, advanceCheckpoint: { type: "boolean", default: false } }, additionalProperties: false }, annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true } },
  { name: "get_post_context", description: "Read a Bluesky post and its surrounding thread before deciding whether or how to reply.", inputSchema: { type: "object", properties: { uri: { type: "string", pattern: "^at://" }, depth: { type: "integer", minimum: 0, maximum: 20, default: 6 }, parentHeight: { type: "integer", minimum: 0, maximum: 100, default: 20 } }, required: ["uri"], additionalProperties: false }, annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true } },
  { name: "reply_to_post", description: "Publish a Bluesky reply. Intended for comments or mentions on this account's own posts after inspecting the thread.", inputSchema: { type: "object", properties: { text: { type: "string", minLength: 1, maxLength: 3000 }, root: { type: "string", pattern: "^at://" }, parent: { type: "string", pattern: "^at://" }, langs: { type: "array", items: { type: "string" } } }, required: ["text", "root", "parent"], additionalProperties: false }, annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true } }
];

function json(data: unknown, status = 200, headers: HeadersInit = {}): Response { return Response.json(data, { status, headers }); }
function rpc(id: unknown, result: unknown): Response { return json({ jsonrpc: "2.0", id, result }); }
function result(value: unknown): Obj { return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }], structuredContent: value }; }
function required(args: Obj, key: string): string { const value = args[key]; if (typeof value !== "string" || !value) throw new Error(`${key} must be a non-empty string`); return value; }
function randomToken(): string { const bytes = crypto.getRandomValues(new Uint8Array(32)); return btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", ""); }
function escapeHtml(value: unknown): string { return String(value ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!)); }
function cookies(request: Request): Record<string, string> { return Object.fromEntries((request.headers.get("cookie") ?? "").split(";").map(v => v.trim().split("=", 2)).filter(v => v.length === 2) as [string, string][]); }
async function signature(value: string, secret: string): Promise<string> { const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]); const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(value))); return btoa(String.fromCharCode(...sig)).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", ""); }
async function signed(value: string, secret: string): Promise<string> { return `${value}.${await signature(value, secret)}`; }
async function verified(value: string | undefined, secret: string): Promise<string | null> { if (!value) return null; const split = value.lastIndexOf("."); if (split < 1) return null; const raw = value.slice(0, split), expected = await signature(raw, secret), actual = value.slice(split + 1); if (expected.length !== actual.length) return null; let diff = 0; for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ actual.charCodeAt(i); return diff === 0 ? raw : null; }
function encodeCookiePayload(value: unknown): string { const bytes = new TextEncoder().encode(JSON.stringify(value)); let binary = ""; for (const byte of bytes) binary += String.fromCharCode(byte); return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", ""); }
function decodeCookiePayload<T>(value: string): T | null { try { const padded = value.replaceAll("-", "+").replaceAll("_", "/") + "=".repeat((4 - (value.length % 4)) % 4); const binary = atob(padded); const bytes = Uint8Array.from(binary, char => char.charCodeAt(0)); return JSON.parse(new TextDecoder().decode(bytes)) as T; } catch { return null; } }
async function signedPayload<T>(value: T, secret: string): Promise<string> { return signed(encodeCookiePayload({ value, expiresAt: Date.now() + COOKIE_TTL * 1000 }), secret); }
async function verifiedPayload<T>(cookie: string | undefined, secret: string): Promise<T | null> { const raw = await verified(cookie, secret); if (!raw) return null; const payload = decodeCookiePayload<{ value: T; expiresAt: number }>(raw); if (!payload || typeof payload.expiresAt !== "number" || payload.expiresAt < Date.now()) return null; return payload.value; }
function setCookie(name: string, value: string, maxAge = COOKIE_TTL): string { return `${name}=${value}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`; }
function clearCookie(name: string): string { return `${name}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`; }
function clearAuthCookies(response: Response): Response { response.headers.append("Set-Cookie", clearCookie(CONSENT_COOKIE)); response.headers.append("Set-Cookie", clearCookie(GITHUB_STATE_COOKIE)); response.headers.append("Set-Cookie", clearCookie("oauth_consent")); response.headers.append("Set-Cookie", clearCookie("github_state")); return response; }
async function recordAuthStage(env: WorkerEnv, stage: string): Promise<void> {
  try {
    const raw = await env.STATE.get(AUTH_DEBUG_KEY);
    const events = raw ? JSON.parse(raw) as Obj[] : [];
    events.push({ at: new Date().toISOString(), stage });
    await env.STATE.put(AUTH_DEBUG_KEY, JSON.stringify(events.slice(-30)));
  } catch {}
}
async function authDebug(env: WorkerEnv): Promise<Response> {
  const raw = await env.STATE.get(AUTH_DEBUG_KEY);
  return json({ ok: true, events: raw ? JSON.parse(raw) : [] }, 200, { "Cache-Control": "no-store" });
}

async function xrpc<T>(env: WorkerEnv, path: string, options: { method?: "GET" | "POST"; session?: Session; query?: URLSearchParams; body?: unknown } = {}): Promise<T> {
  const url = new URL(`/xrpc/${path}`, env.ATPROTO_SERVICE || "https://bsky.social"); if (options.query) url.search = options.query.toString();
  const response = await fetch(url, { method: options.method ?? "GET", headers: { ...(options.session ? { Authorization: `Bearer ${options.session.accessJwt}` } : {}), ...(options.body === undefined ? {} : { "Content-Type": "application/json" }) }, body: options.body === undefined ? undefined : JSON.stringify(options.body) });
  if (!response.ok) throw new Error(`Bluesky API ${path} failed (${response.status}): ${await response.text()}`); return (await response.json()) as T;
}
async function session(env: WorkerEnv): Promise<Session> { return xrpc(env, "com.atproto.server.createSession", { method: "POST", body: { identifier: env.ATPROTO_IDENTIFIER, password: env.ATPROTO_PASSWORD } }); }
function postParts(uri: string): { repo: string; collection: string; rkey: string } { const match = /^at:\/\/([^/]+)\/(app\.bsky\.feed\.post)\/([^/]+)$/.exec(uri); if (!match?.[1] || !match[2] || !match[3]) throw new Error("Expected an app.bsky.feed.post AT-URI"); return { repo: match[1], collection: match[2], rkey: match[3] }; }
async function cid(env: WorkerEnv, auth: Session, uri: string): Promise<string> { const record = await xrpc<{ cid?: string }>(env, "com.atproto.repo.getRecord", { session: auth, query: new URLSearchParams(postParts(uri)) }); if (!record.cid) throw new Error(`Could not resolve CID for ${uri}`); return record.cid; }
async function activity(env: WorkerEnv, args: Obj): Promise<Obj> { const since = typeof args.since === "string" ? args.since : (await env.STATE.get(CHECKPOINT_KEY)) ?? undefined; const limit = typeof args.limit === "number" ? Math.max(1, Math.min(100, Math.trunc(args.limit))) : 100; const auth = await session(env); const query = new URLSearchParams({ limit: String(limit) }); if (since) query.set("seenAt", since); const response = await xrpc<{ notifications: Obj[]; cursor?: string }>(env, "app.bsky.notification.listNotifications", { session: auth, query }); const checkedAt = new Date().toISOString(); const items = response.notifications.filter(item => typeof item.reason === "string" && REASONS.has(item.reason)).filter(item => !since || (typeof item.indexedAt === "string" && Date.parse(item.indexedAt) > Date.parse(since))).map(item => ({ id: `${String(item.uri)}:${String(item.cid)}:${String(item.reason)}`, kind: item.reason, uri: item.uri, cid: item.cid, indexedAt: item.indexedAt, isRead: item.isRead, author: item.author, record: item.record })); if (args.advanceCheckpoint === true) await env.STATE.put(CHECKPOINT_KEY, checkedAt); return { success: true, checkedAt, since: since ?? null, checkpointAdvanced: args.advanceCheckpoint === true, total: items.length, counts: Object.fromEntries([...REASONS].map(reason => [reason, items.filter(item => item.kind === reason).length])), activity: items, cursor: response.cursor ?? null }; }
async function context(env: WorkerEnv, args: Obj): Promise<Obj> { const auth = await session(env); const query = new URLSearchParams({ uri: required(args, "uri"), depth: String(typeof args.depth === "number" ? Math.trunc(args.depth) : 6), parentHeight: String(typeof args.parentHeight === "number" ? Math.trunc(args.parentHeight) : 20) }); const response = await xrpc<Obj>(env, "app.bsky.feed.getPostThread", { session: auth, query }); return { success: true, thread: response.thread }; }
async function reply(env: WorkerEnv, args: Obj): Promise<Obj> { const text = required(args, "text"), root = required(args, "root"), parent = required(args, "parent"), auth = await session(env); const [rootCid, parentCid] = await Promise.all([cid(env, auth, root), cid(env, auth, parent)]); const record: Obj = { $type: "app.bsky.feed.post", text, createdAt: new Date().toISOString(), reply: { root: { uri: root, cid: rootCid }, parent: { uri: parent, cid: parentCid } } }; if (Array.isArray(args.langs)) record.langs = args.langs.filter(value => typeof value === "string"); const response = await xrpc<{ uri: string; cid: string }>(env, "com.atproto.repo.createRecord", { method: "POST", session: auth, body: { repo: auth.did, collection: "app.bsky.feed.post", record } }); return { success: true, uri: response.uri, cid: response.cid, replyTo: { root, parent } }; }
async function invoke(env: WorkerEnv, name: unknown, args: Obj): Promise<Obj> { if (name === "get_community_activity") return result(await activity(env, args)); if (name === "get_post_context") return result(await context(env, args)); if (name === "reply_to_post") return result(await reply(env, args)); throw new Error(`Unknown tool: ${String(name)}`); }
async function mcp(request: Request, env: WorkerEnv): Promise<Response> { if (request.method !== "POST") return new Response("Method not allowed", { status: 405 }); const message = (await request.json()) as Obj, id = message.id ?? null; if (message.method === "initialize") return rpc(id, { protocolVersion: "2025-06-18", capabilities: { tools: { listChanged: false } }, serverInfo: { name: "Bluesky Community Manager", version: "0.2.0" } }); if (message.method === "notifications/initialized") return new Response(null, { status: 202 }); if (message.method === "ping") return rpc(id, {}); if (message.method === "tools/list") return rpc(id, { tools }); if (message.method === "tools/call") { const params = (message.params ?? {}) as Obj; try { return rpc(id, await invoke(env, params.name, (params.arguments ?? {}) as Obj)); } catch (error) { return rpc(id, { isError: true, content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }] }); } } return json({ jsonrpc: "2.0", id, error: { code: -32601, message: `Method not found: ${String(message.method)}` } }); }

function consentPage(clientName: string, csrf: string): Response { const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Authorize Bluesky Community Manager</title><style>body{font:16px system-ui;background:#f5f7fb;color:#172033;margin:0}.card{max-width:520px;margin:10vh auto;background:white;padding:32px;border-radius:16px;box-shadow:0 12px 40px #18243a1f}h1{font-size:25px}button{border:0;border-radius:9px;padding:12px 18px;font-weight:700;cursor:pointer}.yes{background:#087bea;color:white}.no{background:#e9edf5;color:#263148;margin-left:8px}.note{color:#526077;line-height:1.5}</style></head><body><main class="card"><h1>Authorize Bluesky Community Manager</h1><p><strong>${escapeHtml(clientName)}</strong> is requesting access to this MCP server.</p><p class="note">After you continue, GitHub will verify your identity. Only the approved GitHub account can finish authorization.</p><form method="post" action="/authorize"><input type="hidden" name="csrf" value="${escapeHtml(csrf)}"><button class="yes" name="decision" value="approve">Continue with GitHub</button><button class="no" name="decision" value="deny">Cancel</button></form></main></body></html>`; return new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self' https://github.com; base-uri 'none'; frame-ancestors 'none'" } }); }
async function authorize(request: Request, env: WorkerEnv): Promise<Response> {
  if (request.method === "GET") {
    await recordAuthStage(env, "authorize_get");
    await ensureChatGptClient(request, env);
    let oauthRequest: AuthRequest;
    try {
      oauthRequest = await env.OAUTH_PROVIDER.parseAuthRequest(request);
      await recordAuthStage(env, "authorize_parsed");
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      return new Response(
        `Invalid OAuth authorization request: ${detail}\n\nDo not open /authorize directly. Start the connection from your MCP client using https://bluesky-community-manager.eric-r-fraze.workers.dev/mcp so it can supply the registered client_id, redirect_uri, state, scope, and PKCE parameters.`,
        { status: 400, headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" } }
      );
    }
    const client = await env.OAUTH_PROVIDER.lookupClient(oauthRequest.clientId);
    if (!client) return new Response("Unknown OAuth client", { status: 400 });
    const csrf = randomToken();
    const githubState = randomToken();
    await recordAuthStage(env, "consent_shown");
    const response = consentPage(String((client as unknown as Obj).clientName ?? oauthRequest.clientId), csrf);
    response.headers.append("Set-Cookie", clearCookie(CONSENT_COOKIE)); response.headers.append("Set-Cookie", clearCookie(GITHUB_STATE_COOKIE)); response.headers.append("Set-Cookie", clearCookie("oauth_consent")); response.headers.append("Set-Cookie", clearCookie("github_state")); response.headers.append("Set-Cookie", setCookie(CONSENT_COOKIE, await signedPayload({ oauthRequest, csrf, githubState }, env.COOKIE_ENCRYPTION_KEY)));
    return response;
  }
  if (request.method !== "POST") return new Response("Method not allowed", { status: 405 }); await recordAuthStage(env, "authorize_post"); const form = await request.formData(); const pending = await verifiedPayload<{ oauthRequest: AuthRequest; csrf: string; githubState: string }>(cookies(request)[CONSENT_COOKIE], env.COOKIE_ENCRYPTION_KEY); if (!pending) return new Response("Authorization session is invalid or expired", { status: 400 }); if (form.get("csrf") !== pending.csrf) return new Response("CSRF validation failed", { status: 403 }); if (form.get("decision") !== "approve") { const denied = new URL(pending.oauthRequest.redirectUri); denied.searchParams.set("error", "access_denied"); denied.searchParams.set("state", pending.oauthRequest.state); return clearAuthCookies(Response.redirect(denied.toString(), 302)); } const state = pending.githubState; const redirect = new URL("https://github.com/login/oauth/authorize"); redirect.searchParams.set("client_id", env.GITHUB_APP_CLIENT_ID); redirect.searchParams.set("redirect_uri", `${new URL(request.url).origin}/callback`); redirect.searchParams.set("state", state); await recordAuthStage(env, "redirect_to_github"); const response = new Response(null, { status: 302, headers: { Location: redirect.toString() } }); response.headers.append("Set-Cookie", setCookie(GITHUB_STATE_COOKIE, await signedPayload({ state, oauthRequest: pending.oauthRequest }, env.COOKIE_ENCRYPTION_KEY))); return response;
}
async function callback(request: Request, env: WorkerEnv): Promise<Response> { await recordAuthStage(env, "github_callback"); const url = new URL(request.url), code = url.searchParams.get("code"), state = url.searchParams.get("state"), pending = await verifiedPayload<{ state: string; oauthRequest: AuthRequest }>(cookies(request)[GITHUB_STATE_COOKIE], env.COOKIE_ENCRYPTION_KEY); if (!code || !state || !pending || state !== pending.state) return new Response("GitHub OAuth state validation failed", { status: 400 }); await recordAuthStage(env, "github_state_ok"); const tokenResponse = await fetch("https://github.com/login/oauth/access_token", { method: "POST", headers: { Accept: "application/json", "Content-Type": "application/json", "User-Agent": "bluesky-community-manager" }, body: JSON.stringify({ client_id: env.GITHUB_APP_CLIENT_ID, client_secret: env.GITHUB_APP_CLIENT_SECRET, code, redirect_uri: `${url.origin}/callback` }) }); const tokenData = await tokenResponse.json() as { access_token?: string; error_description?: string }; if (!tokenResponse.ok || !tokenData.access_token) return new Response(`GitHub token exchange failed: ${tokenData.error_description ?? tokenResponse.status}`, { status: 502 }); await recordAuthStage(env, "github_token_ok"); const userResponse = await fetch("https://api.github.com/user", { headers: { Authorization: `Bearer ${tokenData.access_token}`, Accept: "application/vnd.github+json", "User-Agent": "bluesky-community-manager", "X-GitHub-Api-Version": "2022-11-28" } }); const user = await userResponse.json() as { id?: number; login?: string; name?: string }; if (!userResponse.ok || !user.id || !user.login) return new Response("Could not verify GitHub identity", { status: 502 }); if (user.login.toLowerCase() !== env.GITHUB_ALLOWED_LOGIN.toLowerCase()) return new Response("This GitHub account is not authorized for this Bluesky manager", { status: 403 }); await recordAuthStage(env, "github_user_ok"); const completed = await env.OAUTH_PROVIDER.completeAuthorization({ request: pending.oauthRequest, userId: `github:${user.id}`, metadata: { label: user.login }, scope: pending.oauthRequest.scope, props: { githubId: user.id, githubLogin: user.login } }); await recordAuthStage(env, "authorization_completed"); const response = new Response(null, { status: 302, headers: { Location: completed.redirectTo } }); response.headers.append("Set-Cookie", setCookie("github_state", "", 0)); return response; }

const apiHandler = { async fetch(request: Request, env: WorkerEnv): Promise<Response> { return mcp(request, env); } };
const defaultHandler = { async fetch(request: Request, env: WorkerEnv): Promise<Response> { const path = new URL(request.url).pathname; if (path === "/health") return json({ ok: true, service: "bluesky-community-manager", version: "0.2.2", authentication: "oauth", upstreamIdentity: "github-app", config: { githubAppClientId: Boolean(env.GITHUB_APP_CLIENT_ID), githubAppClientSecret: Boolean(env.GITHUB_APP_CLIENT_SECRET), githubAllowedLogin: Boolean(env.GITHUB_ALLOWED_LOGIN), cookieEncryptionKey: Boolean(env.COOKIE_ENCRYPTION_KEY), atprotoIdentifier: Boolean(env.ATPROTO_IDENTIFIER), atprotoPassword: Boolean(env.ATPROTO_PASSWORD) } }); if (path === "/auth-debug") return authDebug(env); if (path === "/authorize") return authorize(request, env); if (path === "/callback") return callback(request, env); if (path === "/") return new Response("Bluesky Community Manager MCP server", { headers: { "Content-Type": "text/plain; charset=utf-8" } }); return new Response("Not found", { status: 404 }); } };

const oauthProvider = new OAuthProvider<WorkerEnv>({ apiRoute: "/mcp", apiHandler, defaultHandler, authorizeEndpoint: "/authorize", tokenEndpoint: "/token", clientRegistrationEndpoint: "/register", clientIdMetadataDocumentEnabled: true, scopesSupported: ["bluesky.manage"], allowPlainPKCE: false, accessTokenTTL: 3600, refreshTokenTTL: 2592000, onError({ code, description, status, internal }) { console.error("OAuth provider error", { code, description, status, category: internal?.category, reason: internal?.reason }); }, resourceMetadata: { resource: "https://bluesky-community-manager.eric-r-fraze.workers.dev/mcp", authorization_servers: ["https://bluesky-community-manager.eric-r-fraze.workers.dev"], scopes_supported: ["bluesky.manage"], bearer_methods_supported: ["header"], resource_name: "Bluesky Community Manager" } });


export default {
  async fetch(request: Request, env: WorkerEnv, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname !== "/token") return oauthProvider.fetch(request, env, ctx);

    try {
      const clone = request.clone();
      const contentType = clone.headers.get("Content-Type") || "";
      const authHeader = clone.headers.get("Authorization");
      let fields: string[] = [];
      let grantType: string | null = null;
      let hasClientId = false, hasClientSecret = false, hasCode = false, hasVerifier = false, hasRedirectUri = false, hasResource = false;
      if (contentType.toLowerCase().startsWith("application/x-www-form-urlencoded")) {
        const form = await clone.formData();
        fields = [...new Set([...form.keys()])].sort();
        grantType = typeof form.get("grant_type") === "string" ? String(form.get("grant_type")) : null;
        hasClientId = form.has("client_id");
        hasClientSecret = form.has("client_secret");
        hasCode = form.has("code");
        hasVerifier = form.has("code_verifier");
        hasRedirectUri = form.has("redirect_uri");
        hasResource = form.has("resource");
      }
      const authKind = authHeader?.toLowerCase().startsWith("basic ") ? "basic" : authHeader ? "other" : "none";
      await recordAuthStage(env, `token_request:${grantType ?? "unknown"}:auth=${authKind}:client_id=${hasClientId}:client_secret=${hasClientSecret}:code=${hasCode}:verifier=${hasVerifier}:redirect_uri=${hasRedirectUri}:resource=${hasResource}:fields=${fields.join(",")}`);
    } catch {
      await recordAuthStage(env, "token_request_inspection_failed");
    }

    const response = await oauthProvider.fetch(request, env, ctx);
    try {
      const clone = response.clone();
      let errorCode = "";
      let errorDescription = "";
      const type = clone.headers.get("Content-Type") || "";
      if (type.toLowerCase().includes("application/json")) {
        const body = await clone.json() as { error?: unknown; error_description?: unknown };
        errorCode = typeof body.error === "string" ? body.error : "";
        errorDescription = typeof body.error_description === "string" ? body.error_description : "";
      }
      const safeDescription = errorDescription.replace(/[^a-zA-Z0-9 _.:/-]/g, "").slice(0, 120);
      await recordAuthStage(env, `token_response:status=${response.status}:error=${errorCode}:description=${safeDescription}`);
    } catch {
      await recordAuthStage(env, `token_response:status=${response.status}`);
    }
    return response;
  }
};
