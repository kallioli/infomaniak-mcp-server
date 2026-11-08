<p align="center"><img src="docs/logo.svg" width="96" alt=""></p>

# infomaniak-mcp-server

Remote [Model Context Protocol](https://modelcontextprotocol.io) server that exposes the **whole Infomaniak API**
(~1600 operations: domains & DNS, kDrive, Mail, kSuite, kChat, Public Cloud, Swiss Backup, streaming, VOD, newsletters…)
over Streamable HTTP.

Instead of one tool per endpoint, the server ships a compiled catalog of the official
[OpenAPI spec](https://developer.infomaniak.com/openapi.json) and exposes a small set of tools:

| Tool | Purpose |
| --- | --- |
| `infomaniak_list_accounts` | Connections and Infomaniak organisations (accounts) available, with the defaults |
| `infomaniak_list_categories` | Browse API categories and their size |
| `infomaniak_search_operations` | Full-text search of operations (English keywords) |
| `infomaniak_describe_operation` | Parameters, body schema and OAuth scopes of one operation |
| `infomaniak_get` | GET requests (read-only, safe to auto-approve) |
| `infomaniak_request` | POST / PUT / PATCH / DELETE (hidden when `INFOMANIAK_READ_ONLY=true`) |

Calls are validated against the catalog, so only documented endpoints can be reached.

### Undocumented endpoints (ik-api-explore)

`npm run catalog` also merges `spec/infomaniak-extensions.openapi.json`: operations the Infomaniak manager performs
with API tokens but the official spec omits (web hosting, `/domain` DNS API, orders and cart, invoicing, account users
and permissions…), corrections of official operations and missing parameters. `infomaniak_describe_operation` shows
them as `undocumented: true`, and `verified: false` for those never executed with a token. The **Orders** and
**Invoicing & Payments** categories are disabled by default. Details: [docs/ik-extensions.md](docs/ik-extensions.md).

### Confirmation of risky operations

Every `DELETE`, restore, checkout and transfer, and the operations flagged dangerous, need the user's explicit
confirmation: `infomaniak_request` asks the user through MCP elicitation when the client supports it; otherwise it
refuses the call unless the assistant passes `confirm: true` after confirming with the user.

### Multiple organisations and accounts

Works like the multi-server mode of initMAX's Zabbix MCP server, with two levels, chosen **per call** (the server
stays stateless):

- **Connection** — a set of Infomaniak credentials (your company, customer A, customer B…), the equivalent of a
  `[zabbix.<name>]` entry. A managed MCP token is bound to one or more connections, one being its default, and only
  ever sees its own. A read-only connection refuses writes even if the token may write.
- **Organisation** — the Infomaniak accounts a login can manage (`GET /1/accounts`). Each connection can have a
  default organisation.

`infomaniak_get` / `infomaniak_request` take `account` (organisation **name or id**) and, with several connections,
`connection`. Both are spelled out in the tool schema with the token's own choices, so the assistant maps
"list the domains of ACME" to the right connection and organisation without extra calls; an ambiguous name is
refused with the candidates. The organisation is filled into the endpoint's `account_id` / `account` path or query
parameter when the call does not set it. `infomaniak_list_accounts` shows everything with the defaults.

## First launch

Start the container and open the admin portal (port 9090). The logs print a one-time **setup code**:

```
First launch: open http://localhost:9090/ to set the server up. Setup code: 3f9a1c2b7d04
```

The onboarding wizard then walks through: admin password (unlocked by the code, so nobody reaching the port first
can take over), public URL / reverse proxy / global read-only mode, the first Infomaniak connection (tested live, with
its default organisation), OAuth (optional: shows the redirect URI to register at Infomaniak), and the first MCP token
with a ready-to-paste client command.

These settings live in the database and remain editable in **Settings**, applied without restart (OAuth can be turned
on or reconfigured live). Environment variables still work and take precedence: a setting defined by one is shown
locked in the portal, which suits GitOps deployments. With `ADMIN_PASSWORD` set, the wizard starts after login.

## Admin portal

A web UI on a **separate port** (default `9090`) manages the server without editing environment variables:

| Page | What it does |
| --- | --- |
| Dashboard | Health, catalog size, exposed categories, token counts, connection status, enabled auth modes, MCP URL |
| Infomaniak connections | Infomaniak API tokens the server acts with (one per account or customer), encrypted at rest, with a live **test** against the API and a default organisation picked from the live list |
| MCP tokens | Named tokens (`imkt_…`, shown once, stored hashed) granted one or more connections (one default), with read-only flag, allowed API categories, IP/CIDR allow-list and expiry; revocation is immediate; ready-to-paste client config |
| OAuth access | Rules granting shared connections to people who sign in with Infomaniak, default policy, recent sign-ins |
| Tool exposure | Enable/disable API categories (kDrive, Mail Services, Domain & Zone…) for every client, applied without restart |
| Settings | Public URL, reverse proxy, global read-only mode, response size, OAuth application — stored in the database |

Log in with the password chosen during onboarding (or `ADMIN_PASSWORD`). Data lives in a SQLite
database under `DATA_DIR` (mount it as a volume). Keep port 9090 private: publish only the MCP port through your
reverse proxy, and reach the admin through a VPN, SSH tunnel or a restricted vhost.

Front-end development: run the server with `ADMIN_PORT=9090`, then `npm run dev:admin` (Vite on :5173, proxied API).

## Authentication

Four modes, which can be combined:

- **Managed MCP tokens (recommended for teams):** created in the admin portal; each acts through a stored Infomaniak
  connection with its own restrictions. Clients send `Authorization: Bearer imkt_…`.
- **OAuth – "Sign in with Infomaniak":** MCP clients such as claude.ai or Claude Code discover the
  server's OAuth endpoints, register themselves and send the user to `login.infomaniak.com`. See below.
- **Token passthrough (default):** create an API token at
  <https://manager.infomaniak.com/v3/ng/accounts/token/list>; the client sends it as `Authorization: Bearer <token>`.
  The server stores nothing.
- **API keys:** set `MCP_API_KEYS`; clients send `Authorization: Bearer <key>` and either their token in
  `X-Infomaniak-Token` or rely on the server-side `INFOMANIAK_API_TOKEN`.
  The server refuses to start with `INFOMANIAK_API_TOKEN` but no `MCP_API_KEYS`.

See [.env.example](.env.example) for every setting.

### OAuth setup

1. Create an OAuth application in the Infomaniak Manager with the redirect URI `https://<your-server>/oauth/callback`.
2. Enter the public URL, client id and client secret in the portal (onboarding or **Settings**), or through the
   environment:

   ```bash
   PUBLIC_URL=https://mcp.example.com
   INFOMANIAK_OAUTH_CLIENT_ID=...
   INFOMANIAK_OAUTH_CLIENT_SECRET=...
   TRUST_PROXY=1            # behind a reverse proxy
   # OAUTH_SECRET=...       # optional, generated and stored when unset
   ```

3. Add the server in your client with just its URL (`https://mcp.example.com/mcp`); the client handles the login.

#### What OAuth users get: access rules

By default, someone who signs in with Infomaniak acts with **their own login only**. The **OAuth access** page of the
admin portal grants more, through rules matching the signed-in user by Infomaniak user id, e-mail address or e-mail
domain (e.g. everyone `@stackops.ch`). A rule grants shared connections (one default), optionally the user's own
login (shown to the assistant as the `Personal` connection), read-only mode and allowed categories — the same
multi-organisation behaviour as managed tokens, for claude.ai and other OAuth clients.

- The identity comes from Infomaniak's OpenID Connect `userinfo` endpoint (`openid` and `email` scopes) and travels
  inside the sealed tokens; e-mail and domain rules only match addresses Infomaniak reports as **verified**.
- Rules are evaluated on **every request**: editing or disabling one applies immediately to already signed-in users.
- The default policy for users no rule matches is either *personal login only* or *deny* (the server is then
  reserved to the people covered by a rule; they are refused at login with an explanation).
- Recent sign-ins are listed, including refused ones, with a one-click "create a rule" for each.

How it works: Infomaniak has no dynamic client registration and only accepts confidential clients, whereas MCP
clients register dynamically and use PKCE. The server therefore acts as the OAuth authorization server for MCP
clients (`/register`, `/authorize`, `/token`, `/.well-known/...`) and as a confidential client of Infomaniak.
It is **stateless**: registered clients, pending logins, authorization codes and tokens are AES-256-GCM sealed
blobs keyed by `OAUTH_SECRET`; access tokens (`imcp_…`) wrap the Infomaniak access token and expire with it, refresh
tokens wrap the Infomaniak refresh token. No database is needed and instances can be scaled horizontally, as long as
they share `OAUTH_SECRET`. Trade-off: authorization codes (valid 5 minutes, bound to the client and its PKCE
challenge) cannot be strictly single-use, and tokens cannot be revoked server-side before they expire — rotating
`OAUTH_SECRET` invalidates all of them.

## Running

```bash
npm install
npm run build
npm start                    # http://0.0.0.0:3000/mcp, health check on /health
```

### Container

The image is built from the [Containerfile](Containerfile) (multi-stage, Node 24 Alpine, runs as `node`, ~200 MB,
data in the `/data` volume, admin port bound to localhost in the example below):

```bash
podman build --format docker -t infomaniak-mcp-server .   # --format docker keeps the HEALTHCHECK
podman run -d --name infomaniak-mcp-server -p 3000:3000 -p 127.0.0.1:9090:9090 \
  -v infomaniak-mcp-data:/data --env-file .env infomaniak-mcp-server
```

With Docker: `docker build -f Containerfile -t infomaniak-mcp-server .` then the same `run` command.

Put it behind HTTPS (reverse proxy) before exposing it: tokens travel in request headers.

Local stdio mode, for development: `INFOMANIAK_API_TOKEN=... node dist/index.js --stdio`.

## Client configuration

Claude Code with OAuth (then run `/mcp` to sign in):

```bash
claude mcp add --transport http infomaniak https://mcp.example.com/mcp
```

Claude Code with an API token:

```bash
claude mcp add --transport http infomaniak https://mcp.example.com/mcp \
  --header "Authorization: Bearer $INFOMANIAK_TOKEN"
```

claude.ai: Settings → Connectors → Add custom connector → `https://mcp.example.com/mcp`.

## Development

```bash
npm run dev        # watch mode
npm test           # vitest
npm run catalog    # refresh src/catalog.json from the live OpenAPI spec
```
