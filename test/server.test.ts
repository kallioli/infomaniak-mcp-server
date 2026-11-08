import { describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Catalog } from "../src/catalog.js";
import { InfomaniakClient } from "../src/infomaniak.js";
import { createServer } from "../src/server.js";
import { createHttpApp } from "../src/http.js";
import { loadConfig } from "../src/config.js";

const catalog = Catalog.load();

function fakeFetch(calls: { url: string; init: RequestInit }[], status = 200, payload: unknown = { result: "success", data: [] }) {
  return (async (url: string | URL, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
}

async function connect(opts: { readOnly?: boolean; fetch?: typeof fetch } = {}) {
  const server = createServer({
    catalog,
    client: new InfomaniakClient({ fetch: opts.fetch ?? fakeFetch([]) }),
    connections: [{ name: "infomaniak", token: "secret-token" }],
    readOnly: opts.readOnly,
  });
  const client = new Client({ name: "test", version: "1.0.0" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  return client;
}

function textOf(result: Awaited<ReturnType<Client["callTool"]>>): string {
  return (result.content as { type: string; text: string }[])[0].text;
}

describe("catalog", () => {
  it("contains the whole API", () => {
    expect(catalog.operations.length).toBeGreaterThan(1500);
  });

  it("finds DNS record operations", () => {
    const ids = catalog.search({ query: "dns record" }).map((o) => o.id);
    expect(ids).toContain("POST /2/zones/{zone}/records");
  });

  it("understands product names and plurals", () => {
    const results = catalog.search({ query: "kdrive files", limit: 5 });
    expect(results.every((o) => o.tag.startsWith("kDrive"))).toBe(true);
    expect(catalog.search({ query: "list", limit: 50 }).some((o) => /playlist/i.test(o.summary))).toBe(false);
  });

  it("matches concrete paths to templates", () => {
    const m = catalog.match("GET", "/2/zones/example.ch/records");
    expect(m?.op.id).toBe("GET /2/zones/{zone}/records");
    expect(m?.pathParams).toEqual({ zone: "example.ch" });
  });
});

describe("mcp tools", () => {
  it("hides the write tool in read-only mode", async () => {
    const tools = (await (await connect({ readOnly: true })).listTools()).tools.map((t) => t.name);
    expect(tools).toContain("infomaniak_get");
    expect(tools).not.toContain("infomaniak_request");
  });

  it("describes an operation with its body schema", async () => {
    const client = await connect();
    const res = await client.callTool({
      name: "infomaniak_describe_operation",
      arguments: { operation: "POST /2/zones/{zone}/records" },
    });
    const details = JSON.parse(textOf(res));
    expect(details.body.schema.required).toEqual(["target", "ttl", "type"]);
    expect(details.scopes).toContain("dns:write");
  });

  it("calls the API with the session token and path params", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const client = await connect({ fetch: fakeFetch(calls) });
    const res = await client.callTool({
      name: "infomaniak_get",
      arguments: { path: "/2/zones/{zone}/records", path_params: { zone: "example.ch" }, query: { per_page: 10 } },
    });
    expect(res.isError).toBeFalsy();
    expect(calls[0].url).toBe("https://api.infomaniak.com/2/zones/example.ch/records?per_page=10");
    expect((calls[0].init.headers as Record<string, string>).Authorization).toBe("Bearer secret-token");
  });

  it("rejects paths that are not in the catalog", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const client = await connect({ fetch: fakeFetch(calls) });
    const res = await client.callTool({ name: "infomaniak_get", arguments: { path: "/9/nope" } });
    expect(res.isError).toBe(true);
    expect(calls).toHaveLength(0);
  });

  it("routes kChat paths to the team host and validates the team", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const client = await connect({ fetch: fakeFetch(calls) });
    const bad = await client.callTool({
      name: "infomaniak_get",
      arguments: { path: "/api/v4/users/me", kchat_team: "evil.com/x" },
    });
    expect(bad.isError).toBe(true);
    await client.callTool({ name: "infomaniak_get", arguments: { path: "/api/v4/users/me", kchat_team: "stackops" } });
    expect(calls.map((c) => c.url)).toEqual(["https://stackops.kchat.infomaniak.com/api/v4/users/me"]);
  });

  it("flags API errors", async () => {
    const client = await connect({ fetch: fakeFetch([], 404, { result: "error", error: { code: "not_found" } }) });
    const res = await client.callTool({ name: "infomaniak_get", arguments: { path: "/1/products" } });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain("HTTP 404");
  });
});

describe("http auth", () => {
  async function start(env: Record<string, string>) {
    const app = createHttpApp(loadConfig({ HOST: "127.0.0.1", ...env }), catalog, new InfomaniakClient({ fetch: fakeFetch([]) }));
    const server = app.listen(0);
    await new Promise((r) => server.once("listening", r));
    const port = (server.address() as { port: number }).port;
    return { url: `http://127.0.0.1:${port}/mcp`, close: () => server.close() };
  }

  const initBody = JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } },
  });
  const headers = { "content-type": "application/json", accept: "application/json, text/event-stream" };

  it("requires a bearer token in passthrough mode", async () => {
    const srv = await start({});
    try {
      expect((await fetch(srv.url, { method: "POST", headers, body: initBody })).status).toBe(401);
      const ok = await fetch(srv.url, { method: "POST", headers: { ...headers, authorization: "Bearer tok" }, body: initBody });
      expect(ok.status).toBe(200);
    } finally {
      srv.close();
    }
  });

  it("checks API keys in api-key mode", async () => {
    const srv = await start({ MCP_API_KEYS: "k1,k2", INFOMANIAK_API_TOKEN: "srv" });
    try {
      const bad = await fetch(srv.url, { method: "POST", headers: { ...headers, authorization: "Bearer nope" }, body: initBody });
      expect(bad.status).toBe(401);
      const ok = await fetch(srv.url, { method: "POST", headers: { ...headers, authorization: "Bearer k2" }, body: initBody });
      expect(ok.status).toBe(200);
    } finally {
      srv.close();
    }
  });
});
