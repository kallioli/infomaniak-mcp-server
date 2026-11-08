import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Config } from "../config.js";
import { Store } from "./db.js";

/**
 * Opens the database, creating the data directory and secret key as needed. ADMIN_PASSWORD, when set, (re)sets the
 * admin password; otherwise the first admin password is chosen in the portal's onboarding.
 */
export function openStore(config: Config): { store: Store; secretKey: string } {
  mkdirSync(config.dataDir, { recursive: true, mode: 0o700 });

  let secretKey = config.secretKey;
  if (!secretKey) {
    const keyFile = join(config.dataDir, "secret.key");
    if (!existsSync(keyFile)) {
      writeFileSync(keyFile, randomBytes(48).toString("base64"), { mode: 0o600 });
      console.warn(`Generated ${keyFile}. Back it up: stored Infomaniak tokens cannot be decrypted without it.`);
    }
    secretKey = readFileSync(keyFile, "utf8").trim();
  }

  const store = new Store(join(config.dataDir, "infomaniak-mcp-server.db"), secretKey);
  if (config.admin.password) store.setAdminPassword(config.admin.password);
  return { store, secretKey };
}
