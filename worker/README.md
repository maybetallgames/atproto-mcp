# Cloudflare Worker deployment

This Worker exposes an OAuth-protected MCP surface for the Bluesky community-manager workflow:

- `get_community_activity`
- `get_post_context`
- `reply_to_post` (requires `confirm: true`)

It uses Cloudflare's OAuth provider library with dynamic client registration, authorization-code flow, S256 PKCE, refresh tokens, GitHub App user authorization, a consent screen, and signed CSRF/state cookies. Only `GITHUB_ALLOWED_LOGIN` may authorize the server.

Required Worker secrets:

- `ATPROTO_IDENTIFIER`
- `ATPROTO_PASSWORD` (use a Bluesky app password)
- `ATPROTO_SERVICE` (normally `https://bsky.social`)
- `GITHUB_APP_CLIENT_ID`
- `GITHUB_APP_CLIENT_SECRET`
- `GITHUB_ALLOWED_LOGIN`
- `COOKIE_ENCRYPTION_KEY`

Both `STATE` and `OAUTH_KV` are KV bindings. They may point to the same namespace because their keys use separate prefixes.

Short-lived consent and GitHub App authorization handoff state is kept in signed, HttpOnly cookies so authorization does not depend on KV propagation between edge locations.

The MCP endpoint is `https://bluesky-community-manager.eric-r-fraze.workers.dev/mcp`. OAuth clients discover authorization metadata automatically from the Worker's well-known endpoints.

Build with `npm install` and `npm run build`.

## Cloudflare Git build settings

When deploying this worker from Cloudflare's Git integration with the project path set to `worker`, disable Cloudflare's automatic dependency install and install explicitly in the build command:

- Path: `worker`
- Build command: `pnpm install --no-frozen-lockfile && pnpm run build`
- Deploy command: `npx wrangler deploy`
- Build variable: `SKIP_DEPENDENCY_INSTALL=1`

This avoids Cloudflare running `pnpm install --frozen-lockfile` inside `worker/`, where there is no dedicated `pnpm-lock.yaml`.

Deployment note: OAuth provider upgraded to the ChatGPT-compatible 0.10.x line.

## GitHub App authentication

This deployment uses a GitHub App for the identity check instead of a classic GitHub OAuth App. Create/install the GitHub App using the settings in [GITHUB_APP_SETUP.md](./GITHUB_APP_SETUP.md), then store its client ID and client secret as Worker secrets.
