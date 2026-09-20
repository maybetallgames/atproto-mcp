# Cloudflare Worker deployment

This Worker exposes a deliberately small, bearer-protected MCP surface for the Bluesky community-manager workflow:

- `get_community_activity`
- `get_post_context`
- `reply_to_post` (requires `confirm: true`)

Required Worker secrets:

- `ATPROTO_IDENTIFIER`
- `ATPROTO_PASSWORD` (use a Bluesky app password)
- `ATPROTO_SERVICE` (normally `https://bsky.social`)
- `MCP_BEARER_TOKEN`

The `STATE` KV binding stores the last successfully processed notification checkpoint. Keep the Worker off its public workers.dev subdomain until all secrets are configured.
