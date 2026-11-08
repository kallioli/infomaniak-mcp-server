import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createAdminApp } from "../src/admin/app.js";
import { Catalog } from "../src/catalog.js";
import { loadConfig } from "../src/config.js";
import { createHttpApp } from "../src/http.js";
import { InfomaniakClient } from "../src/infomaniak.js";
import { Store, normalizeIpRules } from "../src/store/db.js";

const SECRET = "k".repeat(40);
const PASSWORD = "correct horse battery";
const catalog = Catalog.load();
const dir = mkdtempSync(join(tmpdir(), "imcp-"));
const store = new Store(join(dir, "test.db"), SECRET);
store.setAdminPassword(PASSWORD);

const apiCalls: { url: string; auth: string }[] = [];
const fakeFetch = (async (url: string | URL, init?: RequestInit) => {
  const auth = (init?.headers as Record<string, string>).Authorization;
  apiCalls.push({ url: String(url), auth });
  if (auth === "Bearer bad-token") return Response.json({ result: "error", error: { code: "not_authorized" } }, { status: 401 });
  return Response.json({ result: "success", data: { display_name: "Jane" } });
}) as typeof fetch;
const client = new InfomaniakClient({ fetch: fakeFetch });
const config = loadConfig({ HOST: "127.0.0.1", DATA_DIR: dir });

let admin: ReturnType<ReturnType<typeof createAdminApp>["listen"]>;
let mcp: ReturnType<ReturnType<typeof createHttpApp>["listen"]>;
let adminUrl = "";
let mcpUrl = "";
let session = "";

async function listen(app: { listen: (port: number, host: string) => any }) {
  const server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  return { server, url: `http://127.0.0.1:${server.address().port}` };
}

beforeAll(async () => {
  ({ server: admin, url: adminUrl } = await listen(createAdminApp({ config, store, catalog, client, secretKey: SECRET })));
  ({ server: mcp, url: mcpUrl } = await listen(createHttpApp(config, catalog, client, { store })));
});

afterAll(() => {
  admin.close();
  mcp.close();
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

function call(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  return fetch(`${adminUrl}/api${path}`, {
    method,
    headers: {
      "content-type": "application/json",
      "x-requested-with": "infomaniak-mcp-admin",
      ...(session ? { cookie: session } : {}),
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

function mcpCall(token: string, name: string, args: object) {
  return fetch(`${mcpUrl}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${token}` },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
  });
}

function listTools(token: string) {
  return fetch(`${mcpUrl}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${token}` },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
  });
}

describe("store", () => {
  it("never stores Infomaniak tokens in clear", () => {
    const c = store.createConnection({ name: "clear-check", token: "super-secret-infomaniak-token" });
    expect(JSON.stringify(c)).not.toContain("super-secret");
    expect(store.connectionToken(c.id)).toBe("super-secret-infomaniak-token");
    expect(new Store(join(dir, "test.db"), "z".repeat(40)).connectionToken(c.id)).toBeUndefined();
    store.deleteConnection(c.id);
  });

  it("validates IP rules", () => {
    expect(normalizeIpRules(["10.0.0.0/8", " 2001:db8::1 "])).toEqual(["10.0.0.0/8", "2001:db8::1"]);
    expect(() => normalizeIpRules(["10.0.0.0/33"])).toThrow();
    expect(() => normalizeIpRules(["example.com"])).toThrow();
  });
});

describe("admin api", () => {
  it("requires a session and the CSRF header", async () => {
    expect((await call("GET", "/dashboard")).status).toBe(401);
    expect((await call("POST", "/auth/login", { password: "wrong" })).status).toBe(401);
    const login = await call("POST", "/auth/login", { password: PASSWORD });
    expect(login.status).toBe(200);
    const setCookie = login.headers.get("set-cookie")!;
    expect(setCookie).toMatch(/HttpOnly/i);
    expect(setCookie).toMatch(/SameSite=Strict/i);
    session = setCookie.split(";")[0];
    expect((await call("GET", "/dashboard")).status).toBe(200);
    expect((await call("POST", "/connections", { name: "x", token: "y" }, { "x-requested-with": "" })).status).toBe(403);
  });

  it("manages connections and tests them against the API", async () => {
    const created = await (await call("POST", "/connections", { name: "Prod", token: "good-token" })).json();
    expect(created.tokenHint).toBe("oken");
    expect(JSON.stringify(created)).not.toContain("good-token");
    const tested = await (await call("POST", `/connections/${created.id}/test`)).json();
    expect(tested.lastCheck.ok).toBe(true);
    expect(tested.lastCheck.detail).toMatch(/^Authenticated as Jane · /);

    const bad = await (await call("POST", "/connections", { name: "Broken", token: "bad-token" })).json();
    expect((await (await call("POST", `/connections/${bad.id}/test`)).json()).lastCheck.ok).toBe(false);
    expect((await call("POST", "/connections", { name: "Prod", token: "dup" })).status).toBe(400);
    expect((await call("DELETE", `/connections/${bad.id}`)).status).toBe(204);
  });

  it("issues managed tokens usable on /mcp, restricted by category and read-only", async () => {
    const [connection] = (await (await call("GET", "/connections")).json()) as { id: string; name: string }[];
    const created = await (
      await call("POST", "/tokens", { name: "Claude", connectionId: connection.id, readOnly: true, categories: ["Domain & Zone"] })
    ).json();
    expect(created.secret).toMatch(/^imkt_/);
    expect(created.token.status).toBe("active");
    expect(JSON.stringify(await (await call("GET", "/tokens")).json())).not.toContain(created.secret);

    // Read-only: the write tool is hidden.
    const tools = (await (await listTools(created.secret)).json()).result.tools.map((t: { name: string }) => t.name);
    expect(tools).not.toContain("infomaniak_request");

    // Allowed category goes through with the connection's Infomaniak token.
    const ok = await (await mcpCall(created.secret, "infomaniak_get", { path: "/2/zones/example.ch/records" })).json();
    expect(ok.result.isError).toBeFalsy();
    expect(apiCalls.at(-1)).toEqual({ url: "https://api.infomaniak.com/2/zones/example.ch/records", auth: "Bearer good-token" });

    // Other categories are invisible.
    const denied = await (await mcpCall(created.secret, "infomaniak_get", { path: "/2/drive/1/files" })).json();
    expect(denied.result.isError).toBe(true);
    const search = await (await mcpCall(created.secret, "infomaniak_search_operations", { query: "kdrive files" })).json();
    expect(search.result.content[0].text).not.toContain("/drive/");

    // Revocation is immediate.
    await call("POST", `/tokens/${created.token.id}/revoke`);
    expect((await listTools(created.secret)).status).toBe(401);
  });

  it("enforces IP restrictions and expiry", async () => {
    const [connection] = (await (await call("GET", "/connections")).json()) as { id: string }[];
    const ipBound = await (await call("POST", "/tokens", { name: "IP", connectionId: connection.id, allowedIps: ["203.0.113.0/24"] })).json();
    const res = await listTools(ipBound.secret);
    expect(res.status).toBe(401);
    expect((await res.json()).error.message).toContain("IP address");

    const local = await (await call("POST", "/tokens", { name: "Local", connectionId: connection.id, allowedIps: ["127.0.0.1"] })).json();
    expect((await listTools(local.secret)).status).toBe(200);

    expect((await call("POST", "/tokens", { name: "Past", connectionId: connection.id, expiresAt: Date.now() - 1000 })).status).toBe(400);
    expect((await call("POST", "/tokens", { name: "Bad", connectionId: connection.id, categories: ["Nope"] })).status).toBe(400);
    expect((await call("DELETE", `/connections/${connection.id}`)).status).toBe(400);
  });

  it("issues tokens spanning several connections and lists organisations", async () => {
    const [prod] = (await (await call("GET", "/connections")).json()) as { id: string }[];
    const other = await (await call("POST", "/connections", { name: "Client B", token: "client-b-token" })).json();
    expect((await call("PATCH", `/connections/${other.id}`, { defaultAccountId: 42 })).status).toBe(200);
    expect((await call("PATCH", `/connections/${other.id}`, { defaultAccountId: -1 })).status).toBe(400);
    expect(await (await call("GET", `/connections/${other.id}/accounts`)).json()).toEqual([]);

    const created = await (
      await call("POST", "/tokens", { name: "Multi", connectionIds: [prod.id, other.id], defaultConnectionId: other.id })
    ).json();
    expect(created.token.connections.map((c: { id: string }) => c.id)).toEqual([other.id, prod.id]);

    await mcpCall(created.secret, "infomaniak_get", { path: "/1/products" });
    expect(apiCalls.at(-1)).toEqual({ url: "https://api.infomaniak.com/1/products?account_id=42", auth: "Bearer client-b-token" });
    await mcpCall(created.secret, "infomaniak_get", { path: "/1/products", connection: "Prod" });
    expect(apiCalls.at(-1)?.auth).toBe("Bearer good-token");

    await call("DELETE", `/tokens/${created.token.id}`);
    expect((await call("DELETE", `/connections/${other.id}`)).status).toBe(204);
  });

  it("manages OAuth access rules and the default policy", async () => {
    const overview = await (await call("GET", "/oauth")).json();
    expect(overview).toMatchObject({ enabled: false, defaultPolicy: "personal", rules: [] });

    const [connection] = (await (await call("GET", "/connections")).json()) as { id: string; name: string }[];
    const created = await call("POST", "/oauth/rules", {
      name: "Team",
      matchType: "domain",
      matchValue: "@example.com",
      connectionIds: [connection.id],
      defaultConnectionId: connection.id,
      includePersonal: true,
      categories: ["Domain & Zone"],
    });
    expect(created.status).toBe(201);
    const rule = await created.json();
    expect(rule).toMatchObject({ matchValue: "example.com", connections: [{ id: connection.id, name: connection.name }] });

    expect((await call("PATCH", `/oauth/rules/${rule.id}`, { enabled: false })).status).toBe(200);
    expect((await call("POST", "/oauth/rules", { name: "Bad", matchType: "email", matchValue: "nope" })).status).toBe(400);
    expect((await call("PUT", "/oauth/policy", { defaultPolicy: "deny" })).status).toBe(200);
    expect((await call("PUT", "/oauth/policy", { defaultPolicy: "maybe" })).status).toBe(400);
    expect((await call("DELETE", `/connections/${connection.id}`)).status).toBe(400);

    expect((await call("DELETE", `/oauth/rules/${rule.id}`)).status).toBe(204);
    await call("PUT", "/oauth/policy", { defaultPolicy: "personal" });
  });

  it("disables categories globally", async () => {
    const categories = (await (await call("GET", "/categories")).json()) as { name: string; enabled: boolean }[];
    expect(categories.find((c) => c.name === "kDrive")?.enabled).toBe(true);
    expect((await call("PUT", "/categories", { disabled: ["kDrive"] })).status).toBe(200);

    const [connection] = (await (await call("GET", "/connections")).json()) as { id: string }[];
    const all = await (await call("POST", "/tokens", { name: "All", connectionId: connection.id })).json();
    const denied = await (await mcpCall(all.secret, "infomaniak_get", { path: "/2/drive/1/files" })).json();
    expect(denied.result.isError).toBe(true);
    const allowed = await (await mcpCall(all.secret, "infomaniak_get", { path: "/2/zones/example.ch/records" })).json();
    expect(allowed.result.isError).toBeFalsy();

    expect((await call("PUT", "/categories", { disabled: ["Nope"] })).status).toBe(400);
    await call("PUT", "/categories", { disabled: [] });
  });
});
