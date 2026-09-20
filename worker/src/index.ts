import type { AuthRequest, OAuthHelpers } from "@cloudflare/workers-oauth-provider";

const CHECKPOINT_KEY = "community-manager:last-checked-at";
const REASONS = new Set(["like", "follow", "reply", "mention", "quote", "repost"]);
const COOKIE_TTL = 600;
const CONSENT_COOKIE = "__Host-bcm_oauth_consent_v2";
const GITHUB_STATE_COOKIE = "__Host-bcm_github_state_v2";
const AUTH_DEBUG_KEY = "community-manager:auth-debug";

type Obj = Record<string, unknown>;
type Session = { accessJwt: string; did: string };
type KV = { get(key: string): Promise<string | null>; put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>; delete(key: string): Promise<void> };
type WorkerEnv = {
  ATPROTO_IDENTIFIER: string; ATPROTO_PASSWORD: string; ATPROTO_SERVICE?: string;
  GITHUB_APP_CLIENT_ID: string; GITHUB_APP_CLIENT_SECRET: string; GITHUB_ALLOWED_LOGIN: string;
  COOKIE_ENCRYPTION_KEY: string; MCP_SECRET_PATH: string; STATE: KV; OAUTH_KV: KV; OAUTH_PROVIDER: OAuthHelpers;
};

const tools = [
  { name: "get_community_activity", description: "Get new Bluesky likes, followers, replies, mentions, quotes, and reposts. Uses a saved checkpoint when since is omitted. Set advanceCheckpoint only after successfully processing the response.", inputSchema: { type: "object", properties: { since: { type: "string", format: "date-time" }, limit: { type: "integer", minimum: 1, maximum: 100, default: 100 }, advanceCheckpoint: { type: "boolean", default: false } }, additionalProperties: false }, annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true } },
  { name: "get_post_context", description: "Read a Bluesky post and its surrounding thread before deciding whether or how to reply.", inputSchema: { type: "object", properties: { uri: { type: "string", pattern: "^at://" }, depth: { type: "integer", minimum: 0, maximum: 20, default: 6 }, parentHeight: { type: "integer", minimum: 0, maximum: 100, default: 20 } }, required: ["uri"], additionalProperties: false }, annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true } },
  { name: "reply_to_post", description: "Publish a Bluesky reply. Intended for comments or mentions on this account's own posts after inspecting the thread.", inputSchema: { type: "object", properties: { text: { type: "string", minLength: 1, maxLength: 3000 }, root: { type: "string", pattern: "^at://" }, parent: { type: "string", pattern: "^at://" }, langs: { type: "array", items: { type: "string" } } }, required: ["text", "root", "parent"], additionalProperties: false }, annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true } },
  { name: "create_post", description: "Publish a new standalone Bluesky post. Accepts files attached directly in ChatGPT through mediaFiles, plus explicit HTTPS URLs/base64 inputs. Supports up to four images or one video.", inputSchema: { type: "object", properties: { text: { type: "string", minLength: 0, maxLength: 3000 }, langs: { type: "array", items: { type: "string" } }, images: { type: "array", maxItems: 4, items: { type: "object", properties: { url: { type: "string", format: "uri" }, base64: { type: "string" }, mimeType: { type: "string", pattern: "^image/" }, alt: { type: "string", maxLength: 2000, default: "" }, width: { type: "integer", minimum: 1 }, height: { type: "integer", minimum: 1 } }, additionalProperties: false } }, video: { type: "object", properties: { url: { type: "string", format: "uri" }, mimeType: { type: "string" }, alt: { type: "string", maxLength: 2000, default: "" }, width: { type: "integer", minimum: 1 }, height: { type: "integer", minimum: 1 }, name: { type: "string", minLength: 1, maxLength: 200 } }, required: ["url"], additionalProperties: false }, mediaFiles: { type: "array", maxItems: 4, items: { type: "object", properties: { download_url: { type: "string", format: "uri" }, file_id: { type: "string" }, mime_type: { type: "string" }, file_name: { type: "string" } }, required: ["download_url", "file_id"], additionalProperties: false }, description: "Files attached directly in ChatGPT. Each file is supplied by ChatGPT with a temporary HTTPS download_url and file_id." } }, additionalProperties: false }, annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true }, _meta: { "openai/fileParams": ["mediaFiles"] } },
  { name: "create_post_with_media", description: "Publish a standalone Bluesky post from files attached in ChatGPT. Use this tool for an attached video or up to four attached images.", inputSchema: { type: "object", properties: { text: { type: "string", minLength: 0, maxLength: 3000 }, langs: { type: "array", items: { type: "string" } }, mediaFiles: { type: "array", minItems: 1, maxItems: 4, items: { type: "object", properties: { download_url: { type: "string", format: "uri" }, file_id: { type: "string" }, mime_type: { type: "string" }, file_name: { type: "string" } }, required: ["download_url", "file_id"], additionalProperties: false }, description: "Files attached by ChatGPT. One video or up to four still images." } }, required: ["mediaFiles"], additionalProperties: false }, annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true }, _meta: { "openai/fileParams": ["mediaFiles"] } }
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

const VIDEO_SERVICE = "https://video.bsky.app";
const VIDEO_MAX_SIZE = 300_000_000;
const IMAGE_MAX_SIZE = 2_000_000;
const VIDEO_MIME_TYPES = new Set(["video/mp4", "video/mpeg", "video/webm", "video/quicktime", "image/gif"]);

function decodeBase64(value: string): Uint8Array {
  const raw = value.includes(",") ? value.slice(value.indexOf(",") + 1) : value;
  const binary = atob(raw.replace(/\s/g, ""));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
function safeMediaName(value: string, mimeType: string): string {
  const clean = value.replace(/[^a-zA-Z0-9._-]/g, "-").replace(/-+/g, "-").slice(0, 160);
  if (clean.includes(".")) return clean;
  const ext = mimeType === "video/webm" ? "webm" : mimeType === "video/mpeg" ? "mpeg" : mimeType === "video/quicktime" ? "mov" : mimeType === "image/gif" ? "gif" : "mp4";
  return `${clean || "video"}.${ext}`;
}
function sleep(ms: number): Promise<void> { return new Promise(resolve => setTimeout(resolve, ms)); }

async function detectRemoteMime(value: string): Promise<string> {
  const url = new URL(value);
  if (url.protocol !== "https:") throw new Error("Attached media URLs must use HTTPS");
  let response = await fetch(url, { method: "HEAD", redirect: "follow" });
  let mimeType = response.ok ? (response.headers.get("content-type") || "").split(";")[0]!.trim() : "";
  if (!mimeType) {
    response = await fetch(url, { method: "GET", headers: { Range: "bytes=0-0" }, redirect: "follow" });
    mimeType = response.ok ? (response.headers.get("content-type") || "").split(";")[0]!.trim() : "";
    try { await response.body?.cancel(); } catch {}
  }
  if (mimeType) return mimeType;
  const path = url.pathname.toLowerCase();
  if (/\.png$/.test(path)) return "image/png";
  if (/\.jpe?g$/.test(path)) return "image/jpeg";
  if (/\.webp$/.test(path)) return "image/webp";
  if (/\.gif$/.test(path)) return "image/gif";
  if (/\.mp4$/.test(path)) return "video/mp4";
  if (/\.webm$/.test(path)) return "video/webm";
  if (/\.mpe?g$/.test(path)) return "video/mpeg";
  if (/\.mov$/.test(path)) return "video/quicktime";
  throw new Error("Could not determine attached media type");
}

async function uploadImageBlob(env: WorkerEnv, auth: Session, input: unknown): Promise<Obj> {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Each image must be an object");
  const item = input as Obj;
  const urlValue = typeof item.url === "string" && item.url ? item.url : undefined;
  const base64Value = typeof item.base64 === "string" && item.base64 ? item.base64 : undefined;
  if ((urlValue ? 1 : 0) + (base64Value ? 1 : 0) !== 1) throw new Error("Each image must provide exactly one of url or base64");

  let bytes: Uint8Array;
  let mimeType = typeof item.mimeType === "string" ? item.mimeType : "";
  if (urlValue) {
    const sourceUrl = new URL(urlValue);
    if (sourceUrl.protocol !== "https:") throw new Error("Image URLs must use HTTPS");
    const source = await fetch(sourceUrl, { redirect: "follow" });
    if (!source.ok) throw new Error(`Could not fetch image URL (${source.status})`);
    const length = Number(source.headers.get("content-length") || "0");
    if (length > IMAGE_MAX_SIZE) throw new Error("Each Bluesky image must be 2 MB or smaller");
    mimeType = mimeType || (source.headers.get("content-type") || "").split(";")[0]!.trim();
    bytes = new Uint8Array(await source.arrayBuffer());
  } else {
    if (!mimeType) throw new Error("mimeType is required for base64 images");
    bytes = decodeBase64(base64Value!);
  }
  if (!mimeType.startsWith("image/")) throw new Error("Image mimeType must start with image/");
  if (bytes.byteLength > IMAGE_MAX_SIZE) throw new Error("Each Bluesky image must be 2 MB or smaller");

  const uploadUrl = new URL("/xrpc/com.atproto.repo.uploadBlob", env.ATPROTO_SERVICE || "https://bsky.social");
  const response = await fetch(uploadUrl, {
    method: "POST",
    headers: { Authorization: `Bearer ${auth.accessJwt}`, "Content-Type": mimeType },
    body: bytes
  });
  if (!response.ok) throw new Error(`Bluesky image upload failed (${response.status}): ${await response.text()}`);
  const payload = await response.json() as { blob?: Obj };
  if (!payload.blob) throw new Error("Bluesky image upload returned no blob");

  const image: Obj = { alt: typeof item.alt === "string" ? item.alt : "", image: payload.blob };
  if (typeof item.width === "number" && typeof item.height === "number" && item.width > 0 && item.height > 0) {
    image.aspectRatio = { width: Math.trunc(item.width), height: Math.trunc(item.height) };
  }
  return image;
}

async function getVideoServiceAuth(env: WorkerEnv, auth: Session): Promise<string> {
  const pds = new URL(env.ATPROTO_SERVICE || "https://bsky.social");
  const query = new URLSearchParams({
    aud: `did:web:${pds.hostname}`,
    lxm: "com.atproto.repo.uploadBlob",
    exp: String(Math.floor(Date.now() / 1000) + 60 * 30)
  });
  const response = await xrpc<{ token?: string }>(env, "com.atproto.server.getServiceAuth", { session: auth, query });
  if (!response.token) throw new Error("Could not obtain Bluesky video service auth token");
  return response.token;
}

function normalizeVideoJob(value: unknown): Obj {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid response from Bluesky video service");
  const obj = value as Obj;
  const nested = obj.jobStatus;
  return nested && typeof nested === "object" && !Array.isArray(nested) ? nested as Obj : obj;
}

async function uploadVideoEmbed(env: WorkerEnv, auth: Session, input: unknown): Promise<Obj> {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("video must be an object");
  const item = input as Obj;
  const sourceUrl = new URL(required(item, "url"));
  if (sourceUrl.protocol !== "https:") throw new Error("Video URLs must use HTTPS");

  const source = await fetch(sourceUrl, { redirect: "follow" });
  if (!source.ok || !source.body) throw new Error(`Could not fetch video URL (${source.status})`);
  const length = Number(source.headers.get("content-length") || "0");
  if (length > VIDEO_MAX_SIZE) throw new Error("Bluesky videos must be 300 MB or smaller");
  const detectedMime = (source.headers.get("content-type") || "").split(";")[0]!.trim();
  const mimeType = typeof item.mimeType === "string" && item.mimeType ? item.mimeType : detectedMime;
  if (!VIDEO_MIME_TYPES.has(mimeType)) throw new Error(`Unsupported Bluesky video type: ${mimeType || "unknown"}`);

  const token = await getVideoServiceAuth(env, auth);
  const pathName = sourceUrl.pathname.split("/").filter(Boolean).pop() || "video";
  const name = safeMediaName(typeof item.name === "string" ? item.name : pathName, mimeType);
  const uploadUrl = new URL("/xrpc/app.bsky.video.uploadVideo", VIDEO_SERVICE);
  uploadUrl.searchParams.set("did", auth.did);
  uploadUrl.searchParams.set("name", name);

  const upload = await fetch(uploadUrl, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": mimeType },
    body: source.body
  });
  if (!upload.ok) throw new Error(`Bluesky video upload failed (${upload.status}): ${await upload.text()}`);

  let job = normalizeVideoJob(await upload.json());
  const jobId = typeof job.jobId === "string" ? job.jobId : undefined;
  for (let attempt = 0; attempt < 75 && !job.blob; attempt++) {
    const state = String(job.state ?? "");
    if (/failed|aborted|expired/i.test(state)) throw new Error(`Bluesky video processing failed: ${String(job.error ?? job.message ?? state)}`);
    if (!jobId) break;
    await sleep(1000);
    const statusUrl = new URL("/xrpc/app.bsky.video.getJobStatus", VIDEO_SERVICE);
    statusUrl.searchParams.set("jobId", jobId);
    const status = await fetch(statusUrl);
    if (!status.ok) throw new Error(`Bluesky video status check failed (${status.status}): ${await status.text()}`);
    job = normalizeVideoJob(await status.json());
  }
  if (!job.blob) throw new Error("Bluesky video is still processing; try the post again shortly");

  const embed: Obj = { $type: "app.bsky.embed.video", video: job.blob, alt: typeof item.alt === "string" ? item.alt : "" };
  if (typeof item.width === "number" && typeof item.height === "number" && item.width > 0 && item.height > 0) {
    embed.aspectRatio = { width: Math.trunc(item.width), height: Math.trunc(item.height) };
  }
  if (mimeType === "image/gif") embed.presentation = "gif";
  return embed;
}

async function createPost(env: WorkerEnv, args: Obj): Promise<Obj> {
  const text = typeof args.text === "string" ? args.text : "";
  const auth = await session(env);
  let images = Array.isArray(args.images) ? args.images : [];
  let videoInput = args.video;
  const mediaFiles = Array.isArray(args.mediaFiles) ? args.mediaFiles : [];

  if (mediaFiles.length) {
    if (images.length || videoInput !== undefined) throw new Error("Use either mediaFiles or explicit images/video, not both");
    const detected = await Promise.all(mediaFiles.map(async input => {
      if (typeof input === "string") { const url = input; return { url, mimeType: await detectRemoteMime(url) }; }
      if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Each mediaFiles item must be a ChatGPT file object");
      const file = input as Obj;
      const url = required(file, "download_url");
      const providedMime = typeof file.mime_type === "string" ? file.mime_type.trim() : "";
      const mimeType = providedMime || await detectRemoteMime(url);
      const name = typeof file.file_name === "string" && file.file_name ? file.file_name : undefined;
      return { url, mimeType, ...(name ? { name } : {}) };
    }));
    const videos = detected.filter(item => VIDEO_MIME_TYPES.has(item.mimeType));
    const stills = detected.filter(item => item.mimeType.startsWith("image/") && item.mimeType !== "image/gif");
    if (videos.length) {
      if (detected.length !== 1 || videos.length !== 1) throw new Error("A Bluesky video post can contain one video and no images");
      videoInput = videos[0];
    } else {
      if (stills.length !== detected.length) throw new Error("Unsupported attached media type");
      images = stills;
    }
  }

  const hasVideo = videoInput !== undefined && videoInput !== null;
  if (images.length > 4) throw new Error("Bluesky supports at most four images per post");
  if (images.length && hasVideo) throw new Error("A Bluesky post cannot contain both image and video embeds");
  if (!text && !images.length && !hasVideo) throw new Error("Post must contain text or media");

  const record: Obj = { $type: "app.bsky.feed.post", text, createdAt: new Date().toISOString() };
  if (Array.isArray(args.langs)) record.langs = args.langs.filter(value => typeof value === "string");
  if (images.length) {
    const uploaded: Obj[] = [];
    for (const image of images) uploaded.push(await uploadImageBlob(env, auth, image));
    record.embed = { $type: "app.bsky.embed.images", images: uploaded };
  } else if (hasVideo) {
    record.embed = await uploadVideoEmbed(env, auth, videoInput);
  }

  const response = await xrpc<{ uri: string; cid: string }>(env, "com.atproto.repo.createRecord", {
    method: "POST",
    session: auth,
    body: { repo: auth.did, collection: "app.bsky.feed.post", record }
  });
  return { success: true, uri: response.uri, cid: response.cid, imageCount: images.length, hasVideo };
}
async function invoke(env: WorkerEnv, name: unknown, args: Obj): Promise<Obj> { if (name === "get_community_activity") return result(await activity(env, args)); if (name === "get_post_context") return result(await context(env, args)); if (name === "reply_to_post") return result(await reply(env, args)); if (name === "create_post" || name === "create_post_with_media") return result(await createPost(env, args)); throw new Error(`Unknown tool: ${String(name)}`); }
async function mcp(request: Request, env: WorkerEnv): Promise<Response> { if (request.method !== "POST") return new Response("Method not allowed", { status: 405 }); const message = (await request.json()) as Obj, id = message.id ?? null; if (message.method === "initialize") return rpc(id, { protocolVersion: "2025-06-18", capabilities: { tools: { listChanged: true } }, serverInfo: { name: "Bluesky Community Manager", version: "0.4.5" } }); if (message.method === "notifications/initialized") return new Response(null, { status: 202 }); if (message.method === "ping") return rpc(id, {}); if (message.method === "tools/list") return rpc(id, { tools }); if (message.method === "tools/call") { const params = (message.params ?? {}) as Obj; try { return rpc(id, await invoke(env, params.name, (params.arguments ?? {}) as Obj)); } catch (error) { return rpc(id, { isError: true, content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }] }); } } return json({ jsonrpc: "2.0", id, error: { code: -32601, message: `Method not found: ${String(message.method)}` } }); }

function consentPage(clientName: string, csrf: string): Response { const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Authorize Bluesky Community Manager</title><style>body{font:16px system-ui;background:#f5f7fb;color:#172033;margin:0}.card{max-width:520px;margin:10vh auto;background:white;padding:32px;border-radius:16px;box-shadow:0 12px 40px #18243a1f}h1{font-size:25px}button{border:0;border-radius:9px;padding:12px 18px;font-weight:700;cursor:pointer}.yes{background:#087bea;color:white}.no{background:#e9edf5;color:#263148;margin-left:8px}.note{color:#526077;line-height:1.5}</style></head><body><main class="card"><h1>Authorize Bluesky Community Manager</h1><p><strong>${escapeHtml(clientName)}</strong> is requesting access to this MCP server.</p><p class="note">After you continue, GitHub will verify your identity. Only the approved GitHub account can finish authorization.</p><form method="post" action="/authorize"><input type="hidden" name="csrf" value="${escapeHtml(csrf)}"><button class="yes" name="decision" value="approve">Continue with GitHub</button><button class="no" name="decision" value="deny">Cancel</button></form></main></body></html>`; return new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self' https://github.com; base-uri 'none'; frame-ancestors 'none'" } }); }
async function authorize(request: Request, env: WorkerEnv): Promise<Response> {
  if (request.method === "GET") {
    await recordAuthStage(env, "authorize_get");
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

export default {
  async fetch(request: Request, env: WorkerEnv): Promise<Response> {
    const url = new URL(request.url);
    const secret = (env.MCP_SECRET_PATH || "").trim();

    if (url.pathname === "/health") {
      return json({
        ok: true,
        service: "bluesky-community-manager",
        version: "0.4.5",
        authentication: "noauth-secret-path",
        build: "direct-chatgpt-files-0.4.5",
        config: {
          mcpSecretPath: Boolean(secret),
          atprotoIdentifier: Boolean(env.ATPROTO_IDENTIFIER),
          atprotoPassword: Boolean(env.ATPROTO_PASSWORD)
        }
      }, 200, { "Cache-Control": "no-store" });
    }

    if (url.pathname === "/") {
      return new Response("Bluesky Community Manager MCP server", {
        headers: { "Content-Type": "text/plain; charset=utf-8" }
      });
    }

    // Never expose the MCP on the predictable public route.
    if (url.pathname === "/mcp") return new Response("Not found", { status: 404 });

    if (!secret) {
      return new Response("MCP secret path is not configured", { status: 503 });
    }

    if (url.pathname === `/mcp/${secret}`) {
      return mcp(request, env);
    }

    return new Response("Not found", { status: 404 });
  }
};
