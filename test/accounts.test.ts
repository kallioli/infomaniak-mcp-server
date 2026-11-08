import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Catalog } from "../src/catalog.js";
import { InfomaniakClient } from "../src/infomaniak.js";
import { loadOrganisations } from "../src/organisations.js";
import { type ConnectionContext, createServer } from "../src/server.js";
import { Store } from "../src/store/db.js";

const catalog = Catalog.load();
const dir = mkdtempSync(join(tmpdir(), "imcp-accounts-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const ORGANISATIONS: Record<string, { id: number; name: string }[]> = {
  "Bearer prod-token": [
    { id: 111, name: "Acme SA" },
    { id: 222, name: "Client ACME" },
  ],
  "Bearer client-token": [
    { id: 333, name: "Client B SA" },
    { id: 444, name: "ACME Holding" },
  ],
};

async function setup(connections: ConnectionContext[], readOnly = false) {
  const calls: { url: string; auth: string; method: string }[] = [];
  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    const auth = (init?.headers as Record<string, string>).Authorization;
    calls.push({ url: String(url), auth, method: init?.method ?? "GET" });
    if (String(url).endsWith("/1/accounts")) return Response.json({ result: "success", data: ORGANISATIONS[auth] ?? [] });
    return Response.json({ result: "success", data: [] });
  }) as typeof fetch;
  const api = new InfomaniakClient({ fetch: fetchImpl });
  const organisations = await loadOrganisations(api, connections);
  calls.length = 0;
  const server = createServer({ catalog, client: api, connections, organisations, readOnly });
  const client = new Client({ name: "test", version: "1.0.0" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  return { calls, client };
}

const textOf = (r: Awaited<ReturnType<Client["callTool"]>>) => (r.content as { text: string }[])[0].text;
const get = (client: Client, args: object) => client.callTool({ name: "infomaniak_get", arguments: args });

const PROD: ConnectionContext = { name: "Prod", token: "prod-token", defaultAccountId: 111 };
const CLIENT_B: ConnectionContext = { name: "Client B", token: "client-token", readOnly: true };

describe("multiple connections and organisations", () => {
  it("spells out the token's connections and organisations in the tool schema", async () => {
    const { client } = await setup([PROD, CLIENT_B]);
    const tool = (await client.listTools()).tools.find((t) => t.name === "infomaniak_get")!;
    const props = tool.inputSchema.properties as Record<string, { enum?: string[]; description?: string }>;
    expect(props.connection.enum).toEqual(["Prod", "Client B"]);
    expect(props.connection.description).toContain('Default: "Prod"');
    expect(props.account.description).toContain('Client ACME (222, connection "Prod")');
    expect(props.account.description).toContain('Acme SA (111, connection "Prod", default)');

    // A single connection needs no selector.
    const single = await setup([PROD]);
    const singleProps = (await single.client.listTools()).tools.find((t) => t.name === "infomaniak_get")!.inputSchema.properties!;
    expect(singleProps).not.toHaveProperty("connection");
  });

  it("lists connections with their organisations and defaults", async () => {
    const { client } = await setup([PROD, CLIENT_B]);
    const text = textOf(await client.callTool({ name: "infomaniak_list_accounts", arguments: {} }));
    expect(text).toContain('Connection "Prod" (default, read/write)');
    expect(text).toContain("Acme SA — account 111 (default)");
    expect(text).toContain('Connection "Client B" (read-only)');
    expect(text).toContain("Client B SA — account 333");
  });

  it("switches connection per call", async () => {
    const { client, calls } = await setup([PROD, CLIENT_B]);
    await get(client, { path: "/2/zones/example.ch/records" });
    const res = await get(client, { path: "/2/zones/example.ch/records", connection: "Client B" });
    expect(calls.map((c) => c.auth)).toEqual(["Bearer prod-token", "Bearer client-token"]);
    expect(textOf(res)).toContain("connection: Client B");
  });

  it("finds the organisation by name or id and picks the connection that reaches it", async () => {
    const { client, calls } = await setup([PROD, CLIENT_B]);
    await get(client, { path: "/1/products", account: "client acme" });
    await get(client, { path: "/1/products", account: "Client B SA" });
    await get(client, { path: "/1/products", account: 333 });
    await get(client, { path: "/1/products", account: "holding" });
    expect(calls.map((c) => [c.url, c.auth])).toEqual([
      ["https://api.infomaniak.com/1/products?account_id=222", "Bearer prod-token"],
      ["https://api.infomaniak.com/1/products?account_id=333", "Bearer client-token"],
      ["https://api.infomaniak.com/1/products?account_id=333", "Bearer client-token"],
      ["https://api.infomaniak.com/1/products?account_id=444", "Bearer client-token"],
    ]);
  });

  it("refuses ambiguous or unknown organisation names", async () => {
    const { client, calls } = await setup([PROD, CLIENT_B]);
    const ambiguous = await get(client, { path: "/1/products", account: "acme" });
    expect(ambiguous.isError).toBe(true);
    expect(textOf(ambiguous)).toContain("matches several organisations");
    // Restricting to a connection removes the ambiguity.
    expect((await get(client, { path: "/1/products", account: "acme", connection: "Client B" })).isError).toBeFalsy();
    const unknown = await get(client, { path: "/1/products", account: "Nope" });
    expect(textOf(unknown)).toContain("Unknown organisation");
    expect(calls).toHaveLength(1);
  });

  it("refuses writes through a read-only connection", async () => {
    const { client, calls } = await setup([PROD, CLIENT_B]);
    const res = await client.callTool({
      name: "infomaniak_request",
      arguments: { method: "POST", path: "/2/zones/example.ch/records", body: {}, account: "Client B SA" },
    });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain("read-only");
    expect(calls).toHaveLength(0);
  });

  it("hides the write tool when every connection is read-only", async () => {
    const tools = (await (await setup([CLIENT_B])).client.listTools()).tools.map((t) => t.name);
    expect(tools).not.toContain("infomaniak_request");
  });

  it("fills the organisation into path and query account parameters", async () => {
    const { client, calls } = await setup([PROD, CLIENT_B]);
    await get(client, { path: "/1/accounts/{account_id}/products" });
    await get(client, { path: "/1/products", account: 222, query: { account_id: 999 } });
    await get(client, { path: "/1/products", connection: "Client B" });
    expect(calls.map((c) => c.url)).toEqual([
      "https://api.infomaniak.com/1/accounts/111/products",
      "https://api.infomaniak.com/1/products?account_id=999",
      "https://api.infomaniak.com/1/products",
    ]);
  });
});

describe("store", () => {
  it("gives a token several connections with a default one", () => {
    const store = new Store(join(dir, "multi.db"), "s".repeat(40));
    const prod = store.createConnection({ name: "Prod", token: "prod-token", defaultAccountId: 111 });
    const client = store.createConnection({ name: "Client B", token: "client-token", readOnly: true });

    expect(() => store.createToken({ name: "x", defaultConnectionId: prod.id, connectionIds: [client.id] })).toThrow(/default connection/);
    const { token, secret } = store.createToken({ name: "Jane", defaultConnectionId: client.id, connectionIds: [prod.id, client.id] });
    expect(token.connectionIds).toEqual([client.id, prod.id]);

    const grant = store.authenticateToken(secret, "127.0.0.1");
    expect(grant.connections.map((c) => [c.name, c.token, c.readOnly, c.defaultAccountId])).toEqual([
      ["Client B", "client-token", true, null],
      ["Prod", "prod-token", false, 111],
    ]);

    // A connection used as a non-default one still cannot be deleted.
    expect(() => store.deleteConnection(prod.id)).toThrow(/used by/);
    const updated = store.updateToken(token.id, { defaultConnectionId: prod.id, connectionIds: [prod.id] });
    expect(updated.connectionIds).toEqual([prod.id]);
    store.deleteConnection(client.id);
    store.close();
  });

  it("migrates databases from the single-connection schema", () => {
    const path = join(dir, "legacy.db");
    const legacy = new DatabaseSync(path);
    legacy.exec(`
      CREATE TABLE connections (id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, description TEXT NOT NULL DEFAULT '',
        token_enc TEXT NOT NULL, token_hint TEXT NOT NULL, read_only INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, last_check_at INTEGER, last_check_ok INTEGER, last_check_detail TEXT);
      CREATE TABLE mcp_tokens (id TEXT PRIMARY KEY, name TEXT NOT NULL, token_prefix TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE,
        connection_id TEXT NOT NULL REFERENCES connections(id), read_only INTEGER NOT NULL DEFAULT 0, allowed_ips TEXT NOT NULL DEFAULT '[]',
        categories TEXT, expires_at INTEGER, created_at INTEGER NOT NULL, last_used_at INTEGER, last_used_ip TEXT, revoked_at INTEGER);
      INSERT INTO connections (id, name, token_enc, token_hint, created_at, updated_at) VALUES ('c1', 'Old', 'x', 'abcd', 1, 1);
      INSERT INTO mcp_tokens (id, name, token_prefix, token_hash, connection_id, created_at) VALUES ('t1', 'Old token', 'imkt_', 'h', 'c1', 1);
    `);
    legacy.close();

    const store = new Store(path, "s".repeat(40));
    expect(store.getToken("t1")).toMatchObject({ connectionIds: ["c1"], defaultConnectionId: "c1" });
    expect(store.getConnection("c1")?.defaultAccountId).toBeNull();
    store.close();
  });
});
