type GitHubAppCredentials = {
  GITHUB_APP_ID: string;
  GITHUB_PRIVATE_KEY: string;
};

const PKCS8_RSA_ALGORITHM = Uint8Array.from([
  0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01, 0x05, 0x00,
]);

const concat = (...parts: Uint8Array[]): Uint8Array => {
  const result = new Uint8Array(parts.reduce((length, part) => length + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
};

const derLength = (length: number): Uint8Array => {
  if (length < 0x80) return Uint8Array.of(length);
  const bytes: number[] = [];
  for (let value = length; value > 0; value >>>= 8) bytes.unshift(value & 0xff);
  return Uint8Array.of(0x80 | bytes.length, ...bytes);
};

const der = (tag: number, value: Uint8Array): Uint8Array =>
  concat(Uint8Array.of(tag), derLength(value.length), value);

const decodeBase64 = (value: string): Uint8Array => {
  try {
    return Uint8Array.from(atob(value), character => character.charCodeAt(0));
  } catch {
    throw new Error(
      'GITHUB_PRIVATE_KEY is not valid PEM/base64 data. Store the complete downloaded GitHub App .pem file without surrounding quotes.'
    );
  }
};

export function githubPrivateKeyToPkcs8(privateKey: string): Uint8Array {
  let normalized = privateKey.trim().replace(/\\r?\\n/g, '\n');
  if (
    (normalized.startsWith('"') && normalized.endsWith('"')) ||
    (normalized.startsWith("'") && normalized.endsWith("'"))
  ) {
    normalized = normalized
      .slice(1, -1)
      .trim()
      .replace(/\\r?\\n/g, '\n');
  }

  const pkcs1 = normalized.includes('-----BEGIN RSA PRIVATE KEY-----');
  const pkcs8 = normalized.includes('-----BEGIN PRIVATE KEY-----');
  if (!pkcs1 && !pkcs8) {
    throw new Error(
      'GITHUB_PRIVATE_KEY must contain a PKCS#1 RSA PRIVATE KEY or PKCS#8 PRIVATE KEY PEM block.'
    );
  }

  const base64 = normalized
    .replace(/-----BEGIN (?:RSA )?PRIVATE KEY-----/g, '')
    .replace(/-----END (?:RSA )?PRIVATE KEY-----/g, '')
    .replace(/\s/g, '');
  if (!base64 || !/^[A-Za-z0-9+/]+={0,2}$/.test(base64)) {
    throw new Error('GITHUB_PRIVATE_KEY contains invalid PEM data.');
  }

  const keyBytes = decodeBase64(base64);
  if (!pkcs1) return keyBytes;

  // Web Crypto imports private RSA keys as PKCS#8. GitHub App downloads may
  // use the older PKCS#1 container, so wrap that DER payload as PKCS#8.
  return der(
    0x30,
    concat(Uint8Array.of(0x02, 0x01, 0x00), PKCS8_RSA_ALGORITHM, der(0x04, keyBytes))
  );
}

const base64Url = (bytes: Uint8Array): string =>
  btoa(String.fromCharCode(...bytes))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replaceAll('=', '');

export async function createGitHubAppJwt(env: GitHubAppCredentials): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const utf = new TextEncoder();
  const header = base64Url(utf.encode(JSON.stringify({ alg: 'RS256', typ: 'JWT' })));
  const payload = base64Url(
    utf.encode(JSON.stringify({ iat: now - 60, exp: now + 540, iss: env.GITHUB_APP_ID }))
  );
  const key = await crypto.subtle.importKey(
    'pkcs8',
    githubPrivateKeyToPkcs8(env.GITHUB_PRIVATE_KEY),
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const signature = new Uint8Array(
    await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, utf.encode(`${header}.${payload}`))
  );
  return `${header}.${payload}.${base64Url(signature)}`;
}
