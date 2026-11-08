import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { createAdminApp } from "../src/admin/app.js";
import { Catalog, SENSITIVE_CATEGORIES } from "../src/catalog.js";
import { loadConfig } from "../src/config.js";
import { createHttpApp } from "../src/http.js";
import { InfomaniakClient } from "../src/infomaniak.js";
import { oauthProviderFromSettings } from "../src/oauth/factory.js";
import { Settings } from "../src/settings.js";
import { Store } from "../src/store/db.js";

const SECRET = "k".repeat(40);
const dir = mkdtempSync(join(tmpdir(), "imcp-settings-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
let n = 0;
const newStore = () => new Store(join(dir, `s${n++}.db`), SECRET);
const catalog = Catalog.load();
const client = new InfomaniakClient({ fetch: (async () => Response.json({ result: "success", data: [] })) as typeof fetch });

async function listen(app: { listen: (port: number, host: string) => any }) {
  const server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  return { server, url: `http://127.0.0.1:${server.address().port}` };
}

describe("settings", () => {
  it("stores settings in the database, secrets encrypted", () => {
    const store = newStore();
    const settings = new Settings(loadConfig({}), store, {});
    expect(settings.effective()).toMatchObject({ readOnly: false, maxResponseChars: 60_000, oauth: undefined });

    settings.update({ publicUrl: "https://mcp.example.com/", readOnly: true, oauthClientId: "app", oauthClientSecret: "s3cret" });
    const effective = settings.effective();
    expect(effective.publicUrl?.href).toBe("https://mcp.example.com/");
    expect(effective.readOnly).toBe(true);
    expect(effective.oauth).toMatchObject({ clientId: "app", clientSecret: "s3cret" });
    // The sealing secret is generated once and kept.
    expect(effective.oauth!.secret.length).toBeGreaterThanOrEqual(32);
    expect(settings.effective().oauth!.secret).toBe(effective.oauth!.secret);

    const view = settings.view();
    expect(view.callbackUrl).toBe("https://mcp.example.com/oauth/callback");
    expect(view.oauthActive).toBe(true);
    expect(JSON.stringify(view)).not.toContain("s3cret");
    expect(store.getSetting("settings.oauthClientSecret", "")).not.toContain("s3cret");

    settings.update({ oauthClientSecret: null });
    expect(settings.effective().oauth).toBeUndefined();
    store.close();
  });

  it("lets environment variables win and lock the setting", () => {
    const store = newStore();
    const env = { PUBLIC_URL: "https://env.example.com", INFOMANIAK_READ_ONLY: "true" };
    const settings = new Settings(loadConfig(env), store, env);
    expect(settings.view().locked).toEqual({ publicUrl: "PUBLIC_URL", readOnly: "INFOMANIAK_READ_ONLY" });
    expect(settings.values()).toMatchObject({ publicUrl: "https://env.example.com", readOnly: true });
    expect(() => settings.update({ publicUrl: "https://other.example.com" })).toThrow(/PUBLIC_URL/);
    settings.update({ maxResponseChars: 5000 });
    expect(settings.effective().maxResponseChars).toBe(5000);
    store.close();
  });

  it("validates values before writing any", () => {
    const store = newStore();
    const settings = new Settings(loadConfig({}), store, {});
    expect(() => settings.update({ publicUrl: "http://mcp.example.com" })).toThrow(/https/);
    expect(() => settings.update({ publicUrl: "https://mcp.example.com/sub" })).toThrow(/origin/);
    expect(settings.update({ publicUrl: "http://localhost:3000" }).values.publicUrl).toBe("http://localhost:3000");
    expect(() => settings.update({ readOnly: true, maxResponseChars: 10 })).toThrow(/between/);
    expect(settings.values().readOnly).toBe(false);
    expect(() => settings.update({ oauthScopes: ["ok", "not ok"] })).toThrow(/scope/);
    store.close();
  });
});

describe("sensitive categories", () => {
  it("are disabled the first time they appear, then follow the admin's choice", () => {
    const store = newStore();
    store.syncCategories(["kDrive", "Orders"], SENSITIVE_CATEGORIES);
    expect(store.disabledCategories()).toEqual(["Orders"]);

    // The admin enables Orders; a later catalog brings a new sensitive category.
    store.setDisabledCategories([]);
    store.syncCategories(["kDrive", "Orders", "Invoicing & Payments"], SENSITIVE_CATEGORIES);
    expect(store.disabledCategories()).toEqual(["Invoicing & Payments"]);
    store.close();
  });

  it("are not exposed by default through the MCP endpoint", async () => {
    const store = newStore();
    createHttpApp(loadConfig({ HOST: "127.0.0.1" }), catalog, client, { store });
    expect(store.disabledCategories()).toEqual([...SENSITIVE_CATEGORIES].sort());
    store.close();
  });
});

describe("onboarding", () => {
  it("creates the admin account with the one-time setup code", async () => {
    const store = newStore();
    const config = loadConfig({ HOST: "127.0.0.1" });
    const { server, url } = await listen(
      createAdminApp({ config, store, catalog, client, secretKey: SECRET, settings: new Settings(config, store, {}), setupCode: "abc123" }),
    );
    const post = (path: string, body: object, cookie?: string) =>
      fetch(`${url}/api${path}`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-requested-with": "infomaniak-mcp-admin", ...(cookie ? { cookie } : {}) },
        body: JSON.stringify(body),
      });
    try {
      expect(await (await fetch(`${url}/api/auth/me`)).json()).toEqual({ authenticated: false, needsSetup: true, setupCompleted: false });
      expect((await post("/setup/admin", { setupCode: "wrong1", password: "a-long-password" })).status).toBe(401);
      expect((await post("/setup/admin", { setupCode: "abc123", password: "short" })).status).toBe(400);

      const ok = await post("/setup/admin", { setupCode: "ABC123", password: "a-long-password" });
      expect(ok.status).toBe(200);
      const cookie = ok.headers.get("set-cookie")!.split(";")[0];
      expect(store.verifyAdminPassword("a-long-password")).toBe(true);
      // The code is single use.
      expect((await post("/setup/admin", { setupCode: "abc123", password: "another-password" })).status).toBe(409);

      // The rest of the wizard uses the normal, authenticated API.
      const put = await fetch(`${url}/api/settings`, {
        method: "PUT",
        headers: { "content-type": "application/json", "x-requested-with": "infomaniak-mcp-admin", cookie },
        body: JSON.stringify({ publicUrl: "https://mcp.example.com" }),
      });
      expect((await put.json()).values.publicUrl).toBe("https://mcp.example.com");
      expect((await (await post("/setup/complete", {}, cookie)).json()).setupCompleted).toBe(true);
      expect(await (await fetch(`${url}/api/auth/me`, { headers: { cookie } })).json()).toEqual({
        authenticated: true,
        needsSetup: false,
        setupCompleted: true,
      });
    } finally {
      server.close();
      store.close();
    }
  });
});

describe("hot reconfiguration", () => {
  it("turns OAuth on and off on the MCP endpoint without restart", async () => {
    const store = newStore();
    const config = loadConfig({ HOST: "127.0.0.1" });
    const settings = new Settings(config, store, {});
    const app = createHttpApp(config, catalog, client, {
      store,
      oauth: oauthProviderFromSettings(settings, store),
      settings: () => settings.effective(),
    });
    const { server, url } = await listen(app);
    const metadata = () => fetch(`${url}/.well-known/oauth-authorization-server`);
    const unauthenticated = () =>
      fetch(`${url}/mcp`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) });
    try {
      expect((await metadata()).status).toBe(404);
      expect((await unauthenticated()).headers.get("www-authenticate")).not.toContain("resource_metadata");

      settings.update({ publicUrl: url.replace("127.0.0.1", "localhost"), oauthClientId: "app", oauthClientSecret: "secret" });
      const meta = await metadata();
      expect(meta.status).toBe(200);
      expect((await meta.json()).authorization_endpoint).toContain("/authorize");
      expect((await unauthenticated()).headers.get("www-authenticate")).toContain("resource_metadata");

      settings.update({ oauthClientId: null });
      expect((await metadata()).status).toBe(404);
    } finally {
      server.close();
      store.close();
    }
  });
});
