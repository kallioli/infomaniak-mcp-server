import { createHash, randomBytes } from "node:crypto";
import type { Request, Response } from "express";
import type { OAuthRegisteredClientsStore } from "@modelcontextprotocol/sdk/server/auth/clients.js";
import { InvalidGrantError, InvalidTokenError, ServerError } from "@modelcontextprotocol/sdk/server/auth/errors.js";
import type { AuthorizationParams, OAuthServerProvider } from "@modelcontextprotocol/sdk/server/auth/provider.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import type { OAuthClientInformationFull, OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";
import type { OAuthIdentity } from "../store/db.js";
import { Sealer } from "./seal.js";

/** Prefix of access tokens issued by this server, to tell them apart from raw Infomaniak API tokens. */
export const ACCESS_TOKEN_PREFIX = "imcp_";

const PENDING_TTL = 10 * 60;
const CODE_TTL = 5 * 60;
/** A refresh token unused this long expires; each refresh issues a new one. */
const REFRESH_TTL = 90 * 24 * 3600;
/** How long a browser remembers the clients the user approved, and how many. */
const CONSENT_TTL = 90 * 24 * 3600;
const MAX_REMEMBERED_CLIENTS = 20;

export interface InfomaniakOAuthOptions {
  secret: string;
  clientId: string;
  clientSecret: string;
  /** Public base URL of this server, e.g. https://mcp.example.com */
  publicUrl: URL;
  scopes: string[];
  authorizeUrl?: string;
  tokenUrl?: string;
  userinfoUrl?: string;
  /**
   * Called once the user has signed in at Infomaniak; returning a message refuses the login (e.g. no admin rule
   * grants access). Runs again on every MCP request through the store, this only gives early feedback.
   */
  authorizeLogin?: (identity: OAuthIdentity | undefined) => string | undefined;
  fetch?: typeof fetch;
}

interface UpstreamTokens {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
}

interface PendingAuthorization {
  cid: string;
  redirectUri: string;
  state?: string;
  codeChallenge: string;
  verifier: string;
  /** Random value also set as a cookie: the authorization can only be approved and completed in this browser. */
  nonce: string;
  /** Shown on the consent page. */
  clientName?: string;
}

interface AuthorizationCode {
  cid: string;
  redirectUri: string;
  codeChallenge: string;
  upstream: UpstreamTokens;
  identity?: OAuthIdentity;
}

interface SealedToken {
  cid: string;
  token: string;
  /** Who signed in, so that every MCP request can be matched against the admin's OAuth rules. */
  identity?: OAuthIdentity;
}

function base64urlSha256(value: string): string {
  return createHash("sha256").update(value).digest("base64url");
}

function readCookie(req: Request, name: string): string | undefined {
  for (const part of (req.headers.cookie ?? "").split(";")) {
    const [key, ...value] = part.trim().split("=");
    if (key === name) return decodeURIComponent(value.join("="));
  }
  return undefined;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

/**
 * OAuth authorization server for MCP clients, backed by Infomaniak's login.
 *
 * Infomaniak has no dynamic client registration and only accepts confidential clients,
 * while MCP clients (Claude, etc.) register themselves dynamically and use PKCE. This
 * provider bridges the two: MCP clients register and authorize against this server, which
 * sends the user to login.infomaniak.com with its own OAuth application, then hands back
 * its own tokens wrapping the Infomaniak ones. Everything is sealed, nothing is stored.
 */
export class InfomaniakOAuthProvider implements OAuthServerProvider {
  readonly callbackUrl: URL;
  private readonly sealer: Sealer;
  private readonly authorizeUrl: string;
  private readonly tokenUrl: string;
  private readonly userinfoUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: InfomaniakOAuthOptions) {
    this.sealer = new Sealer(options.secret);
    this.callbackUrl = new URL("/oauth/callback", options.publicUrl);
    this.authorizeUrl = options.authorizeUrl ?? "https://login.infomaniak.com/authorize";
    this.tokenUrl = options.tokenUrl ?? "https://login.infomaniak.com/token";
    this.userinfoUrl = options.userinfoUrl ?? "https://login.infomaniak.com/oauth2/userinfo";
    this.fetchImpl = options.fetch ?? fetch;
  }

  /** Clients are not stored: the client_id is the sealed registration itself. */
  get clientsStore(): OAuthRegisteredClientsStore {
    return {
      getClient: (clientId) => {
        const payload = this.sealer.open<Omit<OAuthClientInformationFull, "client_id">>("client", clientId);
        if (!payload) return undefined;
        const { typ: _typ, exp: _exp, ...client } = payload as typeof payload & { typ?: string };
        return { ...client, client_id: clientId };
      },
      registerClient: (client) => {
        const issuedAt = Math.floor(Date.now() / 1000);
        const clientId = this.sealer.seal("client", { ...client, client_id_issued_at: issuedAt });
        return { ...client, client_id: clientId, client_id_issued_at: issuedAt };
      },
    };
  }

  /**
   * Any client can register itself with any redirect URI, while Infomaniak only sees this server's own application.
   * So before sending the user to Infomaniak, the server asks them to approve the client that will receive the access
   * (MCP "confused deputy" protection), unless this browser already approved it. The approval and the callback are
   * bound to the browser by a cookie, so a link to a flow started elsewhere cannot be completed by the victim.
   */
  async authorize(client: OAuthClientInformationFull, params: AuthorizationParams, res: Response): Promise<void> {
    const nonce = readCookie(res.req, this.cookies.nonce) || randomBytes(16).toString("base64url");
    res.cookie(this.cookies.nonce, nonce, this.cookieOptions(PENDING_TTL));
    const pending: PendingAuthorization = {
      cid: base64urlSha256(client.client_id),
      redirectUri: params.redirectUri,
      state: params.state,
      codeChallenge: params.codeChallenge,
      verifier: randomBytes(32).toString("base64url"),
      nonce,
      clientName: client.client_name,
    };
    if (this.approvedClients(res.req).includes(pending.cid)) {
      this.redirectToInfomaniak(res, pending);
      return;
    }
    this.consentPage(res, pending);
  }

  /** Express handler for POST /oauth/consent, the answer to the consent page. */
  readonly handleConsent = (req: Request, res: Response): void => {
    const { request, decision } = (req.body ?? {}) as Record<string, string | undefined>;
    const pending = request ? this.sealer.open<PendingAuthorization>("consent", request) : undefined;
    if (!pending || readCookie(req, this.cookies.nonce) !== pending.nonce) {
      console.warn("OAuth consent with an invalid, expired or foreign request");
      res.status(400).type("text/plain").send("Invalid or expired authorization request. Please start the connection again.");
      return;
    }
    if (decision !== "approve") {
      const back = new URL(pending.redirectUri);
      if (pending.state) back.searchParams.set("state", pending.state);
      back.searchParams.set("error", "access_denied");
      back.searchParams.set("error_description", "The user did not allow this application.");
      res.redirect(303, back.href);
      return;
    }
    const approved = [pending.cid, ...this.approvedClients(req).filter((c) => c !== pending.cid)].slice(0, MAX_REMEMBERED_CLIENTS);
    res.cookie(this.cookies.consents, this.sealer.seal("consents", { cids: approved }, CONSENT_TTL), this.cookieOptions(CONSENT_TTL));
    this.redirectToInfomaniak(res, pending, 303);
  };

  private get cookies() {
    // __Host- cookies need HTTPS; plain names keep local http:// setups working.
    const prefix = this.options.publicUrl.protocol === "https:" ? "__Host-" : "";
    return { nonce: `${prefix}imcp-oauth`, consents: `${prefix}imcp-consents` };
  }

  private cookieOptions(maxAgeSeconds: number) {
    return {
      httpOnly: true,
      // Lax: the cookie must come back with the top-level redirect from login.infomaniak.com.
      sameSite: "lax" as const,
      secure: this.options.publicUrl.protocol === "https:",
      path: "/",
      maxAge: maxAgeSeconds * 1000,
    };
  }

  private approvedClients(req: Request): string[] {
    const value = readCookie(req, this.cookies.consents);
    return (value && this.sealer.open<{ cids: string[] }>("consents", value)?.cids) || [];
  }

  private redirectToInfomaniak(res: Response, pending: PendingAuthorization, status = 302): void {
    const url = new URL(this.authorizeUrl);
    url.search = new URLSearchParams({
      response_type: "code",
      client_id: this.options.clientId,
      redirect_uri: this.callbackUrl.href,
      scope: this.options.scopes.join(" "),
      state: this.sealer.seal("pending", pending, PENDING_TTL),
      code_challenge: base64urlSha256(pending.verifier),
      code_challenge_method: "S256",
      access_type: "offline",
    }).toString();
    res.redirect(status, url.href);
  }

  private consentPage(res: Response, pending: PendingAuthorization): void {
    const name = escapeHtml(pending.clientName?.trim() || "An application");
    const host = escapeHtml(new URL(pending.redirectUri).host || pending.redirectUri);
    const request = escapeHtml(this.sealer.seal("consent", pending, PENDING_TTL));
    res
      .status(200)
      .set({
        "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; img-src 'self'; form-action 'self'; frame-ancestors 'none'",
        "X-Frame-Options": "DENY",
        "Cache-Control": "no-store",
        "Referrer-Policy": "no-referrer",
      })
      .type("html")
      .send(`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Allow access — Infomaniak MCP Server</title>
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<style>
body{font-family:system-ui,sans-serif;background:#f5f7fb;color:#1c2333;margin:0;display:grid;place-items:center;min-height:100vh}
main{background:#fff;border-radius:12px;box-shadow:0 2px 12px #0001;padding:32px;max-width:440px;margin:16px}
h1{font-size:1.25rem;margin:16px 0 8px}p{line-height:1.5}code{background:#eef1f6;padding:2px 6px;border-radius:4px}
.actions{display:flex;gap:12px;margin-top:24px}button{flex:1;padding:10px;border-radius:8px;border:1px solid #c9d1de;font-size:1rem;cursor:pointer}
button[value=approve]{background:#0098ff;border-color:#0098ff;color:#fff}
</style>
</head>
<body>
<main>
<img src="/favicon.svg" width="48" height="48" alt="">
<h1>Allow ${name} to use Infomaniak?</h1>
<p><strong>${name}</strong> asks to act on your Infomaniak account through this MCP server. You will sign in with
Infomaniak next, then access is sent to <code>${host}</code>.</p>
<p>Only continue if you started this connection yourself from that application.</p>
<form method="post" action="/oauth/consent">
<input type="hidden" name="request" value="${request}">
<div class="actions"><button name="decision" value="deny">Cancel</button><button name="decision" value="approve">Allow</button></div>
</form>
</main>
</body>
</html>
`);
  }

  /** Express handler for GET /oauth/callback, where Infomaniak sends the user back. */
  readonly handleCallback = async (req: Request, res: Response): Promise<void> => {
    const { code, state, error, error_description: description } = req.query as Record<string, string | undefined>;
    const pending = state ? this.sealer.open<PendingAuthorization>("pending", state) : undefined;
    if (!pending) {
      console.warn(`OAuth callback with an invalid or expired state${error ? ` (Infomaniak error: ${quote(error)} ${quote(description)})` : ""}`);
      res.status(400).type("text/plain").send("Invalid or expired authorization request. Please start the connection again.");
      return;
    }
    if (readCookie(req, this.cookies.nonce) !== pending.nonce) {
      // Started in another browser: completing it here would hand this user's access to whoever started it.
      console.warn("OAuth callback from a browser that did not start the authorization");
      res.status(400).type("text/plain").send("This sign-in was not started from this browser. Please start the connection again.");
      return;
    }
    const back = new URL(pending.redirectUri);
    if (pending.state) back.searchParams.set("state", pending.state);

    if (error || !code) {
      console.warn(`Infomaniak OAuth authorization failed: ${error ? `${quote(error)} ${quote(description)}` : "no code returned"}`);
      back.searchParams.set("error", error === "access_denied" ? "access_denied" : "server_error");
      if (description) back.searchParams.set("error_description", description.slice(0, 500));
      res.redirect(302, back.href);
      return;
    }
    try {
      const upstream = await this.requestUpstream({
        grant_type: "authorization_code",
        code,
        redirect_uri: this.callbackUrl.href,
        code_verifier: pending.verifier,
      });
      const identity = await this.fetchIdentity(upstream.access_token);
      const refusal = this.options.authorizeLogin?.(identity);
      if (refusal) {
        console.warn(`OAuth login refused for Infomaniak user ${quote(identity?.sub)}: ${refusal}`);
        back.searchParams.set("error", "access_denied");
        back.searchParams.set("error_description", refusal);
        res.redirect(302, back.href);
        return;
      }
      const authorizationCode: AuthorizationCode = {
        cid: pending.cid,
        redirectUri: pending.redirectUri,
        codeChallenge: pending.codeChallenge,
        upstream,
        identity,
      };
      back.searchParams.set("code", this.sealer.seal("code", authorizationCode, CODE_TTL));
    } catch (err) {
      console.error(`Infomaniak code exchange failed: ${(err as Error).message}`);
      back.searchParams.set("error", "server_error");
    }
    res.redirect(302, back.href);
  };

  async challengeForAuthorizationCode(client: OAuthClientInformationFull, authorizationCode: string): Promise<string> {
    return this.openCode(client, authorizationCode).codeChallenge;
  }

  async exchangeAuthorizationCode(
    client: OAuthClientInformationFull,
    authorizationCode: string,
    _codeVerifier?: string,
    redirectUri?: string,
  ): Promise<OAuthTokens> {
    const code = this.openCode(client, authorizationCode);
    if (redirectUri && redirectUri !== code.redirectUri) {
      throw new InvalidGrantError("redirect_uri does not match the authorization request");
    }
    return this.issueTokens(client, code.upstream, code.identity);
  }

  async exchangeRefreshToken(client: OAuthClientInformationFull, refreshToken: string): Promise<OAuthTokens> {
    const sealed = this.sealer.open<SealedToken>("refresh", refreshToken);
    if (!sealed || sealed.cid !== base64urlSha256(client.client_id)) {
      throw new InvalidGrantError("Invalid refresh token");
    }
    let upstream: UpstreamTokens;
    try {
      upstream = await this.requestUpstream({ grant_type: "refresh_token", refresh_token: sealed.token });
    } catch (err) {
      console.warn(`Infomaniak refresh token exchange failed: ${(err as Error).message}`);
      throw new InvalidGrantError(`Infomaniak refused the refresh token: ${(err as Error).message}`);
    }
    // Infomaniak may or may not rotate refresh tokens; keep the previous one if none is returned.
    return this.issueTokens(client, { ...upstream, refresh_token: upstream.refresh_token ?? sealed.token }, sealed.identity);
  }

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    const sealed = token.startsWith(ACCESS_TOKEN_PREFIX)
      ? this.sealer.open<SealedToken>("access", token.slice(ACCESS_TOKEN_PREFIX.length))
      : undefined;
    if (!sealed) throw new InvalidTokenError("Invalid or expired access token");
    return {
      token,
      clientId: sealed.cid,
      scopes: this.options.scopes,
      expiresAt: sealed.exp,
      extra: { infomaniakToken: sealed.token, identity: sealed.identity },
    };
  }

  private openCode(client: OAuthClientInformationFull, authorizationCode: string): AuthorizationCode {
    const code = this.sealer.open<AuthorizationCode>("code", authorizationCode);
    if (!code || code.cid !== base64urlSha256(client.client_id)) {
      throw new InvalidGrantError("Invalid or expired authorization code");
    }
    return code;
  }

  private issueTokens(client: OAuthClientInformationFull, upstream: UpstreamTokens, identity?: OAuthIdentity): OAuthTokens {
    const cid = base64urlSha256(client.client_id);
    const expiresIn = upstream.expires_in ?? 3600;
    return {
      access_token:
        ACCESS_TOKEN_PREFIX +
        this.sealer.seal("access", { cid, token: upstream.access_token, identity } satisfies SealedToken, expiresIn),
      token_type: "Bearer",
      expires_in: expiresIn,
      ...(upstream.refresh_token
        ? { refresh_token: this.sealer.seal("refresh", { cid, token: upstream.refresh_token, identity } satisfies SealedToken, REFRESH_TTL) }
        : {}),
      scope: this.options.scopes.join(" "),
    };
  }

  /** The signed-in user, from the OpenID Connect userinfo endpoint (needs the openid and email scopes). */
  private async fetchIdentity(accessToken: string): Promise<OAuthIdentity | undefined> {
    try {
      const res = await this.fetchImpl(this.userinfoUrl, {
        headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" },
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) {
        console.warn(`Infomaniak userinfo request failed: HTTP ${res.status} ${quote(await res.text().catch(() => ""))}`);
        return undefined;
      }
      const info = (await res.json()) as { sub?: unknown; email?: unknown; email_verified?: unknown; name?: unknown };
      if (info.sub === undefined || info.sub === null) {
        console.warn("Infomaniak userinfo response has no sub (is the openid scope granted?)");
        return undefined;
      }
      return {
        sub: String(info.sub),
        ...(typeof info.email === "string" ? { email: info.email } : {}),
        ...(typeof info.email_verified === "boolean" ? { emailVerified: info.email_verified } : {}),
        ...(typeof info.name === "string" ? { name: info.name } : {}),
      };
    } catch (err) {
      console.warn(`Infomaniak userinfo request failed: ${(err as Error).message}`);
      return undefined;
    }
  }

  private async requestUpstream(params: Record<string, string>): Promise<UpstreamTokens> {
    const res = await this.fetchImpl(this.tokenUrl, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body: new URLSearchParams({
        ...params,
        client_id: this.options.clientId,
        client_secret: this.options.clientSecret,
      }).toString(),
      signal: AbortSignal.timeout(15_000),
    });
    const body = (await res.json().catch(() => ({}))) as Partial<UpstreamTokens> & { error?: string; error_description?: string };
    if (!res.ok || !body.access_token) {
      throw new ServerError(`HTTP ${res.status} ${quote(body.error)} ${quote(body.error_description)}`.trim());
    }
    return { access_token: body.access_token, refresh_token: body.refresh_token, expires_in: body.expires_in };
  }
}

/** Upstream values in logs are quoted and truncated so they cannot forge log lines. */
function quote(value: unknown): string {
  if (value === undefined || value === null || value === "") return "";
  return JSON.stringify(String(value).slice(0, 300));
}
