import { createSign } from 'node:crypto';

export interface IGitHubAppEnv {
  GITHUB_APP_ID: string;
  GITHUB_PRIVATE_KEY: string;
  GITHUB_INSTALLATION_ID: string;
}

/**
 * Read-only GitHub App client used by Bluesky Bot devlog generation.
 * Credentials are supplied by runtime environment secrets.
 */
export class GitHubAppClient {
  constructor(private readonly env: IGitHubAppEnv) {}

  private async createInstallationToken(): Promise<string> {
    const now = Math.floor(Date.now() / 1000);
    const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
    const payload = Buffer.from(
      JSON.stringify({
        iat: now - 60,
        exp: now + 540,
        iss: this.env.GITHUB_APP_ID,
      })
    ).toString('base64url');

    const signer = createSign('RSA-SHA256');
    signer.update(`${header}.${payload}`);
    const signature = signer.sign(this.env.GITHUB_PRIVATE_KEY, 'base64url');
    const jwt = `${header}.${payload}.${signature}`;

    const response = await fetch(
      `https://api.github.com/app/installations/${this.env.GITHUB_INSTALLATION_ID}/access_tokens`,
      {
        method: 'POST',
        headers: {
          Accept: 'application/vnd.github+json',
          Authorization: `Bearer ${jwt}`,
          'User-Agent': 'Bluesky-Bot-Devlog',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ permissions: { contents: 'read', pull_requests: 'read' } }),
      }
    );

    if (!response.ok) {
      throw new Error(`GitHub App authentication failed: ${response.status}`);
    }

    const data = (await response.json()) as { token: string };
    return data.token;
  }

  async request(path: string): Promise<any> {
    const token = await this.createInstallationToken();
    const response = await fetch(`https://api.github.com${path}`, {
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${token}`,
        'User-Agent': 'Bluesky-Bot-Devlog',
      },
    });

    if (!response.ok) {
      throw new Error(`GitHub API failed: ${response.status}`);
    }

    return response.json();
  }
}
