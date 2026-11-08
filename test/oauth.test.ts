import { createHash, randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Catalog } from "../src/catalog.js";
import { loadConfig } from "../src/config.js";
import { createHttpApp } from "../src/http.js";
import { InfomaniakClient } from "../src/infomaniak.js";
import { InfomaniakOAuthProvider } from "../src/oauth/provider.js";
import { Sealer } from "../src/oauth/seal.js";

const PORT = 40_000 + Math.floor(Math.random() * 10_000);
const BASE = `http://localhost:${PORT}`;
const REDIRECT = "http://localhost:9/callback";

/** Plays both login.infomaniak.com/token and api.infomaniak.com. */
const upstream: { tokenRequests: URLSearchParams[]; apiAuth: string[] } = { tokenRequests: [], apiAuth: [] };
const fakeInfomaniak = (async (url: string | URL, init?: RequestInit) => {
  const href = String(url);
  if (href === "https://login.infomaniak.com/token") {
    const params = new URLSearchParams(String(init?.body));
    upstream.tokenRequests.push(params);
    const n = upstream.tokenRequests.length;
    return Response.json({ access_token: `imk-access-${n}`, refresh_token: `imk-refresh-${n}`, expires_in: 7200 });
  }
  upstream.apiAuth.push((init?.headers as Record<string, string>).Authorization);
  return Response.json({ result: "success", data: { id: 1 } });
}) as typeof fetch;

let server: ReturnType<ReturnType<typeof createHttpApp>["listen"]>;

beforeAll(async () => {
  const config = loadConfig({
    HOST: "localhost",
    PUBLIC_URL: BASE,
    INFOMANIAK_OAUTH_CLIENT_ID: "app-id",
    INFOMANIAK_OAUTH_CLIENT_SECRET: "app-secret",
    OAUTH_SECRET: "x".repeat(40),
  });
  const provider = new InfomaniakOAuthProvider({ ...config.oauth!, publicUrl: config.publicUrl!, fetch: fakeInfomaniak });
  const app = createHttpApp(config, Catalog.load(), new InfomaniakClient({ fetch: fakeInfomaniak }), { oauth: provider });
  server = app.listen(PORT, "localhost");
  await new Promise((r) => server.once("listening", r));
});

afterAll(() => server.close());

function form(params: Record<string, string>) {
  return { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(params) };
}

function mcp(token: string | undefined, body: object) {
  return fetch(`${BASE}/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
}

describe("sealer", () => {
  it("rejects other types, tampering and expiry", () => {
    const sealer = new Sealer("s".repeat(32));
    const blob = sealer.seal("a", { v: 1 }, 60);
    expect(sealer.open("a", blob)).toMatchObject({ v: 1 });
    expect(sealer.open("b", blob)).toBeUndefined();
    expect(sealer.open("a", blob.slice(0, -2) + "AA")).toBeUndefined();
    expect(sealer.open("a", sealer.seal("a", { v: 1 }, -1))).toBeUndefined();
    expect(new Sealer("t".repeat(32)).open("a", blob)).toBeUndefined();
  });
});

describe("oauth flow", () => {
  it("challenges unauthenticated clients with the resource metadata", async () => {
    const res = await mcp(undefined, { jsonrpc: "2.0", id: 1, method: "tools/list" });
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toContain(
      `resource_metadata="${BASE}/.well-known/oauth-protected-resource/mcp"`,
    );
    const meta = await (await fetch(`${BASE}/.well-known/oauth-protected-resource/mcp`)).json();
    expect(meta.authorization_servers).toEqual([`${BASE}/`]);
  });

  it("signs in through Infomaniak, calls the API and refreshes", async () => {
    // 1. Dynamic client registration (public client, PKCE only).
    const registration = await (
      await fetch(`${BASE}/register`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ redirect_uris: [REDIRECT], token_endpoint_auth_method: "none", client_name: "test" }),
      })
    ).json();
    const clientId: string = registration.client_id;
    expect(clientId).toBeTruthy();

    // 2. Authorization request: redirected to Infomaniak with this server's own app.
    const verifier = randomBytes(32).toString("base64url");
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    const authorize = await fetch(
      `${BASE}/authorize?${new URLSearchParams({
        response_type: "code",
        client_id: clientId,
        redirect_uri: REDIRECT,
        code_challenge: challenge,
        code_challenge_method: "S256",
        state: "client-state",
      })}`,
      { redirect: "manual" },
    );
    expect(authorize.status).toBe(302);
    const toInfomaniak = new URL(authorize.headers.get("location")!);
    expect(toInfomaniak.origin + toInfomaniak.pathname).toBe("https://login.infomaniak.com/authorize");
    expect(toInfomaniak.searchParams.get("client_id")).toBe("app-id");
    expect(toInfomaniak.searchParams.get("redirect_uri")).toBe(`${BASE}/oauth/callback`);
    expect(toInfomaniak.searchParams.get("code_challenge_method")).toBe("S256");

    // 3. Infomaniak sends the user back; the server exchanges the code and redirects to the client.
    const callback = await fetch(
      `${BASE}/oauth/callback?code=upstream-code&state=${encodeURIComponent(toInfomaniak.searchParams.get("state")!)}`,
      { redirect: "manual" },
    );
    const toClient = new URL(callback.headers.get("location")!);
    expect(toClient.origin + toClient.pathname).toBe(REDIRECT);
    expect(toClient.searchParams.get("state")).toBe("client-state");
    const exchange = upstream.tokenRequests[0];
    expect(exchange.get("code")).toBe("upstream-code");
    expect(exchange.get("client_secret")).toBe("app-secret");
    expect(exchange.get("code_verifier")).toBeTruthy();

    // 4. Token request: a wrong verifier fails, the right one yields our own tokens.
    const code = toClient.searchParams.get("code")!;
    const bad = await fetch(`${BASE}/token`, form({ grant_type: "authorization_code", code, client_id: clientId, code_verifier: "nope".repeat(11), redirect_uri: REDIRECT }));
    expect(bad.status).toBe(400);
    const tokens = await (
      await fetch(`${BASE}/token`, form({ grant_type: "authorization_code", code, client_id: clientId, code_verifier: verifier, redirect_uri: REDIRECT }))
    ).json();
    expect(tokens.access_token).toMatch(/^imcp_/);
    expect(tokens.access_token).not.toContain("imk-access");
    expect(tokens.expires_in).toBe(7200);

    // 5. MCP call: the Infomaniak token wrapped in the access token is used upstream.
    const call = await mcp(tokens.access_token, {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "infomaniak_get", arguments: { path: "/2/profile" } },
    });
    expect(call.status).toBe(200);
    expect(upstream.apiAuth.at(-1)).toBe("Bearer imk-access-1");

    // 6. Refresh: Infomaniak is asked for a new token with its own refresh token.
    const refreshed = await (
      await fetch(`${BASE}/token`, form({ grant_type: "refresh_token", refresh_token: tokens.refresh_token, client_id: clientId }))
    ).json();
    expect(upstream.tokenRequests[1].get("refresh_token")).toBe("imk-refresh-1");
    await mcp(refreshed.access_token, { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "infomaniak_get", arguments: { path: "/2/profile" } } });
    expect(upstream.apiAuth.at(-1)).toBe("Bearer imk-access-2");

    // 7. A tampered access token is rejected.
    const forged = await mcp(tokens.access_token.slice(0, -4) + "AAAA", { jsonrpc: "2.0", id: 4, method: "tools/list" });
    expect(forged.status).toBe(401);
    expect(forged.headers.get("www-authenticate")).toContain('error="invalid_token"');
  });

  it("refuses codes issued to another client", async () => {
    const register = async () =>
      (
        await (
          await fetch(`${BASE}/register`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ redirect_uris: [REDIRECT], token_endpoint_auth_method: "none" }),
          })
        ).json()
      ).client_id as string;
    const [victim, attacker] = [await register(), await register()];
    const verifier = randomBytes(32).toString("base64url");
    const authorize = await fetch(
      `${BASE}/authorize?${new URLSearchParams({
        response_type: "code",
        client_id: victim,
        redirect_uri: REDIRECT,
        code_challenge: createHash("sha256").update(verifier).digest("base64url"),
        code_challenge_method: "S256",
      })}`,
      { redirect: "manual" },
    );
    const state = new URL(authorize.headers.get("location")!).searchParams.get("state")!;
    const callback = await fetch(`${BASE}/oauth/callback?code=c&state=${encodeURIComponent(state)}`, { redirect: "manual" });
    const code = new URL(callback.headers.get("location")!).searchParams.get("code")!;
    const res = await fetch(`${BASE}/token`, form({ grant_type: "authorization_code", code, client_id: attacker, code_verifier: verifier, redirect_uri: REDIRECT }));
    expect(res.status).toBe(400);
  });
});
