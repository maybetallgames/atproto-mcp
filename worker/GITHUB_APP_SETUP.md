# GitHub App setup for Bluesky Community Manager

The Worker uses a GitHub App only to verify which GitHub user is authorizing the MCP connection.

## Create the app

In GitHub, create a new GitHub App with:

- **GitHub App name:** `Bluesky Community Manager` (or another unique name)
- **Homepage URL:** `https://bluesky-community-manager.eric-r-fraze.workers.dev`
- **Callback URL:** `https://bluesky-community-manager.eric-r-fraze.workers.dev/callback`
- **Request user authorization (OAuth) during installation:** optional; the Worker starts the web authorization flow itself
- **Webhooks:** disabled
- **Repository permissions:** none required for the identity-only flow
- **Organization permissions:** none required
- **Account permissions:** none required beyond GitHub's authenticated-user identity available to the user access token
- **Where can this GitHub App be installed?:** Only on this account, unless you intentionally want to support other accounts

After creation, generate a **client secret**. The Worker uses the GitHub App's **Client ID**, not its numeric App ID.

Install the app on the GitHub account that should be allowed to sign in.

## Configure Cloudflare

Set these Worker secrets:

```bash
cd worker
npx wrangler secret put GITHUB_APP_CLIENT_ID
npx wrangler secret put GITHUB_APP_CLIENT_SECRET
npx wrangler secret put GITHUB_ALLOWED_LOGIN
```

Keep the existing `COOKIE_ENCRYPTION_KEY`, Bluesky credentials, `STATE`, and `OAUTH_KV` bindings unchanged.

Then deploy:

```bash
npx wrangler deploy
```

## Flow

1. ChatGPT starts OAuth against the Worker's MCP OAuth provider.
2. The Worker shows its consent screen.
3. The Worker redirects to GitHub using the GitHub App Client ID.
4. GitHub returns an authorization code to `/callback`.
5. The Worker exchanges it using the GitHub App client secret.
6. The Worker calls GitHub's authenticated-user endpoint and compares the login with `GITHUB_ALLOWED_LOGIN`.
7. If it matches, the Worker completes the MCP authorization.

The GitHub token is used only during this identity verification step and is not persisted by the Worker.
