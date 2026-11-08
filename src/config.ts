export interface OAuthConfig {
  clientId: string;
  clientSecret: string;
  /** Key material used to seal clients, codes and tokens (at least 32 characters). */
  secret: string;
  scopes: string[];
}

export interface AdminConfig {
  enabled: boolean;
  port: number;
  host: string;
  /** Sets (or resets) the admin password at startup. */
  password?: string;
}

export interface Config {
  port: number;
  host: string;
  /** Public base URL of the server (required for OAuth), e.g. https://mcp.example.com */
  publicUrl?: URL;
  /** When set, clients authenticate with one of these keys instead of passing their Infomaniak token. */
  apiKeys: string[];
  /** Server-side Infomaniak token, only allowed together with apiKeys (or in stdio mode). */
  infomaniakToken?: string;
  /** "Sign in with Infomaniak" for MCP clients; enabled when INFOMANIAK_OAUTH_CLIENT_ID is set. */
  oauth?: OAuthConfig;
  /** Directory holding the SQLite database (and the generated secret key, if any). */
  dataDir: string;
  /** Key encrypting stored Infomaniak tokens; generated into dataDir when unset. */
  secretKey?: string;
  admin: AdminConfig;
  readOnly: boolean;
  allowedHosts?: string[];
  trustProxy?: string;
  maxResponseChars: number;
  baseUrl?: string;
}

/** Scopes requested from Infomaniak by default: the API scopes, minus billing and account-security ones. */
export const DEFAULT_OAUTH_SCOPES = [
  "openid", "profile", "email", "user_info", "accounts",
  "domain:read", "domain:write", "dns:read", "dns:write",
  "drive", "mail", "kchat", "kmeet", "workspace:calendar",
  "public_cloud", "swiss-backup", "video", "vod", "radio",
];

function list(value: string | undefined, separator = /[,\s]+/): string[] {
  return (value ?? "")
    .split(separator)
    .map((v) => v.trim())
    .filter(Boolean);
}

function bool(value: string | undefined): boolean {
  return ["1", "true", "yes", "on"].includes((value ?? "").toLowerCase());
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const allowedHosts = list(env.MCP_ALLOWED_HOSTS);
  const publicUrl = env.PUBLIC_URL ? new URL(env.PUBLIC_URL) : undefined;

  // OAuth fully configured from the environment. Otherwise it can be set up (or completed) in the admin portal,
  // see Settings, which also generates the sealing secret when OAUTH_SECRET is not provided.
  let oauth: OAuthConfig | undefined;
  if (env.INFOMANIAK_OAUTH_CLIENT_ID && env.INFOMANIAK_OAUTH_CLIENT_SECRET && env.OAUTH_SECRET) {
    const scopes = list(env.INFOMANIAK_OAUTH_SCOPES);
    oauth = {
      clientId: env.INFOMANIAK_OAUTH_CLIENT_ID,
      clientSecret: env.INFOMANIAK_OAUTH_CLIENT_SECRET,
      secret: env.OAUTH_SECRET,
      scopes: scopes.length ? scopes : DEFAULT_OAUTH_SCOPES,
    };
  }

  const host = env.HOST ?? "0.0.0.0";
  return {
    port: Number(env.PORT ?? 3000),
    host,
    publicUrl,
    apiKeys: list(env.MCP_API_KEYS, /,/),
    infomaniakToken: env.INFOMANIAK_API_TOKEN || undefined,
    oauth,
    dataDir: env.DATA_DIR ?? "./data",
    secretKey: env.MCP_SECRET_KEY || undefined,
    admin: {
      enabled: env.ADMIN_ENABLED === undefined ? true : bool(env.ADMIN_ENABLED),
      port: Number(env.ADMIN_PORT ?? 9090),
      host: env.ADMIN_HOST ?? host,
      password: env.ADMIN_PASSWORD || undefined,
    },
    readOnly: bool(env.INFOMANIAK_READ_ONLY),
    allowedHosts: allowedHosts.length ? allowedHosts : undefined,
    trustProxy: env.TRUST_PROXY || undefined,
    maxResponseChars: Number(env.MAX_RESPONSE_CHARS ?? 60_000),
    baseUrl: env.INFOMANIAK_API_URL || undefined,
  };
}
