# Cloudflare Worker deployment

This Worker exposes an OAuth-protected MCP surface for the Bluesky community-manager workflow:

- `get_community_activity`
- `get_post_context`
- `reply_to_post` (requires `confirm: true`)

It uses Cloudflare's OAuth provider library with dynamic client registration, authorization-code flow, S256 PKCE, refresh tokens, GitHub login, a consent screen, and signed CSRF/state cookies. Only `GITHUB_ALLOWED_LOGIN` may authorize the server.

Required Worker secrets:

- `ATPROTO_IDENTIFIER`
- `ATPROTO_PASSWORD` (use a Bluesky app password)
- `ATPROTO_SERVICE` (normally `https://bsky.social`)
- `GITHUB_CLIENT_ID`
- `GITHUB_CLIENT_SECRET`
- `GITHUB_ALLOWED_LOGIN`
- `COOKIE_ENCRYPTION_KEY`

Both `STATE` and `OAUTH_KV` are KV bindings. They may point to the same namespace because their keys use separate prefixes.

The MCP endpoint is `https://bluesky-community-manager.eric-r-fraze.workers.dev/mcp`. OAuth clients discover authorization metadata automatically from the Worker's well-known endpoints.

Build with `npm install` and `npm run build`.

