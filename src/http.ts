import { timingSafeEqual } from "node:crypto";
import type { Request, RequestHandler, Response } from "express";
import { getOAuthProtectedResourceMetadataUrl, mcpAuthRouter } from "@modelcontextprotocol/sdk/server/auth/router.js";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { Catalog } from "./catalog.js";
import type { Config } from "./config.js";
import type { InfomaniakClient } from "./infomaniak.js";
import { dynamicTrustProxy } from "./trust-proxy.js";
import { ACCESS_TOKEN_PREFIX, type InfomaniakOAuthProvider } from "./oauth/provider.js";
import { loadOrganisations } from "./organisations.js";
import { type ConnectionContext, createServer } from "./server.js";
import type { EffectiveSettings } from "./settings.js";
import { MCP_TOKEN_PREFIX, type OAuthIdentity, type Store } from "./store/db.js";

export interface HttpAppOptions {
  /** The OAuth provider, or a function returning the current one (it changes when OAuth settings change). */
  oauth?: InfomaniakOAuthProvider | (() => InfomaniakOAuthProvider | undefined);
  /** Runtime settings, read on every request; defaults to the static configuration. */
  settings?: () => EffectiveSettings;
  /** Admin-managed tokens, connections and category settings. */
  store?: Store;
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

function bearer(req: Request): string | undefined {
  const header = req.headers.authorization;
  const m = header?.match(/^Bearer\s+(.+)$/i);
  return m?.[1].trim();
}

/**
 * Resolves the Infomaniak token for a request.
 * - Passthrough mode (no MCP_API_KEYS): the client's bearer token *is* its Infomaniak token.
 * - API key mode: the bearer must be a known key; the Infomaniak token comes from the
 *   X-Infomaniak-Token header, falling back to the server-side INFOMANIAK_API_TOKEN.
 */
export function resolveToken(req: Request, config: Config): { token?: string; error?: string } {
  const presented = bearer(req);
  if (!config.apiKeys.length) {
    return presented ? { token: presented } : { error: "Missing bearer token (your Infomaniak API token)." };
  }
  if (!presented || !config.apiKeys.some((k) => safeEqual(k, presented))) {
    return { error: "Invalid or missing API key." };
  }
  const userToken = req.headers["x-infomaniak-token"];
  const token = (typeof userToken === "string" && userToken.trim()) || config.infomaniakToken;
  return token ? { token } : { error: "No Infomaniak token: send X-Infomaniak-Token or configure INFOMANIAK_API_TOKEN." };
}

export function createHttpApp(
  config: Config,
  catalog: Catalog,
  client: InfomaniakClient,
  { oauth, store, settings }: HttpAppOptions = {},
) {
  const app = createMcpExpressApp({ host: config.host, allowedHosts: config.allowedHosts });
  const current = settings ?? (() => ({ ...config }) satisfies EffectiveSettings);
  app.use(dynamicTrustProxy(app, () => current().trustProxy));

  app.get("/health", (_req, res) => {
    res.json({ status: "ok", operations: catalog.operations.length, catalog: catalog.generatedAt });
  });

  // The OAuth endpoints follow the current settings: the router is rebuilt whenever the provider changes, so
  // OAuth can be switched on, off or reconfigured from the admin portal without restart.
  const currentProvider = typeof oauth === "function" ? oauth : () => oauth;
  let mounted: { provider: InfomaniakOAuthProvider; publicUrl: string; router: RequestHandler; metadataUrl: string } | undefined;
  const currentOAuth = () => {
    const provider = currentProvider();
    const publicUrl = current().publicUrl;
    if (!provider || !publicUrl) return undefined;
    if (mounted?.provider !== provider || mounted.publicUrl !== publicUrl.href) {
      const resourceServerUrl = new URL("/mcp", publicUrl);
      mounted = {
        provider,
        publicUrl: publicUrl.href,
        metadataUrl: getOAuthProtectedResourceMetadataUrl(resourceServerUrl),
        // Serves /authorize, /token, /register, /revoke and the OAuth/protected-resource metadata.
        router: mcpAuthRouter({
          provider,
          issuerUrl: publicUrl,
          resourceServerUrl,
          resourceName: "Infomaniak",
          scopesSupported: current().oauth?.scopes,
          clientRegistrationOptions: { clientIdGeneration: false },
        }),
      };
    }
    return mounted;
  };
  app.use((req, res, next) => {
    const active = currentOAuth();
    if (active) active.router(req, res, next);
    else next();
  });
  app.get("/oauth/callback", (req, res, next) => {
    const active = currentOAuth();
    if (active) void active.provider.handleCallback(req, res);
    else next();
  });

  const unauthorized = (res: Response, message: string, invalidToken = false) => {
    const resourceMetadataUrl = currentOAuth()?.metadataUrl;
    const params = [
      'realm="infomaniak-mcp-server"',
      ...(invalidToken ? ['error="invalid_token"'] : []),
      ...(resourceMetadataUrl ? [`resource_metadata="${resourceMetadataUrl}"`] : []),
    ];
    res.status(401).set("WWW-Authenticate", `Bearer ${params.join(", ")}`).json({
      jsonrpc: "2.0",
      error: { code: -32001, message },
      id: null,
    });
  };

  /** Catalog visible to a request: globally enabled categories, narrowed by the token's own list. */
  const catalogFor = (tokenCategories: string[] | null): Catalog => {
    const disabled = new Set(store?.disabledCategories() ?? []);
    if (!disabled.size && !tokenCategories) return catalog;
    const allowed = (tokenCategories ?? catalog.categories().map((c) => c.name)).filter((c) => !disabled.has(c));
    return catalog.restrict(allowed);
  };

  app.post("/mcp", async (req: Request, res: Response) => {
    let connections: ConnectionContext[];
    const { readOnly: globalReadOnly, maxResponseChars } = current();
    const provider = currentOAuth()?.provider;
    let readOnly = globalReadOnly;
    let tokenCategories: string[] | null = null;
    const presented = bearer(req);
    if (store && presented?.startsWith(MCP_TOKEN_PREFIX)) {
      try {
        const grant = store.authenticateToken(presented, req.ip);
        connections = grant.connections;
        readOnly ||= grant.readOnly;
        tokenCategories = grant.categories;
      } catch (err) {
        unauthorized(res, (err as Error).message, true);
        return;
      }
    } else if (provider && presented?.startsWith(ACCESS_TOKEN_PREFIX)) {
      try {
        const { extra } = await provider.verifyAccessToken(presented);
        const token = extra?.infomaniakToken as string;
        const identity = extra?.identity as OAuthIdentity | undefined;
        if (store) {
          // The admin's OAuth rules decide which shared connections this user gets, on every request.
          let grant;
          try {
            grant = store.authorizeOAuth(identity, token);
          } catch (err) {
            res.status(403).json({ jsonrpc: "2.0", error: { code: -32003, message: (err as Error).message }, id: null });
            return;
          }
          connections = grant.connections;
          readOnly ||= grant.readOnly;
          tokenCategories = grant.categories;
        } else {
          connections = [{ name: "infomaniak", token }];
        }
      } catch {
        unauthorized(res, "Invalid or expired access token.", true);
        return;
      }
    } else if (provider && !presented) {
      unauthorized(res, "Authentication required: sign in with Infomaniak.");
      return;
    } else {
      const resolved = resolveToken(req, config);
      if (!resolved.token) {
        unauthorized(res, resolved.error ?? "Unauthorized.");
        return;
      }
      connections = [{ name: "infomaniak", token: resolved.token }];
    }

    // Stateless: one server/transport per request, so the server scales horizontally. Organisations are cached
    // per token for a few minutes, so listing them in the tool schemas costs one API call per connection at most.
    const server = createServer({
      catalog: catalogFor(tokenCategories),
      client,
      connections,
      organisations: await loadOrganisations(client, connections),
      readOnly,
      maxResponseChars,
    });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on("close", () => {
      void transport.close();
      void server.close();
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      console.error("MCP request failed:", err);
      if (!res.headersSent) {
        res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: "Internal server error" }, id: null });
      }
    }
  });

  const methodNotAllowed = (_req: Request, res: Response) => {
    res.status(405).set("Allow", "POST").json({
      jsonrpc: "2.0",
      error: { code: -32000, message: "Method not allowed: this server is stateless, use POST." },
      id: null,
    });
  };
  app.get("/mcp", methodNotAllowed);
  app.delete("/mcp", methodNotAllowed);

  return app;
}
