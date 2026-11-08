# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses [Semantic Versioning](https://semver.org/).

## [0.1.0] - 2026-11-08

First release.

### MCP server
- Remote MCP server over Streamable HTTP (stateless, horizontally scalable), plus a stdio mode for local use.
- The whole Infomaniak API through a catalog compiled from the official OpenAPI spec: 1,787 operations, including
  192 undocumented ones (web hosting, `/domain` DNS API, orders and cart, invoicing, account users) and 10 corrected
  official operations.
- Tools: `infomaniak_list_accounts`, `infomaniak_list_categories`, `infomaniak_search_operations`,
  `infomaniak_describe_operation`, `infomaniak_get` (read-only) and `infomaniak_request` (writes). Calls are validated
  against the catalog; kChat calls are routed to `<team>.kchat.infomaniak.com`.
- Several Infomaniak connections and organisations per client, chosen per call with `connection` and `account`
  (name or id), both listed in the tool schemas.
- Deletions, restores, orders and transfers need the user's explicit confirmation (MCP elicitation when the client
  supports it, `confirm: true` otherwise).

### Authentication
- Managed MCP tokens (hashed, shown once) with read-only mode, allowed API categories, IP/CIDR allow-list and expiry.
- "Sign in with Infomaniak" OAuth for claude.ai and other OAuth clients, with admin rules granting shared connections
  by user id, verified e-mail or domain.
- Infomaniak API token passthrough and static API keys.

### Admin portal
- Web UI on a separate port (9090), in English and French.
- First-launch onboarding unlocked by a one-time setup code.
- Dashboard, Infomaniak connections (live test, default organisation), MCP tokens, OAuth access rules, tool exposure
  (Orders and Invoicing & Payments disabled by default) and settings stored in the database and applied without
  restart.

### Distribution
- Container image for linux/amd64 and linux/arm64 on `ghcr.io/kallioli/infomaniak-mcp-server`.

[0.1.0]: https://github.com/kallioli/infomaniak-mcp-server/releases/tag/v0.1.0
