import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** An opaque, unguessable token for URLs and headers. */
export function newToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

/** Tokens are stored only as hashes, so a copy of the database grants nothing. */
export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('base64url');
}

export function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

/** S256 PKCE check: base64url(sha256(verifier)) == challenge. */
export function pkceMatches(verifier: string, challenge: string): boolean {
  return safeEqual(createHash('sha256').update(verifier).digest('base64url'), challenge);
}

/** AES-256-GCM sealing of the Immich API keys at rest. */
export class SecretBox {
  private readonly key: Buffer;

  constructor(key: Buffer) {
    if (key.length !== 32) throw new Error('encryption key must be 32 bytes');
    this.key = key;
  }

  static fromBase64(value: string): SecretBox {
    return new SecretBox(Buffer.from(value, 'base64'));
  }

  /** Uses the configured key, or a key file in the data directory, created on first start. */
  static load(dataDir: string, configured?: string): SecretBox {
    if (configured) return SecretBox.fromBase64(configured);
    mkdirSync(dataDir, { recursive: true });
    const file = join(dataDir, 'encryption.key');
    if (!existsSync(file)) {
      writeFileSync(file, randomBytes(32).toString('base64') + '\n', { mode: 0o600 });
    }
    chmodSync(file, 0o600);
    return SecretBox.fromBase64(readFileSync(file, 'utf8').trim());
  }

  seal(plaintext: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const body = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    return [
      'v1',
      iv.toString('base64url'),
      cipher.getAuthTag().toString('base64url'),
      body.toString('base64url'),
    ].join('.');
  }

  open(sealed: string): string {
    const [version, iv, tag, body] = sealed.split('.');
    if (version !== 'v1' || !iv || !tag || body === undefined) throw new Error('unrecognised sealed value');
    const decipher = createDecipheriv('aes-256-gcm', this.key, Buffer.from(iv, 'base64url'));
    decipher.setAuthTag(Buffer.from(tag, 'base64url'));
    return Buffer.concat([decipher.update(Buffer.from(body, 'base64url')), decipher.final()]).toString(
      'utf8',
    );
  }
}
