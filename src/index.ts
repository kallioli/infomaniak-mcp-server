#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { Catalog } from "./catalog.js";
import { loadConfig } from "./config.js";
import { createHttpApp } from "./http.js";
import { InfomaniakClient } from "./infomaniak.js";
import { randomBytes } from "node:crypto";
import { oauthProviderFromSettings } from "./oauth/factory.js";
import { createAdminApp } from "./admin/app.js";
import { loadOrganisations } from "./organisations.js";
import { createServer } from "./server.js";
import { Settings } from "./settings.js";
import { openStore } from "./store/bootstrap.js";

const config = loadConfig();
const catalog = Catalog.load();
const client = new InfomaniakClient({ baseUrl: config.baseUrl });

if (process.argv.includes("--stdio")) {
  // Local mode, mostly for development: the token comes from the environment.
  if (!config.infomaniakToken) {
    console.error("INFOMANIAK_API_TOKEN is required in --stdio mode.");
    process.exit(1);
  }
  const connections = [{ name: "infomaniak", token: config.infomaniakToken }];
  const server = createServer({
    catalog,
    client,
    connections,
    organisations: await loadOrganisations(client, connections),
    readOnly: config.readOnly,
    maxResponseChars: config.maxResponseChars,
  });
  await server.connect(new StdioServerTransport());
} else {
  if (config.infomaniakToken && !config.apiKeys.length) {
    // Without API keys anyone reaching the server could spend this token.
    console.error("INFOMANIAK_API_TOKEN requires MCP_API_KEYS in HTTP mode.");
    process.exit(1);
  }
  const { store, secretKey } = openStore(config);
  const settings = new Settings(config, store);
  const oauth = oauthProviderFromSettings(settings, store);
  const app = createHttpApp(config, catalog, client, { oauth, store, settings: () => settings.effective() });
  const httpServer = app.listen(config.port, config.host, () => {
    const effective = settings.effective();
    const mode = ["managed tokens", effective.oauth ? "oauth" : undefined, config.apiKeys.length ? "api-key" : "token passthrough"]
      .filter(Boolean)
      .join(" + ");
    console.log(
      `infomaniak-mcp-server listening on http://${config.host}:${config.port}/mcp ` +
        `(${catalog.operations.length} operations, auth: ${mode}${effective.readOnly ? ", read-only" : ""})`,
    );
  });

  // Until an admin password exists, the portal runs the onboarding, unlocked by this one-time code.
  const setupCode = store.hasAdminPassword() ? undefined : randomBytes(6).toString("hex");
  const adminServer = config.admin.enabled
    ? createAdminApp({ config, store, catalog, client, secretKey, settings, setupCode }).listen(
        config.admin.port,
        config.admin.host,
        () => {
          const url = `http://${config.admin.host === "0.0.0.0" ? "localhost" : config.admin.host}:${config.admin.port}/`;
          console.log(`Admin portal listening on ${url}`);
          if (setupCode) console.log(`First launch: open ${url} to set the server up. Setup code: ${setupCode}`);
        },
      )
    : undefined;

  // As PID 1 in a container, Node gets no default signal handling: shut down explicitly.
  const shutdown = (signal: string) => {
    console.log(`${signal} received, shutting down`);
    adminServer?.close();
    adminServer?.closeIdleConnections();
    httpServer.close(() => {
      store.close();
      process.exit(0);
    });
    httpServer.closeIdleConnections();
    setTimeout(() => process.exit(0), 5_000).unref();
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}
