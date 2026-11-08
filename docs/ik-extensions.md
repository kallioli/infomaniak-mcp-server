# Undocumented Infomaniak API operations

The official OpenAPI spec misses part of what the Infomaniak manager does with plain API tokens. `spec/infomaniak-extensions.openapi.json`, produced by the **ik-api-explore** tool, fills the gap and is merged on top of the official spec when the catalog is built (`npm run catalog`).

Current content: **192 added operations** (116 executed successfully with an API token, 76 only seen in the manager), **10 corrected official operations** and extra parameters.

## Markers

| In the spec | In the catalog / `infomaniak_describe_operation` | Meaning |
|---|---|---|
| `x-ik-undocumented: true` | `undocumented: true` | Not in the official spec; may change without notice. |
| `x-ik-evidence.token_check.verdict != "token-ok"` | `verified: false` | Seen in the manager, never executed with a token: body and response are not documented. |
| `x-ik-dangerous: true` | `needsConfirmation: true` | Orders, transfers, account users… |
| `x-ik-replace: true` + `x-ik-correction` | — | Replaces an official operation (official scopes and tags are kept). |
| `x-ik-extra-parameters` | — | Parameters added to an official operation (duplicates ignored). |

`needsConfirmation` also covers, documented or not, every `DELETE` and every restore, checkout or transfer: `infomaniak_request` asks the user through MCP elicitation when the client supports it, and otherwise refuses the call unless the assistant passes `confirm: true` after the user confirmed.

The **Orders** and **Invoicing & Payments** categories are disabled by default (Tool exposure page) the first time they appear.

## Using these operations

1. **Asynchronous operations**: a `202 {"result":"delayed","data":"<uuid>"}` response is followed with `GET /1/async/tasks/{uuid}` (the result is in `response` once `finished_at` is set). Web hosting operations return a `progress_id` without a tracking endpoint: poll the resource.
2. **One operation at a time per web hosting** (`400 operation_in_progress` otherwise): wait for `has_operation_in_progress=false`.
3. **Paginated lists** (10 items by default): pass `per_page` / `page`.
4. **Several accounts**: `GET /1/accounts` lists the accessible accounts (owner, partner_admin, partner_limited); most routes take the target `account_id`, customer accounts included.
5. **Ordering**: `POST /order/cart {account_id}` → `POST /order/cart/{uuid}/item/{product}` → `PUT …/item/{id}` (attributes) → `GET …/checkout` (terms to show) → **`POST …/checkout` creates the order whatever the body**. Payment is not possible with a token: the order stays `pending_payment` (follow it with `GET /2/invoicing/account/{id}/orders/{order_id}`).
6. **Never exposed**: `DELETE /2/profile` and `DELETE /account/{id}` are left out of the spec.

## Maintenance

After importing a new file from ik-api-explore:

```bash
npm run extensions:sanitize   # strip real domains, identifiers and UUIDs inferred from live responses
npm run catalog               # rebuild src/catalog.json (fails on an unreadable extensions file)
npm test                      # includes a check that the file is sanitized
```

Official component schemas are never overridden by the extensions (a warning is printed on name clashes).

## Added operations

### Core Resources (23)

| Method | Path | Verified | Confirmation |
|---|---|---|---|
| GET | `/1/accounts/{account_id}/products/simple` | yes |  |
| GET | `/1/country` | yes |  |
| GET | `/1/ksuite/{ksuite_id}` | yes |  |
| GET | `/1/ksuite/{ksuite_id}/linked_domains` | yes |  |
| GET | `/1/ksuite/{ksuite_id}/products` | yes |  |
| GET | `/2/profile/support/tickets` | yes |  |
| GET | `/account` | no |  |
| GET | `/account/{account_id}` | no |  |
| PUT | `/account/{account_id}` | no | required |
| GET | `/account/{account_id}/invitation` | yes |  |
| GET | `/account/{account_id}/log` | yes |  |
| GET | `/account/{account_id}/permission` | yes |  |
| GET | `/account/{account_id}/product/transfer` | yes |  |
| POST | `/account/{account_id}/product/transfer` | no | required |
| GET | `/account/{account_id}/user` | yes |  |
| POST | `/account/{account_id}/user` | no | required |
| DELETE | `/account/{account_id}/user/{user_id}` | no | required |
| GET | `/account/{account_id}/user/{user_id}` | no |  |
| PATCH | `/account/{account_id}/user/{user_id}` | no | required |
| PUT | `/account/{account_id}/user/{user_id}` | no | required |
| GET | `/action` | yes |  |
| GET | `/country` | no |  |
| GET | `/tld/infos` | no |  |

### Domain & Zone (31)

| Method | Path | Verified | Confirmation |
|---|---|---|---|
| GET | `/2/domains/domains/{domain_id}/contact-verifications` | yes |  |
| GET | `/domain/account/{account_id}` | yes |  |
| POST | `/domain/account/{account_id}/check` | yes |  |
| GET | `/domain/categories/all` | no |  |
| GET | `/domain/{domain_id}` | yes |  |
| GET | `/domain/{domain_id}/contact` | yes |  |
| GET | `/domain/{domain_id}/contact/{contact_id}` | no |  |
| PUT | `/domain/{domain_id}/contact/{contact_id}` | no |  |
| GET | `/domain/{domain_id}/dns` | yes |  |
| PUT | `/domain/{domain_id}/dns` | no |  |
| GET | `/domain/{domain_id}/dns/record` | yes |  |
| POST | `/domain/{domain_id}/dns/record` | yes |  |
| DELETE | `/domain/{domain_id}/dns/record/{record_id}` | yes | required |
| GET | `/domain/{domain_id}/dns/record/{record_id}` | yes |  |
| PUT | `/domain/{domain_id}/dns/record/{record_id}` | yes |  |
| GET | `/domain/{domain_id}/dns/zone` | yes |  |
| POST | `/domain/{domain_id}/dns/zone` | no |  |
| PUT | `/domain/{domain_id}/dns/zone` | no |  |
| GET | `/domain/{domain_id}/dyndns` | yes |  |
| POST | `/domain/{domain_id}/dyndns` | no |  |
| DELETE | `/domain/{domain_id}/dyndns/{dyndns_id}` | no | required |
| PUT | `/domain/{domain_id}/dyndns/{dyndns_id}` | no |  |
| POST | `/domain/{domain_id}/lock` | no |  |
| GET | `/domain/{domain_id}/redirection` | yes |  |
| POST | `/domain/{domain_id}/redirection` | no |  |
| DELETE | `/domain/{domain_id}/redirection/{redirection_id}` | no | required |
| GET | `/domain/{domain_id}/redirection/{redirection_id}` | no |  |
| PUT | `/domain/{domain_id}/redirection/{redirection_id}` | no |  |
| DELETE | `/domain/{domain_id}/synonym` | no | required |
| GET | `/domain/{domain_id}/synonym` | yes |  |
| POST | `/domain/{domain_id}/synonym` | no |  |

### Invoicing & Payments (23)

| Method | Path | Verified | Confirmation |
|---|---|---|---|
| GET | `/1/invoicing/{account_id}/addresses` | yes |  |
| POST | `/1/invoicing/{account_id}/addresses` | no | required |
| GET | `/1/invoicing/{account_id}/invoice/list` | yes |  |
| GET | `/1/invoicing/{account_id}/payment_profile` | yes |  |
| POST | `/1/invoicing/{account_id}/payment_profile` | no | required |
| GET | `/2/invoicing/account/{account_id}/address` | yes |  |
| POST | `/2/invoicing/account/{account_id}/address` | no | required |
| GET | `/2/invoicing/account/{account_id}/config/preference/default` | yes |  |
| GET | `/2/invoicing/account/{account_id}/invoices` | yes |  |
| GET | `/2/invoicing/account/{account_id}/orders` | yes |  |
| GET | `/2/invoicing/account/{account_id}/orders/{order_id}` | yes |  |
| GET | `/2/invoicing/account/{account_id}/payment/modes` | yes |  |
| GET | `/2/invoicing/account/{account_id}/payment/prepaid` | yes |  |
| GET | `/2/invoicing/account/{account_id}/payment/prepaid/operations` | yes |  |
| GET | `/2/invoicing/account/{account_id}/payment/profile` | yes |  |
| POST | `/2/invoicing/account/{account_id}/payment/profile` | no | required |
| GET | `/2/invoicing/account/{account_id}/payments` | yes |  |
| GET | `/2/invoicing/account/{account_id}/settings` | yes |  |
| GET | `/2/invoicing/manager/account/{account_id}/invoices` | yes |  |
| GET | `/invoicing/{account_id}/autorenew/count` | yes |  |
| GET | `/invoicing/{account_id}/invoice/list` | yes |  |
| GET | `/invoicing/{account_id}/settings` | yes |  |
| POST | `/invoicing/{account_id}/vatPrecise` | no |  |

### Mail Services (1)

| Method | Path | Verified | Confirmation |
|---|---|---|---|
| GET | `/1/mail_hostings/{mail_hosting_id}` | yes |  |

### Orders (25)

| Method | Path | Verified | Confirmation |
|---|---|---|---|
| GET | `/1/order/cart` | no |  |
| GET | `/order/cart` | yes |  |
| POST | `/order/cart` | yes |  |
| DELETE | `/order/cart/{cart_uuid}` | yes | required |
| GET | `/order/cart/{cart_uuid}` | yes |  |
| PUT | `/order/cart/{cart_uuid}` | no | required |
| GET | `/order/cart/{cart_uuid}/checkout` | yes |  |
| POST | `/order/cart/{cart_uuid}/checkout` | yes | required |
| GET | `/order/cart/{cart_uuid}/condition` | no |  |
| POST | `/order/cart/{cart_uuid}/condition` | no |  |
| DELETE | `/order/cart/{cart_uuid}/condition/{condition_id}` | no | required |
| GET | `/order/cart/{cart_uuid}/condition/{condition_id}` | no |  |
| PUT | `/order/cart/{cart_uuid}/condition/{condition_id}` | no |  |
| POST | `/order/cart/{cart_uuid}/domaincontact` | no |  |
| PUT | `/order/cart/{cart_uuid}/domaincontact` | no |  |
| PUT | `/order/cart/{cart_uuid}/fill_address` | no |  |
| POST | `/order/cart/{cart_uuid}/item/domain/show` | no |  |
| DELETE | `/order/cart/{cart_uuid}/item/{item}` | yes | required |
| GET | `/order/cart/{cart_uuid}/item/{item}` | yes |  |
| POST | `/order/cart/{cart_uuid}/item/{item}` | yes |  |
| PUT | `/order/cart/{cart_uuid}/item/{item}` | yes |  |
| DELETE | `/order/cart/{cart_uuid}/item/{item}/item_option` | no | required |
| POST | `/order/cart/{cart_uuid}/item/{item}/item_option` | no |  |
| POST | `/order/cart/{cart_uuid}/item/{item}/reset` | no |  |
| PUT | `/order/cart/{cart_uuid}/item/{item}/reset` | no |  |

### Web Hosting (89)

| Method | Path | Verified | Confirmation |
|---|---|---|---|
| GET | `/1/web_hostings/universes/certificates` | yes |  |
| GET | `/1/web_hostings/universes/filters` | yes |  |
| GET | `/1/web_hostings/universes/hostings` | yes |  |
| GET | `/1/web_hostings/{web_hosting_id}` | yes |  |
| PATCH | `/1/web_hostings/{web_hosting_id}` | yes |  |
| GET | `/1/web_hostings/{web_hosting_id}/actions/get_folders` | yes |  |
| POST | `/1/web_hostings/{web_hosting_id}/actions/migrate` | no |  |
| GET | `/1/web_hostings/{web_hosting_id}/aliases` | yes |  |
| GET | `/1/web_hostings/{web_hosting_id}/applications` | yes |  |
| GET | `/1/web_hostings/{web_hosting_id}/applications/wordpress` | no |  |
| POST | `/1/web_hostings/{web_hosting_id}/applications/wordpress` | no |  |
| POST | `/1/web_hostings/{web_hosting_id}/applications/{application_id}` | no |  |
| DELETE | `/1/web_hostings/{web_hosting_id}/applications/{application_id}/{param_id}` | no | required |
| GET | `/1/web_hostings/{web_hosting_id}/applications/{application_id}/{param_id}` | no |  |
| PATCH | `/1/web_hostings/{web_hosting_id}/applications/{application_id}/{param_id}` | no |  |
| GET | `/1/web_hostings/{web_hosting_id}/applications/{application_id}/{param_id}/backups` | no |  |
| POST | `/1/web_hostings/{web_hosting_id}/applications/{application_id}/{param_id}/backups` | no |  |
| DELETE | `/1/web_hostings/{web_hosting_id}/applications/{application_id}/{param_id}/backups/{backup_id}` | no | required |
| POST | `/1/web_hostings/{web_hosting_id}/applications/{application_id}/{param_id}/backups/{backup_id}/actions/restore` | no | required |
| POST | `/1/web_hostings/{web_hosting_id}/applications/{application_id}/{param_id}/upgrade` | no |  |
| POST | `/1/web_hostings/{web_hosting_id}/certificates` | yes |  |
| DELETE | `/1/web_hostings/{web_hosting_id}/certificates/{certificate_id}` | yes | required |
| GET | `/1/web_hostings/{web_hosting_id}/certificates/{certificate_id}` | yes |  |
| PATCH | `/1/web_hostings/{web_hosting_id}/certificates/{certificate_id}` | yes |  |
| GET | `/1/web_hostings/{web_hosting_id}/certificates/{certificate_id}/aliases` | yes |  |
| GET | `/1/web_hostings/{web_hosting_id}/database_users` | yes |  |
| POST | `/1/web_hostings/{web_hosting_id}/database_users` | yes |  |
| DELETE | `/1/web_hostings/{web_hosting_id}/database_users/{database_user_name}` | yes | required |
| GET | `/1/web_hostings/{web_hosting_id}/database_users/{database_user_name}` | no |  |
| PATCH | `/1/web_hostings/{web_hosting_id}/database_users/{database_user_name}` | yes |  |
| GET | `/1/web_hostings/{web_hosting_id}/databases` | yes |  |
| POST | `/1/web_hostings/{web_hosting_id}/databases` | yes |  |
| POST | `/1/web_hostings/{web_hosting_id}/databases/actions/import` | no |  |
| POST | `/1/web_hostings/{web_hosting_id}/databases/actions/request_upgrade` | no |  |
| POST | `/1/web_hostings/{web_hosting_id}/databases/actions/upload` | no |  |
| GET | `/1/web_hostings/{web_hosting_id}/databases/usage` | yes |  |
| DELETE | `/1/web_hostings/{web_hosting_id}/databases/{database_name}` | yes | required |
| GET | `/1/web_hostings/{web_hosting_id}/databases/{database_name}` | yes |  |
| PATCH | `/1/web_hostings/{web_hosting_id}/databases/{database_name}` | yes |  |
| POST | `/1/web_hostings/{web_hosting_id}/databases/{database_name}/actions/download` | no |  |
| POST | `/1/web_hostings/{web_hosting_id}/databases/{database_name}/actions/export` | no |  |
| POST | `/1/web_hostings/{web_hosting_id}/databases/{database_name}/actions/restore` | no | required |
| POST | `/1/web_hostings/{web_hosting_id}/nodejs` | no |  |
| GET | `/1/web_hostings/{web_hosting_id}/nodejs/available` | no |  |
| GET | `/1/web_hostings/{web_hosting_id}/sites` | yes |  |
| POST | `/1/web_hostings/{web_hosting_id}/sites` | yes |  |
| DELETE | `/1/web_hostings/{web_hosting_id}/sites/{site_id}` | yes | required |
| GET | `/1/web_hostings/{web_hosting_id}/sites/{site_id}` | yes |  |
| PATCH | `/1/web_hostings/{web_hosting_id}/sites/{site_id}` | yes |  |
| POST | `/1/web_hostings/{web_hosting_id}/sites/{site_id}/actions/maintenance` | no |  |
| GET | `/1/web_hostings/{web_hosting_id}/sites/{site_id}/aliases` | yes |  |
| POST | `/1/web_hostings/{web_hosting_id}/sites/{site_id}/aliases` | yes |  |
| POST | `/1/web_hostings/{web_hosting_id}/sites/{site_id}/aliases/actions/set_main` | no |  |
| DELETE | `/1/web_hostings/{web_hosting_id}/sites/{site_id}/aliases/{alias}` | yes | required |
| GET | `/1/web_hostings/{web_hosting_id}/sites/{site_id}/logs` | yes |  |
| GET | `/1/web_hostings/{web_hosting_id}/sites/{site_id}/logs/actions/download` | no |  |
| GET | `/1/web_hostings/{web_hosting_id}/sites/{site_id}/statistics` | yes |  |
| GET | `/1/web_hostings/{web_hosting_id}/sites/{site_id}/statistics/details` | yes |  |
| GET | `/1/web_hostings/{web_hosting_id}/sites/{site_id}/thumbnail` | yes |  |
| GET | `/1/web_hostings/{web_hosting_id}/tools/antivirus` | yes |  |
| POST | `/1/web_hostings/{web_hosting_id}/tools/antivirus` | yes |  |
| POST | `/1/web_hostings/{web_hosting_id}/tools/antivirus/actions/clean` | no |  |
| GET | `/1/web_hostings/{web_hosting_id}/tools/antivirus/last_report` | yes |  |
| GET | `/1/web_hostings/{web_hosting_id}/tools/antivirus/reports` | yes |  |
| GET | `/1/web_hostings/{web_hosting_id}/tools/antivirus/reports/{report_id}` | yes |  |
| GET | `/1/web_hostings/{web_hosting_id}/tools/dedicated_ips` | yes |  |
| DELETE | `/1/web_hostings/{web_hosting_id}/tools/folder_protection` | no | required |
| PATCH | `/1/web_hostings/{web_hosting_id}/tools/folder_protection` | no |  |
| GET | `/1/web_hostings/{web_hosting_id}/tools/patchman` | yes |  |
| GET | `/1/web_hostings/{web_hosting_id}/tools/patchman/applications` | yes |  |
| GET | `/1/web_hostings/{web_hosting_id}/tools/patchman/flaws` | yes |  |
| GET | `/1/web_hostings/{web_hosting_id}/tools/ports` | yes |  |
| POST | `/1/web_hostings/{web_hosting_id}/tools/ports` | yes |  |
| DELETE | `/1/web_hostings/{web_hosting_id}/tools/ports/{rule_id}` | yes | required |
| PATCH | `/1/web_hostings/{web_hosting_id}/tools/ports/{rule_id}` | yes |  |
| GET | `/1/web_hostings/{web_hosting_id}/tools/restore_backups` | yes |  |
| POST | `/1/web_hostings/{web_hosting_id}/tools/restore_backups` | yes | required |
| GET | `/1/web_hostings/{web_hosting_id}/tools/web_crons` | yes |  |
| POST | `/1/web_hostings/{web_hosting_id}/tools/web_crons` | yes |  |
| GET | `/1/web_hostings/{web_hosting_id}/tools/web_crons/logs` | yes |  |
| DELETE | `/1/web_hostings/{web_hosting_id}/tools/web_crons/{web_cron_id}` | yes | required |
| PATCH | `/1/web_hostings/{web_hosting_id}/tools/web_crons/{web_cron_id}` | yes |  |
| GET | `/1/web_hostings/{web_hosting_id}/users` | yes |  |
| POST | `/1/web_hostings/{web_hosting_id}/users` | yes |  |
| DELETE | `/1/web_hostings/{web_hosting_id}/users/{user_login}` | yes | required |
| GET | `/1/web_hostings/{web_hosting_id}/users/{user_login}` | no |  |
| PATCH | `/1/web_hostings/{web_hosting_id}/users/{user_login}` | yes |  |
| POST | `/1/website_builders/aliases/actions/check` | no |  |
| GET | `/diagnostic/{service_id}/{product_id}` | yes |  |

## Corrected official operations

| Method | Path | Correction |
|---|---|---|
| POST | `/1/accounts/{account}/teams` | The 201 response is the team id (integer), not the team object — checked on 2026-11-08. |
| POST | `/1/public_clouds/{public_cloud_id}/projects` | Asynchronous response (202 `delayed` + task), not described in the official docs — checked on 2026-11-08 on a test project. |
| DELETE | `/1/public_clouds/{public_cloud_id}/projects/{public_cloud_project_id}` | Asynchronous response (202 `delayed` + task), not described in the official docs — checked on 2026-11-08 on a test project. |
| PATCH | `/1/public_clouds/{public_cloud_id}/projects/{public_cloud_project_id}` | Asynchronous response (202 `delayed` + task), not described in the official docs — checked on 2026-11-08 on a test project. |
| POST | `/1/public_clouds/{public_cloud_id}/projects/{public_cloud_project_id}/credentials` | `user_id` is required; the response holds both access and secret (the secret can never be read again). |
| POST | `/1/public_clouds/{public_cloud_id}/projects/{public_cloud_project_id}/kaas` | `kubernetes_version` enum outdated in the official docs (1.29–1.31); current values come from `GET /1/public_clouds/kaas/versions` (2026-11-08). |
| POST | `/1/public_clouds/{public_cloud_id}/projects/{public_cloud_project_id}/users` | Asynchronous response (202 `delayed` + task), not described in the official docs — checked on 2026-11-08 on a test project. |
| DELETE | `/1/public_clouds/{public_cloud_id}/projects/{public_cloud_project_id}/users/{public_cloud_user_id}` | Asynchronous response (202 `delayed` + task), not described in the official docs — checked on 2026-11-08 on a test project. |
| GET | `/1/public_clouds/{public_cloud_id}/projects/{public_cloud_project_id}/users/{public_cloud_user_id}/authentication/{type}` | Undocumented `type` values (`openrc`, `cloudsyaml`); `region` is `pub1`/`pub2` (not `dc3-a`); asynchronous response — checked on 2026-11-08. |
| GET | `/1/public_clouds/{public_cloud_id}/projects/{public_cloud_project_id}/users/{public_cloud_user_id}/openrc` | Asynchronous response (202 `delayed` + task), not described in the official docs — checked on 2026-11-08 on a test project. |

## Known limits

- The official spec itself contains broken `$ref`s and duplicated paths (radio, VOD, mail); the extensions were validated on their own (OpenAPI 3.1).
- Some manager routes only work with a browser session, not with a token, and are not included.
- Upcoming renewals and reseller customers (`/1/b2b/...`) have no token equivalent.
