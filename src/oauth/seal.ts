import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";

/**
 * Authenticated encryption (AES-256-GCM) of small JSON payloads.
 *
 * The OAuth layer is stateless: registered clients, pending authorizations, codes and
 * tokens are all sealed blobs that only this server (holder of the secret) can open.
 * Every blob carries a `typ` so that, say, an authorization code can never be replayed
 * as an access token, and an optional expiry.
 */
export class Sealer {
  private readonly key: Buffer;

  constructor(secret: string) {
    if (secret.length < 32) throw new Error("OAUTH_SECRET must be at least 32 characters long.");
    this.key = Buffer.from(hkdfSync("sha256", secret, "infomaniak-mcp-server", "oauth-seal-v1", 32));
  }

  seal(typ: string, payload: object, ttlSeconds?: number): string {
    const body = JSON.stringify({
      ...payload,
      typ,
      ...(ttlSeconds ? { exp: Math.floor(Date.now() / 1000) + ttlSeconds } : {}),
    });
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv);
    const encrypted = Buffer.concat([cipher.update(body, "utf8"), cipher.final()]);
    return Buffer.concat([iv, encrypted, cipher.getAuthTag()]).toString("base64url");
  }

  /** Returns the payload, or undefined if the blob is forged, of another type, or expired. */
  open<T extends object>(typ: string, token: string): (T & { exp?: number }) | undefined {
    try {
      const raw = Buffer.from(token, "base64url");
      if (raw.length < 29) return undefined;
      const decipher = createDecipheriv("aes-256-gcm", this.key, raw.subarray(0, 12));
      decipher.setAuthTag(raw.subarray(raw.length - 16));
      const body = Buffer.concat([decipher.update(raw.subarray(12, raw.length - 16)), decipher.final()]);
      const payload = JSON.parse(body.toString("utf8"));
      if (payload.typ !== typ) return undefined;
      if (payload.exp && payload.exp < Date.now() / 1000) return undefined;
      return payload;
    } catch {
      return undefined;
    }
  }
}
