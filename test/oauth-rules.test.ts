import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Catalog } from "../src/catalog.js";
import { loadConfig } from "../src/config.js";
import { createHttpApp } from "../src/http.js";
import { InfomaniakClient } from "../src/infomaniak.js";
import { InfomaniakOAuthProvider } from "../src/oauth/provider.js";
import { type OAuthIdentity, Store } from "../src/store/db.js";

const PORT = 41_000 + Math.floor(Math.random() * 9_000);
const BASE = `http://localhost:${PORT}`;
const REDIRECT = "http://localhost:9/callback";

/** Identity the fake Infomaniak userinfo endpoint reports for the next login. */
let identity: Record<string, unknown> = {};
const apiAuth: string[] = [];
let issued = 0;

const fakeInfomaniak = (async (url: string | URL, init?: RequestInit) => {
  const href = String(url);
  if (href === "https://login.infomaniak.com/token") {
    issued++;
    return Response.json({ access_token: `personal-${issued}`, refresh_token: `refresh-${issued}`, expires_in: 3600 });
  }
  if (href === "https://login.infomaniak.com/oauth2/userinfo") return Response.json(identity);
  apiAuth.push((init?.headers as Record<string, string>).Authorization);
  return Response.json({ result: "success", data: [] });
}) as typeof fetch;

const dir = mkdtempSync(join(tmpdir(), "imcp-oauth-rules-"));
const store = new Store(join(dir, "rules.db"), "r".repeat(40));
let server: ReturnType<ReturnType<typeof createHttpApp>["listen"]>;
let shared: string;

beforeAll(async () => {
  const config = loadConfig({
    HOST: "localhost",
    PUBLIC_URL: BASE,
    INFOMANIAK_OAUTH_CLIENT_ID: "app-id",
    INFOMANIAK_OAUTH_CLIENT_SECRET: "app-secret",
    OAUTH_SECRET: "x".repeat(40),
  });
  const provider = new InfomaniakOAuthProvider({
    ...config.oauth!,
    publicUrl: config.publicUrl!,
    fetch: fakeInfomaniak,
    authorizeLogin: (id) => store.checkOAuthLogin(id),
  });
  shared = store.createConnection({ name: "StackOps", token: "shared-token" }).id;
  const app = createHttpApp(config, Catalog.load(), new InfomaniakClient({ fetch: fakeInfomaniak }), { oauth: provider, store });
  server = app.listen(PORT, "localhost");
  await new Promise((r) => server.once("listening", r));
});

afterAll(() => {
  server.close();
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

beforeEach(() => {
  for (const r of store.listOAuthRules()) store.deleteOAuthRule(r.id);
  store.setOAuthDefaultPolicy("personal");
});

const form = (params: Record<string, string>) => ({
  method: "POST",
  headers: { "content-type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams(params),
});

/** Runs the whole OAuth dance; returns the access token, or the error the client is redirected with. */
async function signIn(who: Record<string, unknown>): Promise<{ accessToken?: string; error?: string; description?: string }> {
  identity = who;
  const { client_id } = await (
    await fetch(`${BASE}/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ redirect_uris: [REDIRECT], token_endpoint_auth_method: "none" }),
    })
  ).json();
  const verifier = randomBytes(32).toString("base64url");
  const authorize = await fetch(
    `${BASE}/authorize?${new URLSearchParams({
      response_type: "code",
      client_id,
      redirect_uri: REDIRECT,
      code_challenge: createHash("sha256").update(verifier).digest("base64url"),
      code_challenge_method: "S256",
    })}`,
    { redirect: "manual" },
  );
  const state = new URL(authorize.headers.get("location")!).searchParams.get("state")!;
  const callback = await fetch(`${BASE}/oauth/callback?code=c&state=${encodeURIComponent(state)}`, { redirect: "manual" });
  const back = new URL(callback.headers.get("location")!);
  if (back.searchParams.get("error")) {
    return { error: back.searchParams.get("error")!, description: back.searchParams.get("error_description") ?? undefined };
  }
  const tokens = await (
    await fetch(`${BASE}/token`, form({ grant_type: "authorization_code", code: back.searchParams.get("code")!, client_id, code_verifier: verifier, redirect_uri: REDIRECT }))
  ).json();
  return { accessToken: tokens.access_token };
}

function mcp(token: string, method: string, params?: object) {
  return fetch(`${BASE}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${token}` },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
}

async function connectionChoices(token: string): Promise<string[] | undefined> {
  const { result } = await (await mcp(token, "tools/list")).json();
  const get = result.tools.find((t: { name: string }) => t.name === "infomaniak_get");
  return get.inputSchema.properties.connection?.enum;
}

const KEVIN: Record<string, unknown> = { sub: "1001", email: "kevin@stackops.ch", email_verified: true, name: "Kevin" };

describe("OAuth users and the admin's rules", () => {
  it("gives users matching no rule their personal login only (default policy)", async () => {
    const { accessToken } = await signIn(KEVIN);
    expect(await connectionChoices(accessToken!)).toBeUndefined();
    await mcp(accessToken!, "tools/call", { name: "infomaniak_get", arguments: { path: "/1/products" } });
    expect(apiAuth.at(-1)).toMatch(/^Bearer personal-/);
    const seen = store.listOAuthIdentities().find((i) => i.sub === "1001");
    expect(seen).toMatchObject({ email: "kevin@stackops.ch", emailVerified: true, ruleId: null });
  });

  it("grants shared connections to a domain, alongside the personal login", async () => {
    store.createOAuthRule({ name: "StackOps team", matchType: "domain", matchValue: "@StackOps.ch", connectionIds: [shared], defaultConnectionId: shared });
    const { accessToken } = await signIn(KEVIN);
    expect(await connectionChoices(accessToken!)).toEqual(["StackOps", "Personal"]);

    await mcp(accessToken!, "tools/call", { name: "infomaniak_get", arguments: { path: "/1/products" } });
    expect(apiAuth.at(-1)).toBe("Bearer shared-token");
    await mcp(accessToken!, "tools/call", { name: "infomaniak_get", arguments: { path: "/1/products", connection: "Personal" } });
    expect(apiAuth.at(-1)).toMatch(/^Bearer personal-/);
  });

  it("applies the rule's restrictions and is re-evaluated on every request", async () => {
    const rule = store.createOAuthRule({
      name: "Kevin",
      matchType: "email",
      matchValue: "kevin@stackops.ch",
      connectionIds: [shared],
      includePersonal: false,
      readOnly: true,
      categories: ["Domain & Zone"],
    });
    const { accessToken } = await signIn(KEVIN);
    const tools = (await (await mcp(accessToken!, "tools/list")).json()).result.tools.map((t: { name: string }) => t.name);
    expect(tools).not.toContain("infomaniak_request");
    const drive = await (await mcp(accessToken!, "tools/call", { name: "infomaniak_get", arguments: { path: "/2/drive/1/files" } })).json();
    expect(drive.result.isError).toBe(true);

    // Disabling the rule takes effect on the next request; with the deny policy the user is now refused.
    store.updateOAuthRule(rule.id, { enabled: false });
    store.setOAuthDefaultPolicy("deny");
    expect((await mcp(accessToken!, "tools/list")).status).toBe(403);
  });

  it("refuses users matching no rule at login when the policy is deny", async () => {
    store.setOAuthDefaultPolicy("deny");
    const refused = await signIn({ sub: "2002", email: "someone@example.com", email_verified: true });
    expect(refused.error).toBe("access_denied");
    expect(refused.description).toContain("not allowed");
    // The attempt is visible to the admin, who can then create a rule for this user.
    expect(store.listOAuthIdentities().some((i) => i.sub === "2002")).toBe(true);

    store.createOAuthRule({ name: "Someone", matchType: "user", matchValue: "2002", includePersonal: true });
    expect((await signIn({ sub: "2002", email: "someone@example.com", email_verified: true })).accessToken).toBeTruthy();
  });

  it("never matches e-mail rules on unverified addresses", async () => {
    store.createOAuthRule({ name: "Team", matchType: "domain", matchValue: "stackops.ch", connectionIds: [shared], defaultConnectionId: shared });
    store.setOAuthDefaultPolicy("deny");
    const spoofed = await signIn({ sub: "3003", email: "intruder@stackops.ch", email_verified: false });
    expect(spoofed.error).toBe("access_denied");
  });
});

describe("rule validation", () => {
  it("rejects incoherent rules", () => {
    expect(() => store.createOAuthRule({ name: "x", matchType: "email", matchValue: "not-an-email" })).toThrow(/e-mail/);
    expect(() => store.createOAuthRule({ name: "x", matchType: "domain", matchValue: "nodot" })).toThrow(/domain/);
    expect(() => store.createOAuthRule({ name: "x", matchType: "user", matchValue: "1", includePersonal: false })).toThrow(/at least one/);
    expect(() =>
      store.createOAuthRule({ name: "x", matchType: "user", matchValue: "1", connectionIds: [shared], defaultConnectionId: "other" }),
    ).toThrow(/default connection/);
    // A connection used by a rule cannot be deleted.
    store.createOAuthRule({ name: "Uses shared", matchType: "user", matchValue: "9", connectionIds: [shared] });
    expect(() => store.deleteConnection(shared)).toThrow(/OAuth rule/);
  });

  it("matches user id before e-mail before domain", () => {
    const domain = store.createOAuthRule({ name: "Domain", matchType: "domain", matchValue: "stackops.ch", includePersonal: true });
    const email = store.createOAuthRule({ name: "Email", matchType: "email", matchValue: "kevin@stackops.ch", includePersonal: true });
    const user = store.createOAuthRule({ name: "User", matchType: "user", matchValue: "1001", includePersonal: true });
    const kevin: OAuthIdentity = { sub: "1001", email: "kevin@stackops.ch", emailVerified: true };
    expect(store.matchOAuthRule(kevin)?.id).toBe(user.id);
    expect(store.matchOAuthRule({ ...kevin, sub: "x" })?.id).toBe(email.id);
    expect(store.matchOAuthRule({ ...kevin, sub: "x", email: "anna@stackops.ch" })?.id).toBe(domain.id);
  });
});
