export interface LastCheck {
  at: number;
  ok: boolean;
  detail: string;
}

export interface Connection {
  id: string;
  name: string;
  description: string;
  readOnly: boolean;
  defaultAccountId: number | null;
  tokenHint: string;
  createdAt: number;
  updatedAt: number;
  lastCheck?: LastCheck;
  tokenCount: number;
}

/** An Infomaniak organisation ("account") reachable with a connection's token. */
export interface Organisation {
  id: number;
  name: string;
}

export type TokenStatus = "active" | "expired" | "revoked";

export interface McpToken {
  id: string;
  name: string;
  tokenPrefix: string;
  connectionIds: string[];
  defaultConnectionId: string;
  connections: { id: string; name: string | null }[];
  readOnly: boolean;
  allowedIps: string[];
  categories: string[] | null;
  expiresAt: number | null;
  createdAt: number;
  lastUsedAt: number | null;
  lastUsedIp: string | null;
  revokedAt: number | null;
  status: TokenStatus;
}

export interface Category {
  name: string;
  count: number;
  enabled: boolean;
  tags: { tag: string; count: number }[];
}

export interface Dashboard {
  version: string;
  uptimeSeconds: number;
  mcpUrl: string;
  catalog: { operations: number; generatedAt: string };
  categories: { total: number; enabled: number };
  connections: { id: string; name: string; lastCheck?: LastCheck }[];
  tokens: { active: number; expired: number; revoked: number };
  auth: { managedTokens: boolean; oauth: boolean; passthrough: boolean; apiKeys: boolean };
  readOnly: boolean;
}

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

/** Called when the session has expired, so the app can show the login screen. */
let onUnauthorized: () => void = () => {};
export function setUnauthorizedHandler(handler: () => void) {
  onUnauthorized = handler;
}

export async function api<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`/api${path}`, {
    method,
    credentials: "same-origin",
    headers: {
      "Content-Type": "application/json",
      "X-Requested-With": "infomaniak-mcp-admin",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (res.status === 204) return undefined as T;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (res.status === 401 && !path.startsWith("/auth/")) onUnauthorized();
    throw new ApiError(data.error ?? `HTTP error ${res.status}`, res.status);
  }
  return data as T;
}

export type OAuthMatchType = "user" | "email" | "domain";

export interface OAuthRule {
  id: string;
  name: string;
  matchType: OAuthMatchType;
  matchValue: string;
  connectionIds: string[];
  defaultConnectionId: string | null;
  connections: { id: string; name: string | null }[];
  includePersonal: boolean;
  readOnly: boolean;
  categories: string[] | null;
  enabled: boolean;
  createdAt: number;
  lastUsedAt: number | null;
}

export interface OAuthIdentity {
  sub: string;
  email?: string;
  emailVerified?: boolean;
  name?: string;
  lastSeenAt: number;
  ruleId: string | null;
  ruleName: string | null;
}

export interface OAuthOverview {
  enabled: boolean;
  defaultPolicy: "personal" | "deny";
  rules: OAuthRule[];
  identities: OAuthIdentity[];
}

export interface AuthState {
  authenticated: boolean;
  needsSetup: boolean;
  setupCompleted: boolean;
}

export interface SettingsValues {
  publicUrl: string | null;
  trustProxy: string | null;
  readOnly: boolean;
  maxResponseChars: number;
  oauthClientId: string | null;
  oauthScopes: string[];
}

export type SettingKey = keyof SettingsValues | "oauthClientSecret";

export interface SettingsView {
  values: SettingsValues;
  oauthClientSecretSet: boolean;
  locked: Partial<Record<SettingKey, string>>;
  defaults: { oauthScopes: string[]; maxResponseChars: number };
  callbackUrl: string | null;
  oauthActive: boolean;
  setupCompleted: boolean;
}

export type SettingsPatch = Partial<Omit<SettingsValues, "oauthScopes">> & {
  oauthScopes?: string[] | null;
  oauthClientSecret?: string | null;
};
