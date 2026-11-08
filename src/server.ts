import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult, Icon } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { type Catalog, type HttpMethod, type Operation, isDangerous } from "./catalog.js";
import type { InfomaniakClient } from "./infomaniak.js";
import { type Organisation, loadOrganisations } from "./organisations.js";
import { VERSION } from "./version.js";

/** A set of Infomaniak credentials the MCP client may act with. */
export interface ConnectionContext {
  name: string;
  token: string;
  readOnly?: boolean;
  /** Infomaniak organisation (account) used when the call does not name one. */
  defaultAccountId?: number | null;
}

export interface ServerOptions {
  catalog: Catalog;
  client: InfomaniakClient;
  /** Connections available to this request; the first one is the default. */
  connections: ConnectionContext[];
  /** Hides the write tool altogether. */
  readOnly?: boolean;
  maxResponseChars?: number;
  /**
   * Organisations of each connection (by connection name), from loadOrganisations. When given, they are listed in
   * the tool schemas and organisations can be named instead of given by id.
   */
  organisations?: Map<string, Organisation[] | string>;
  /** Logo shown by clients next to the server (MCP Implementation.icons). */
  icons?: Icon[];
}

/** At most this many organisations are spelled out in a tool schema; the rest are reachable by name or id. */
const MAX_LISTED_ORGANISATIONS = 50;

/** Parameter names through which Infomaniak endpoints receive the organisation id. */
const ACCOUNT_PARAMS = new Set(["account_id", "account"]);

const queryShape = z
  .record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.array(z.union([z.string(), z.number()]))]))
  .optional()
  .describe("Query string parameters, e.g. {\"page\": 2, \"per_page\": 50, \"with\": \"records\"}.");

const pathParamsShape = z
  .record(z.string(), z.union([z.string(), z.number()]))
  .optional()
  .describe("Values for {placeholders} when `path` is given as a template, e.g. {\"zone\": \"example.ch\"}.");

const kchatTeamShape = z
  .string()
  .optional()
  .describe("kChat team name, required for /api/v4 (kChat) paths: calls go to https://<team>.kchat.infomaniak.com.");


function text(content: string, isError = false): CallToolResult {
  return { content: [{ type: "text", text: content }], ...(isError ? { isError: true } : {}) };
}

function formatOperationLine(op: Operation): string {
  return `${op.method} ${op.path} — ${op.summary}${op.deprecated ? " (deprecated)" : ""} [${op.tag}]`;
}

function fillTemplate(path: string, params: Record<string, string | number> = {}): string {
  return path.replace(/\{([^}]+)\}/g, (whole, name: string) =>
    params[name] !== undefined ? encodeURIComponent(String(params[name])) : whole,
  );
}

export function createServer(options: ServerOptions): McpServer {
  const { catalog, client, connections, organisations, maxResponseChars = 60_000 } = options;
  if (!connections.length) throw new Error("At least one connection is required.");
  // The write tool exists if at least one connection may write.
  const readOnly = options.readOnly || connections.every((c) => c.readOnly);
  const multiple = connections.length > 1;
  const orgsOf = (c: ConnectionContext) => {
    const value = organisations?.get(c.name);
    return Array.isArray(value) ? value : [];
  };

  // The choices this token has are spelled out in the schema itself, so no extra call is needed to pick one.
  const connectionShape = multiple
    ? z
        .enum(connections.map((c) => c.name) as [string, ...string[]])
        .optional()
        .describe(
          `Infomaniak connection (set of credentials) to act with. Default: "${connections[0].name}". Available: ` +
            connections.map((c) => `"${c.name}"${c.readOnly ? " (read-only)" : ""}`).join(", ") +
            ".",
        )
    : undefined;

  const listed = connections.flatMap((c) =>
    orgsOf(c).map((o) => `${o.name} (${o.id}${multiple ? `, connection "${c.name}"` : ""}${o.id === c.defaultAccountId ? ", default" : ""})`),
  );
  const accountShape = z
    .union([z.number().int(), z.string()])
    .optional()
    .describe(
      [
        "Infomaniak organisation (account) to act on, by name or id; the matching connection is picked automatically.",
        "Filled into the endpoint's account_id/account parameter when you do not set it yourself.",
        listed.length
          ? `Known: ${listed.slice(0, MAX_LISTED_ORGANISATIONS).join("; ")}${listed.length > MAX_LISTED_ORGANISATIONS ? "; … (see infomaniak_list_accounts)" : ""}.`
          : "Use infomaniak_list_accounts to see them.",
      ].join(" "),
    );

  /** Picks the connection and organisation for a call from what the caller named, falling back to the defaults. */
  function resolveTarget(
    connectionName: string | undefined,
    account: string | number | undefined,
  ): { connection: ConnectionContext; accountId?: number } | { error: string } {
    let connection: ConnectionContext | undefined;
    if (connectionName) {
      connection = connections.find((c) => c.name.toLowerCase() === connectionName.trim().toLowerCase());
      if (!connection) {
        return { error: `Unknown connection "${connectionName}". Available: ${connections.map((c) => c.name).join(", ")}.` };
      }
    }
    if (account === undefined || account === "") {
      const chosen = connection ?? connections[0];
      return { connection: chosen, accountId: chosen.defaultAccountId ?? undefined };
    }

    const asId = typeof account === "number" ? account : /^\d+$/.test(account.trim()) ? Number(account) : undefined;
    const pool = connection ? [connection] : connections;
    const needle = String(account).trim().toLowerCase();
    const matches = (exact: boolean) =>
      pool.flatMap((c) =>
        orgsOf(c)
          .filter((o) => (asId !== undefined ? o.id === asId : exact ? o.name.toLowerCase() === needle : o.name.toLowerCase().includes(needle)))
          .map((o) => ({ connection: c, organisation: o })),
      );
    let found = matches(true);
    if (!found.length && asId === undefined) found = matches(false);

    if (asId !== undefined) {
      // An id is usable as is; when organisations are known, it also selects the connection that can reach it.
      return { connection: connection ?? found[0]?.connection ?? connections[0], accountId: asId };
    }
    const distinct = new Map(found.map((f) => [`${f.connection.name}/${f.organisation.id}`, f]));
    if (distinct.size === 1) {
      const [{ connection: c, organisation }] = distinct.values();
      return { connection: c, accountId: organisation.id };
    }
    if (distinct.size > 1) {
      const options = [...distinct.values()].map((f) => `${f.organisation.name} (${f.organisation.id}, connection "${f.connection.name}")`);
      return { error: `"${account}" matches several organisations: ${options.join("; ")}. Pass the id or the connection.` };
    }
    const known = pool.flatMap((c) => orgsOf(c).map((o) => o.name));
    return {
      error: known.length
        ? `Unknown organisation "${account}". Known: ${known.join(", ")}.`
        : `Organisation "${account}" cannot be resolved by name (organisation list unavailable); pass its numeric id.`,
    };
  }
  const server = new McpServer(
    { name: "infomaniak-mcp-server", version: VERSION, ...(options.icons?.length ? { icons: options.icons } : {}) },
    {
      instructions: [
        "Gives access to the whole Infomaniak API (domains, DNS, hosting, kDrive, mail, kSuite, Public Cloud, streaming, etc.).",
        "Workflow: 1) infomaniak_search_operations to find the endpoint, 2) infomaniak_describe_operation for its parameters and body,",
        "3) infomaniak_get for reads or infomaniak_request for writes.",
        "Most resources are scoped by an organisation (account) or product id: call infomaniak_list_accounts first to see the",
        "connections and organisations you can act on, then pass `account` (name or id) and, if needed, `connection` to switch between them.",
        "Responses are wrapped as {result, data}; list endpoints paginate with `page` and `per_page`.",
        "Operations marked undocumented (web hosting, /domain DNS API, orders, invoicing…) come from the Infomaniak manager,",
        "not from the official spec: they work with API tokens but may change; those with verified: false were never executed.",
        "Deletions, restores, orders and transfers need the user's explicit confirmation.",
      ].join(" "),
    },
  );

  /**
   * Asks for confirmation of a dangerous call. When the client supports elicitation, the user is asked directly and
   * `confirm` is not enough; otherwise the assistant must have confirmed with the user and pass confirm: true.
   */
  async function confirmDangerous(
    op: Operation,
    method: HttpMethod,
    path: string,
    connectionName: string,
    confirm: boolean | undefined,
  ): Promise<CallToolResult | undefined> {
    const what = `${method} ${path}${op.summary ? ` (${op.summary})` : ""}${multiple ? ` with connection "${connectionName}"` : ""}`;
    if (server.server.getClientCapabilities()?.elicitation) {
      try {
        const answer = await server.server.elicitInput({
          message: `Confirm this Infomaniak action, which may be irreversible or billed: ${what}`,
          requestedSchema: {
            type: "object",
            properties: { confirm: { type: "boolean", title: "Confirm", description: "Run this action" } },
            required: ["confirm"],
          },
        });
        if (answer.action === "accept" && answer.content?.confirm === true) return undefined;
        return text(`Cancelled: the user did not confirm ${what}.`, true);
      } catch (err) {
        return text(`Could not ask the user to confirm ${what}: ${(err as Error).message}`, true);
      }
    }
    if (confirm === true) return undefined;
    return text(
      `${op.id} needs an explicit confirmation (irreversible or billed action). Describe its exact effect to the user, ` +
        "get their confirmation, then retry with confirm: true.",
      true,
    );
  }

  async function execute(
    method: HttpMethod,
    rawPath: string,
    pathParams: Record<string, string | number> | undefined,
    query: Record<string, unknown> | undefined,
    body: unknown,
    target: { kchatTeam?: string; connection?: string; account?: string | number; confirm?: boolean } = {},
  ): Promise<CallToolResult> {
    const resolved = resolveTarget(target.connection, target.account);
    if ("error" in resolved) return text(resolved.error, true);
    const { connection, accountId } = resolved;
    if (method !== "GET" && connection.readOnly) {
      return text(`Connection "${connection.name}" is read-only: ${method} requests are not allowed.`, true);
    }

    // The selected organisation fills the account placeholders the caller left open.
    const params = { ...pathParams };
    if (accountId !== undefined) {
      for (const name of ACCOUNT_PARAMS) {
        if (params[name] === undefined && rawPath.includes(`{${name}}`)) params[name] = accountId;
      }
    }
    const path = fillTemplate(rawPath.startsWith("/") ? rawPath : `/${rawPath}`, params);
    if (/\{[^}]+\}/.test(path)) {
      return text(`Unresolved placeholders in path ${path}. Provide them in path_params.`, true);
    }
    const matched = catalog.match(method, path);
    if (!matched) {
      return text(
        `No Infomaniak operation matches ${method} ${path}, or its category is not enabled for this token. ` +
          "Use infomaniak_search_operations to find the right endpoint.",
        true,
      );
    }
    const { op } = matched;
    if (accountId !== undefined) {
      const accountParam = op.params.find((p) => p.in === "query" && ACCOUNT_PARAMS.has(p.name));
      if (accountParam && query?.[accountParam.name] === undefined) query = { ...query, [accountParam.name]: accountId };
    }
    const missing = op.params
      .filter((p) => p.in === "query" && p.required && (query?.[p.name] === undefined))
      .map((p) => p.name);
    if (missing.length) {
      return text(`Missing required query parameter(s) for ${op.id}: ${missing.join(", ")}.`, true);
    }
    if (body !== undefined && op.body && op.body.contentType !== "application/json") {
      return text(`${op.id} expects a ${op.body.contentType} body, which this server does not support yet.`, true);
    }
    // Checked here, once the path is normalised and resolved, so no spelling of the path can skip it.
    if (isDangerous(op)) {
      const refusal = await confirmDangerous(op, method, path, connection.name, target.confirm);
      if (refusal) return refusal;
    }

    let baseUrl: string | undefined;
    if (path.startsWith("/api/v4/")) {
      const team = target.kchatTeam;
      if (!team || !/^[a-z0-9][a-z0-9-]{0,62}$/i.test(team)) {
        return text("kChat endpoints need a valid kchat_team (the <team> in <team>.kchat.infomaniak.com).", true);
      }
      baseUrl = `https://${team}.kchat.infomaniak.com`;
    }

    let res;
    try {
      res = await client.request({ token: connection.token, method, path, query, body, baseUrl });
    } catch (err) {
      return text(`Request to Infomaniak failed: ${(err as Error).message}`, true);
    }

    let output = typeof res.data === "string" ? res.data : JSON.stringify(res.data, null, 2);
    if (output.length > maxResponseChars) {
      output = `${output.slice(0, maxResponseChars)}\n… [truncated ${output.length - maxResponseChars} characters — narrow the request with filters or pagination (page/per_page)]`;
    }
    const via = [multiple ? `connection: ${connection.name}` : undefined, accountId !== undefined ? `account: ${accountId}` : undefined]
      .filter(Boolean)
      .join(", ");
    return text(`HTTP ${res.status} ${op.id}${via ? ` [${via}]` : ""}\n${output}`, !res.ok);
  }

  server.registerTool(
    "infomaniak_list_accounts",
    {
      title: "List Infomaniak connections and organisations",
      description:
        "Lists the connections (Infomaniak credentials) available to you and, for each, the organisations (accounts) it " +
        "can act on, with the defaults. Use the names and ids with the `connection` and `account_id` parameters of " +
        "infomaniak_get / infomaniak_request to switch between them.",
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async () => {
      const all = organisations ?? (await loadOrganisations(client, connections));
      const blocks = connections.map((c, index) => {
        const flags = [index === 0 ? "default" : undefined, c.readOnly ? "read-only" : "read/write"].filter(Boolean);
        const header = `Connection "${c.name}" (${flags.join(", ")})`;
        const list = all.get(c.name);
        if (typeof list === "string" || list === undefined) {
          return `${header}\n  (organisations unavailable: ${list ?? "not loaded"}; the token may lack the "accounts" scope)`;
        }
        if (!list.length) return `${header}\n  (no organisation visible with this token)`;
        const lines = list.map((o) => `  - ${o.name} — account ${o.id}${o.id === c.defaultAccountId ? " (default)" : ""}`);
        return [header, ...lines].join("\n");
      });
      return text(blocks.join("\n\n"));
    },
  );

  server.registerTool(
    "infomaniak_list_categories",
    {
      title: "List Infomaniak API categories",
      description: "Lists every category (tag) of the Infomaniak API with its number of operations. Useful to discover what the API covers.",
      inputSchema: {
        filter: z.string().optional().describe("Only return categories containing this text (case-insensitive), e.g. \"drive\"."),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ filter }) => {
      const needle = filter?.toLowerCase();
      const tags = catalog.tags().filter((t) => !needle || t.tag.toLowerCase().includes(needle));
      return text(tags.map((t) => `${t.tag} (${t.count})`).join("\n") || "No category matches.");
    },
  );

  server.registerTool(
    "infomaniak_search_operations",
    {
      title: "Search Infomaniak API operations",
      description:
        "Full-text search over the ~1600 Infomaniak API operations (summary, category, path, description). " +
        "Search in English, e.g. \"dns record\", \"kdrive files\", \"mailbox alias\", \"hosting database\".",
      inputSchema: {
        query: z.string().describe("Keywords in English."),
        tag: z.string().optional().describe("Restrict to categories containing this text, e.g. \"Drive\" or \"Mail\"."),
        method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]).optional(),
        limit: z.number().int().min(1).max(100).optional().describe("Max results (default 20)."),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ query, tag, method, limit }) => {
      const results = catalog.search({ query, tag, method, limit: limit ?? 20 });
      if (!results.length) return text("No operation found. Try other English keywords or infomaniak_list_categories.");
      return text(results.map(formatOperationLine).join("\n"));
    },
  );

  server.registerTool(
    "infomaniak_describe_operation",
    {
      title: "Describe an Infomaniak API operation",
      description:
        "Returns the parameters, request body schema and required OAuth scopes of one operation. " +
        "`operation` is \"METHOD /path\" exactly as returned by infomaniak_search_operations; a concrete path also works.",
      inputSchema: {
        operation: z.string().describe("e.g. \"POST /2/zones/{zone}/records\""),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ operation }) => {
      const [method, ...rest] = operation.trim().split(/\s+/);
      const path = rest.join("");
      const upper = method?.toUpperCase() as HttpMethod;
      const op = catalog.get(`${upper} ${path}`) ?? catalog.match(upper, path)?.op;
      if (!op) return text(`Unknown operation "${operation}". Use infomaniak_search_operations first.`, true);
      const details = {
        operation: op.id,
        category: op.tag,
        summary: op.summary,
        description: op.description,
        deprecated: op.deprecated,
        undocumented: op.undocumented,
        ...(op.verified === false ? { verified: false, note: "Seen in the manager but never executed with an API token: body and response are not documented." } : {}),
        needsConfirmation: isDangerous(op),
        scopes: op.scopes,
        parameters: op.params,
        body: op.body && { ...op.body, schema: catalog.resolveSchema(op.body.schema) },
        responseType: op.responseType ?? "application/json",
        tool: op.method === "GET" ? "infomaniak_get" : "infomaniak_request",
      };
      return text(JSON.stringify(details, null, 2));
    },
  );

  server.registerTool(
    "infomaniak_get",
    {
      title: "Read from the Infomaniak API",
      description:
        "Performs a GET request on the Infomaniak API. `path` may be concrete (/2/zones/example.ch/records) " +
        "or a template (/2/zones/{zone}/records) combined with path_params.",
      inputSchema: {
        path: z.string().describe("API path starting with the version, e.g. /1/products"),
        path_params: pathParamsShape,
        query: queryShape,
        account: accountShape,
        ...(connectionShape ? { connection: connectionShape } : {}),
        kchat_team: kchatTeamShape,
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ path, path_params, query, account, connection, kchat_team }) =>
      execute("GET", path, path_params, query, undefined, { connection, account, kchatTeam: kchat_team }),
  );

  if (!readOnly) {
    server.registerTool(
      "infomaniak_request",
      {
        title: "Modify resources through the Infomaniak API",
        description:
          "Performs a POST, PUT, PATCH or DELETE request on the Infomaniak API. These calls change real resources " +
          "(and may incur costs): check the operation with infomaniak_describe_operation and confirm intent before calling.",
        inputSchema: {
          method: z.enum(["POST", "PUT", "PATCH", "DELETE"]),
          path: z.string().describe("API path, concrete or template, e.g. /2/zones/{zone}/records"),
          path_params: pathParamsShape,
          query: queryShape,
          body: z.unknown().optional().describe("JSON request body, as described by infomaniak_describe_operation."),
          confirm: z
            .boolean()
            .optional()
            .describe(
              "Set to true only after the user explicitly confirmed, for operations needing confirmation (deletions, restores, orders…; see needsConfirmation in infomaniak_describe_operation).",
            ),
          account: accountShape,
          ...(connectionShape ? { connection: connectionShape } : {}),
          kchat_team: kchatTeamShape,
        },
        annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
      },
      async ({ method, path, path_params, query, body, confirm, account, connection, kchat_team }) =>
        execute(method, path, path_params, query, body, { connection, account, kchatTeam: kchat_team, confirm }),
    );
  }

  return server;
}
