import { describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ElicitRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { Catalog, isDangerous } from "../src/catalog.js";
import { sanitize } from "../scripts/sanitize-extensions.js";
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
    await client.callTool({ name: "infomaniak_get", arguments: { path: "/api/v4/users/me", kchat_team: "acme" } });
    expect(calls.map((c) => c.url)).toEqual(["https://acme.kchat.infomaniak.com/api/v4/users/me"]);
  });

  it("flags API errors", async () => {
    const client = await connect({ fetch: fakeFetch([], 404, { result: "error", error: { code: "not_found" } }) });
    const res = await client.callTool({ name: "infomaniak_get", arguments: { path: "/1/products" } });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain("HTTP 404");
  });
});

describe("ik-api-explore extensions", () => {
  it("includes undocumented operations under their category", () => {
    const m = catalog.match("GET", "/1/web_hostings/123456/sites");
    expect(m?.op.undocumented).toBe(true);
    expect(m?.op.tag.startsWith("Web Hosting")).toBe(true);
  });

  it("keeps the official scopes of operations it corrects", () => {
    const op = catalog.get("POST /1/public_clouds/{public_cloud_id}/projects/{public_cloud_project_id}/kaas");
    expect(op?.scopes).toContain("public_cloud");
  });

  it("flags operations never executed with a token as unverified", () => {
    expect(catalog.get("GET /1/order/cart")?.verified).toBe(false);
    expect(catalog.get("GET /order/cart")?.verified).toBeUndefined();
  });

  it("contains no real domain, identifier or UUID", () => {
    const raw = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "spec", "infomaniak-extensions.openapi.json"), "utf8");
    const spec = JSON.parse(raw);
    expect(sanitize(spec)).toEqual(spec);
    expect(raw).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
  });
});

describe("dangerous operations", () => {
  const checkout = { method: "POST", path: "/order/cart/abc/checkout", body: {} };

  it("needs confirm: true, whatever the spelling of the path", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const client = await connect({ fetch: fakeFetch(calls) });
    for (const path of ["/order/cart/abc/checkout", "order/cart/abc/checkout", "/order/cart/{cart_uuid}/checkout"]) {
      const refused = await client.callTool({
        name: "infomaniak_request",
        arguments: { ...checkout, path, path_params: { cart_uuid: "abc" } },
      });
      expect(refused.isError).toBe(true);
      expect(textOf(refused)).toContain("confirm: true");
    }
    expect(calls).toHaveLength(0);
    await client.callTool({ name: "infomaniak_request", arguments: { ...checkout, confirm: true } });
    expect(calls).toHaveLength(1);
  });

  it("covers every DELETE and restores, documented or not", () => {
    const deleteRecord = catalog.get("DELETE /2/zones/{zone}/records/{record}")!;
    const restore = catalog.match("POST", "/1/web_hostings/1/databases/db/actions/restore")!.op;
    const listRecords = catalog.get("GET /2/zones/{zone}/records")!;
    expect([isDangerous(deleteRecord), isDangerous(restore), isDangerous(listRecords)]).toEqual([true, true, false]);
  });

  it("asks the user through elicitation when the client supports it", async () => {
    for (const [answer, expected] of [
      [{ action: "accept", content: { confirm: true } }, 1],
      [{ action: "decline" }, 0],
    ] as const) {
      const calls: { url: string; init: RequestInit }[] = [];
      const server = createServer({
        catalog,
        client: new InfomaniakClient({ fetch: fakeFetch(calls) }),
        connections: [{ name: "infomaniak", token: "secret-token" }],
      });
      const client = new Client({ name: "test", version: "1.0.0" }, { capabilities: { elicitation: {} } });
      client.setRequestHandler(ElicitRequestSchema, async () => answer);
      const [a, b] = InMemoryTransport.createLinkedPair();
      await Promise.all([server.connect(a), client.connect(b)]);
      // confirm: true alone is not enough when the user can be asked directly.
      const res = await client.callTool({ name: "infomaniak_request", arguments: { ...checkout, confirm: true } });
      expect(calls).toHaveLength(expected);
      expect(Boolean(res.isError)).toBe(expected === 0);
    }
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
