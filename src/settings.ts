import { randomBytes } from "node:crypto";
import { type Config, DEFAULT_OAUTH_SCOPES, type OAuthConfig } from "./config.js";
import { type Store, ValidationError } from "./store/db.js";

/** Settings that can change at runtime; every consumer reads them per request. */
export interface EffectiveSettings {
  publicUrl?: URL;
  trustProxy?: string;
  readOnly: boolean;
  maxResponseChars: number;
  /** Set when OAuth is fully configured (client id, client secret and public URL). */
  oauth?: OAuthConfig;
}

/** Editable settings, as shown to and sent by the admin portal. */
export interface SettingsValues {
  publicUrl: string | null;
  trustProxy: string | null;
  readOnly: boolean;
  maxResponseChars: number;
  oauthClientId: string | null;
  oauthScopes: string[];
}

export type SettingKey = keyof SettingsValues | "oauthClientSecret";

/** Environment variable taking precedence over each setting (the setting is then locked in the portal). */
const ENV_VARS: Record<SettingKey, string> = {
  publicUrl: "PUBLIC_URL",
  trustProxy: "TRUST_PROXY",
  readOnly: "INFOMANIAK_READ_ONLY",
  maxResponseChars: "MAX_RESPONSE_CHARS",
  oauthClientId: "INFOMANIAK_OAUTH_CLIENT_ID",
  oauthClientSecret: "INFOMANIAK_OAUTH_CLIENT_SECRET",
  oauthScopes: "INFOMANIAK_OAUTH_SCOPES",
};

export interface SettingsView {
  values: SettingsValues;
  oauthClientSecretSet: boolean;
  /** Variable name for settings fixed by the environment. */
  locked: Partial<Record<SettingKey, string>>;
  defaults: { oauthScopes: string[]; maxResponseChars: number };
  /** Redirect URI to register in the Infomaniak OAuth application. */
  callbackUrl: string | null;
  oauthActive: boolean;
  setupCompleted: boolean;
}

export type SettingsPatch = Partial<Omit<SettingsValues, "oauthScopes">> & {
  oauthScopes?: string[] | null;
  oauthClientSecret?: string | null;
};

const DEFAULT_MAX_RESPONSE_CHARS = 60_000;

/** Origin of a public URL; https is required except for local testing. */
export function normalizePublicUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new ValidationError("The public URL is not a valid URL.");
  }
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (url.protocol !== "https:" && !(local && url.protocol === "http:")) {
    throw new ValidationError("The public URL must use https (http is only accepted for localhost).");
  }
  if (url.pathname !== "/" || url.search) {
    throw new ValidationError("The public URL must be an origin without path, e.g. https://mcp.example.com.");
  }
  return url.origin;
}

/**
 * Runtime settings: the environment wins, then the database (set through the admin portal), then defaults.
 * Changes made in the portal apply without restart.
 */
export class Settings {
  constructor(
    private readonly config: Config,
    private readonly store: Store,
    private readonly env: NodeJS.ProcessEnv = process.env,
  ) {}

  private fromEnv(key: SettingKey): boolean {
    return Boolean(this.env[ENV_VARS[key]]);
  }

  locked(): Partial<Record<SettingKey, string>> {
    return Object.fromEntries(
      (Object.keys(ENV_VARS) as SettingKey[]).filter((k) => this.fromEnv(k)).map((k) => [k, ENV_VARS[k]]),
    );
  }

  values(): SettingsValues {
    const db = <T>(key: string, fallback: T) => this.store.getSetting<T>(`settings.${key}`, fallback);
    return {
      publicUrl: this.fromEnv("publicUrl") ? (this.config.publicUrl?.origin ?? null) : db<string | null>("publicUrl", null),
      trustProxy: this.fromEnv("trustProxy") ? (this.config.trustProxy ?? null) : db<string | null>("trustProxy", null),
      readOnly: this.fromEnv("readOnly") ? this.config.readOnly : db("readOnly", false),
      maxResponseChars: this.fromEnv("maxResponseChars")
        ? this.config.maxResponseChars
        : db("maxResponseChars", DEFAULT_MAX_RESPONSE_CHARS),
      oauthClientId: this.fromEnv("oauthClientId") ? (this.env.INFOMANIAK_OAUTH_CLIENT_ID ?? null) : db<string | null>("oauthClientId", null),
      oauthScopes: this.fromEnv("oauthScopes")
        ? this.env.INFOMANIAK_OAUTH_SCOPES!.split(/[,\s]+/).filter(Boolean)
        : db<string[] | null>("oauthScopes", null) ?? DEFAULT_OAUTH_SCOPES,
    };
  }

  private oauthClientSecret(): string | undefined {
    if (this.fromEnv("oauthClientSecret")) return this.env.INFOMANIAK_OAUTH_CLIENT_SECRET;
    return this.store.getSecretSetting("settings.oauthClientSecret");
  }

  /** Key sealing OAuth clients and tokens: OAUTH_SECRET, or one generated once and kept (encrypted) in the database. */
  private oauthSealSecret(): string {
    if (this.env.OAUTH_SECRET) return this.env.OAUTH_SECRET;
    let secret = this.store.getSecretSetting("settings.oauthSealSecret");
    if (!secret) {
      secret = randomBytes(48).toString("base64url");
      this.store.setSecretSetting("settings.oauthSealSecret", secret);
    }
    return secret;
  }

  effective(): EffectiveSettings {
    const v = this.values();
    const publicUrl = v.publicUrl ? new URL(v.publicUrl) : undefined;
    const clientSecret = this.oauthClientSecret();
    return {
      publicUrl,
      trustProxy: v.trustProxy ?? undefined,
      readOnly: v.readOnly,
      maxResponseChars: v.maxResponseChars,
      oauth:
        publicUrl && v.oauthClientId && clientSecret
          ? { clientId: v.oauthClientId, clientSecret, secret: this.oauthSealSecret(), scopes: v.oauthScopes }
          : undefined,
    };
  }

  view(): SettingsView {
    const values = this.values();
    const effective = this.effective();
    return {
      values,
      oauthClientSecretSet: Boolean(this.oauthClientSecret()),
      locked: this.locked(),
      defaults: { oauthScopes: DEFAULT_OAUTH_SCOPES, maxResponseChars: DEFAULT_MAX_RESPONSE_CHARS },
      callbackUrl: values.publicUrl ? new URL("/oauth/callback", values.publicUrl).href : null,
      oauthActive: Boolean(effective.oauth),
      setupCompleted: this.setupCompleted(),
    };
  }

  update(patch: SettingsPatch): SettingsView {
    const locked = this.locked();
    const lockedKeys = (Object.keys(patch) as SettingKey[]).filter((k) => patch[k as keyof SettingsPatch] !== undefined && locked[k]);
    if (lockedKeys.length) {
      throw new ValidationError(`Set by environment variables: ${lockedKeys.map((k) => locked[k]).join(", ")}.`);
    }

    // Validate everything before writing anything.
    const writes: [string, unknown][] = [];
    if (patch.publicUrl !== undefined) writes.push(["publicUrl", patch.publicUrl ? normalizePublicUrl(patch.publicUrl) : null]);
    if (patch.trustProxy !== undefined) {
      const value = patch.trustProxy?.trim() || null;
      if (value && !/^[\w.,:/\s-]{1,200}$/.test(value)) throw new ValidationError("Invalid trust proxy value.");
      writes.push(["trustProxy", value]);
    }
    if (patch.readOnly !== undefined) writes.push(["readOnly", Boolean(patch.readOnly)]);
    if (patch.maxResponseChars !== undefined) {
      const n = Number(patch.maxResponseChars);
      if (!Number.isInteger(n) || n < 1_000 || n > 1_000_000) {
        throw new ValidationError("The response size limit must be between 1,000 and 1,000,000 characters.");
      }
      writes.push(["maxResponseChars", n]);
    }
    if (patch.oauthClientId !== undefined) writes.push(["oauthClientId", patch.oauthClientId?.trim() || null]);
    if (patch.oauthScopes !== undefined) {
      const scopes = patch.oauthScopes?.map((s) => s.trim()).filter(Boolean) ?? null;
      if (scopes?.some((s) => !/^[\w:.-]+$/.test(s))) throw new ValidationError("Invalid OAuth scope.");
      writes.push(["oauthScopes", scopes?.length ? [...new Set(scopes)] : null]);
    }

    for (const [key, value] of writes) this.store.setSetting(`settings.${key}`, value);
    if (patch.oauthClientSecret !== undefined) {
      const secret = patch.oauthClientSecret?.trim();
      if (secret) this.store.setSecretSetting("settings.oauthClientSecret", secret);
      else this.store.deleteSetting("settings.oauthClientSecret");
    }
    return this.view();
  }

  setupCompleted(): boolean {
    return this.store.getSetting("setup_completed", false);
  }

  completeSetup(): void {
    this.store.setSetting("setup_completed", true);
  }
}
