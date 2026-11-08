<p align="center"><img src="docs/logo.svg" width="96" alt=""></p>

# infomaniak-mcp-server

[![CI](https://github.com/kallioli/infomaniak-mcp-server/actions/workflows/ci.yml/badge.svg)](https://github.com/kallioli/infomaniak-mcp-server/actions/workflows/ci.yml)

A remote [Model Context Protocol](https://modelcontextprotocol.io) server that gives AI assistants (Claude, Cursor,
VS Code…) access to the **whole Infomaniak API**, with a web admin portal to manage who can do what.

> **Unofficial project**, not affiliated with or endorsed by Infomaniak. "Infomaniak" is a trademark of Infomaniak
> Network SA. Part of the catalog relies on undocumented API operations that may change or break without notice.

## Features

- **The whole API, a handful of tools.** 1,787 operations — domains & DNS, web hosting, kDrive, Mail, kSuite, kChat,
  Public Cloud, Swiss Backup, streaming, VOD, newsletters… — reachable through six tools instead of one tool per
  endpoint. Every call is validated against the catalog.
- **Several accounts.** One server, many Infomaniak logins and organisations; the assistant picks the right one per
  call ("list the domains of ACME").
- **Fine-grained access.** MCP tokens with read-only mode, allowed API categories, IP allow-list and expiry; "Sign in
  with Infomaniak" (OAuth) with rules per user, e-mail or domain.
- **Safe by default.** Deletions, restores, orders and transfers need the user's explicit confirmation; ordering and
  billing categories are off until you enable them.
- **Admin portal.** Guided first-launch setup, then everything is managed from a web UI (English / French), applied
  without restart.
- **Easy to run.** One container image (amd64 / arm64), a SQLite file for state, stateless MCP endpoint.

## Quick start

```bash
podman run -d --name infomaniak-mcp-server \
  -p 3000:3000 -p 127.0.0.1:9090:9090 \
  -v infomaniak-mcp-data:/data \
  ghcr.io/kallioli/infomaniak-mcp-server:latest

podman logs infomaniak-mcp-server | grep "Setup code"
```

Open <http://localhost:9090>, enter the setup code and follow the wizard:

1. **Admin account** — the one-time code from the logs proves you own the server.
2. **Access & security** — public URL, reverse proxy, global read-only mode.
3. **Infomaniak connection** — paste an API token created in the
   [Infomaniak Manager](https://manager.infomaniak.com/v3/ng/accounts/token/list) (at least the `accounts` scope, plus
   the products you want to drive); it is tested live and you pick a default organisation.
4. **OAuth** (optional) — enables "Sign in with Infomaniak" for claude.ai.
5. **MCP token** — generated with a ready-to-paste client command.

Docker works the same way (`docker run …` with the same options).

## Connecting a client

The MCP endpoint is `http://<host>:3000/mcp` (or your public HTTPS URL).

**Claude Code**, with an MCP token from the portal:

```bash
claude mcp add --transport http infomaniak https://mcp.example.com/mcp \
  --header "Authorization: Bearer imkt_…"
```

**Claude Code with OAuth**: `claude mcp add --transport http infomaniak https://mcp.example.com/mcp`, then `/mcp` to
sign in.

**claude.ai**: Settings → Connectors → Add custom connector → `https://mcp.example.com/mcp`. claude.ai reaches the
server from the internet, so it needs a public HTTPS URL and OAuth enabled.

**Claude Desktop and other clients without custom headers** can go through
[`mcp-remote`](https://www.npmjs.com/package/mcp-remote):

```json
{
  "mcpServers": {
    "infomaniak": {
      "command": "npx",
      "args": ["-y", "mcp-remote", "http://localhost:3000/mcp", "--header", "Authorization:${AUTH}"],
      "env": { "AUTH": "Bearer imkt_…" }
    }
  }
}
```

## How it works

### Tools

| Tool | Purpose |
| --- | --- |
| `infomaniak_list_accounts` | Connections and organisations available, with the defaults |
| `infomaniak_list_categories` | API categories and their number of operations |
| `infomaniak_search_operations` | Full-text search of operations (English keywords) |
| `infomaniak_describe_operation` | Parameters, body schema, OAuth scopes and safety flags of one operation |
| `infomaniak_get` | GET requests (read-only, safe to auto-approve) |
| `infomaniak_request` | POST / PUT / PATCH / DELETE (hidden in read-only mode) |

The assistant searches the catalog, reads the operation's description, then calls it. kChat calls are routed to
`<team>.kchat.infomaniak.com`.

### Connections and organisations

Two levels, chosen **per call**:

- **Connection** — a set of Infomaniak credentials: your company, customer A, customer B… An MCP token is granted one
  or more connections, one being its default, and never sees the others. A read-only connection refuses writes.
- **Organisation** — the Infomaniak accounts a login can manage. Each connection can have a default one.

`infomaniak_get` and `infomaniak_request` take `account` (organisation **name or id**) and, when several connections
are available, `connection`. The token's own choices are listed in the tool schema, so the assistant needs no extra
call to pick them; an ambiguous name is refused with the candidates. The organisation is filled into the endpoint's
`account_id` / `account` parameter when the call does not set it.

### Confirmation of risky operations

Every `DELETE`, restore, checkout and transfer — documented or not — needs the user's explicit confirmation. When the
client supports MCP elicitation, the server asks the user directly; otherwise the call is refused until the assistant
confirms with the user and retries with `confirm: true`. `infomaniak_describe_operation` shows `needsConfirmation`.

### Undocumented operations

The official [OpenAPI spec](https://developer.infomaniak.com/openapi.json) misses part of what the Infomaniak
Manager does with API tokens. `spec/infomaniak-extensions.openapi.json` adds those operations (web hosting, `/domain`
DNS API, orders and cart, invoicing, account users and permissions…), fixes some official ones and adds missing
parameters. They are shown as `undocumented: true`, and `verified: false` when they were never executed with a token.
The **Orders** and **Invoicing & Payments** categories are disabled by default. See
[docs/undocumented-operations.md](docs/undocumented-operations.md).

## Authentication

Modes can be combined:

| Mode | For | The client sends |
| --- | --- | --- |
| **MCP tokens** (recommended) | Teams; Claude Code, Cursor, VS Code… | `Authorization: Bearer imkt_…`, created in the portal |
| **OAuth** | claude.ai, Claude Desktop | Nothing: the user signs in with Infomaniak |
| **Token passthrough** | Quick personal use | `Authorization: Bearer <Infomaniak API token>`; nothing is stored |
| **Static API keys** | Legacy setups | `Authorization: Bearer <key>` from `MCP_API_KEYS`, plus `X-Infomaniak-Token` or `INFOMANIAK_API_TOKEN` |

### OAuth

1. Create an OAuth application in the Infomaniak Manager with the redirect URI `https://<your-server>/oauth/callback`.
2. Enter the public URL, client id and client secret in the portal (wizard or **Settings**).
3. Add the server in your client with just its URL; the client handles the login.

By default, someone who signs in acts with **their own Infomaniak login only**. The **OAuth access** page grants more
through rules matching the user by Infomaniak user id, e-mail address or e-mail domain: shared connections, the
user's own login (shown as the `Personal` connection), read-only mode and allowed categories. E-mail and domain rules
only match addresses Infomaniak reports as verified, and rules are re-evaluated on every request. The policy for users
no rule matches is either *personal login only* or *deny*.

Under the hood, Infomaniak only accepts confidential OAuth clients while MCP clients register dynamically and use
PKCE, so the server acts as the authorization server for MCP clients and as a confidential client of Infomaniak. It
stores nothing: clients, codes and tokens are AES-256-GCM sealed. Access tokens expire with the Infomaniak token they
wrap; changing the OAuth secret signs everyone out.

## Admin portal

Runs on its own port (default `9090`). **Keep it private**: publish only the MCP port through your reverse proxy and
reach the portal through a VPN, an SSH tunnel or a restricted virtual host.

| Page | What it does |
| --- | --- |
| Dashboard | Health, catalog size, exposed categories, tokens, connection status, auth modes, MCP URL |
| Infomaniak connections | API tokens the server acts with (encrypted at rest), live test, default organisation |
| MCP tokens | Tokens shown once and stored hashed: connections, read-only, categories, IP allow-list, expiry, revocation |
| OAuth access | Rules for people who sign in with Infomaniak, default policy, recent sign-ins |
| Tool exposure | API categories visible to every client |
| Settings | Public URL, reverse proxy, read-only mode, response size, OAuth application |

## Configuration

Settings made in the portal are stored in the database and applied without restart. Environment variables take
precedence and lock the matching field in the portal, which suits GitOps deployments. See
[.env.example](.env.example) for details.

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT`, `HOST` | `3000`, `0.0.0.0` | MCP endpoint |
| `ADMIN_PORT`, `ADMIN_HOST`, `ADMIN_ENABLED` | `9090`, `HOST`, `true` | Admin portal |
| `ADMIN_PASSWORD` | — | Sets the admin password at startup (skips the first wizard step) |
| `DATA_DIR` | `./data` (`/data` in the image) | SQLite database and generated secret key |
| `MCP_SECRET_KEY` | generated in `DATA_DIR/secret.key` | Encrypts stored Infomaniak tokens — back it up |
| `PUBLIC_URL` | — | Public HTTPS origin, required for OAuth |
| `TRUST_PROXY` | — | Number of reverse proxies in front of the server (e.g. `1`) |
| `INFOMANIAK_READ_ONLY` | `false` | Read-only for every client |
| `MAX_RESPONSE_CHARS` | `60000` | Longer API responses are truncated |
| `INFOMANIAK_OAUTH_CLIENT_ID`, `INFOMANIAK_OAUTH_CLIENT_SECRET`, `INFOMANIAK_OAUTH_SCOPES`, `OAUTH_SECRET` | — | OAuth application |
| `MCP_ALLOWED_HOSTS` | — | Host header allow-list |
| `MCP_API_KEYS`, `INFOMANIAK_API_TOKEN` | — | Static API keys mode |

Put the MCP endpoint behind HTTPS before exposing it: tokens travel in request headers.

## Development

```bash
npm install
npm run dev                  # MCP server and admin API in watch mode
npm run dev:admin            # admin UI with hot reload on :5173 (API proxied to :9090)
npm test                     # vitest
npm run typecheck
npm run build                # server and admin UI into dist/
npm run catalog              # rebuild src/catalog.json from the live spec and the extensions
npm run extensions:sanitize  # strip real data from a new extensions file
```

Local stdio mode: `INFOMANIAK_API_TOKEN=… node dist/index.js --stdio`.

Build the image yourself with `podman build --format docker -t infomaniak-mcp-server .` (`--format docker` keeps the
health check) or `docker build -f Containerfile -t infomaniak-mcp-server .`. The CI publishes `latest` from `main` and
`X.Y.Z` / `X.Y` from version tags.

## License

[MIT](LICENSE)
