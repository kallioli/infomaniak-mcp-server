import { createHash } from "node:crypto";
import type { InfomaniakClient } from "./infomaniak.js";

/** An Infomaniak organisation ("account" in the API) reachable with a token. */
export interface Organisation {
  id: number;
  name: string;
}

const CACHE_TTL = 5 * 60_000;
const cache = new Map<string, { at: number; value: Organisation[] }>();

/** Organisations reachable with a token (GET /1/accounts), cached for a few minutes. */
export async function listOrganisations(client: InfomaniakClient, token: string): Promise<Organisation[]> {
  const key = createHash("sha256").update(token).digest("hex");
  const cached = cache.get(key);
  if (cached && Date.now() - cached.at < CACHE_TTL) return cached.value;
  const res = await client.request({ token, method: "GET", path: "/1/accounts" });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = (res.data as { data?: unknown } | null)?.data;
  const value = (Array.isArray(data) ? (data as Organisation[]) : []).map((a) => ({ id: a.id, name: a.name }));
  cache.set(key, { at: Date.now(), value });
  return value;
}

/**
 * Loads the organisations of several connections, keyed by connection name. A connection whose list cannot be
 * fetched (e.g. token without the "accounts" scope) maps to the error message instead.
 */
export async function loadOrganisations(
  client: InfomaniakClient,
  connections: { name: string; token: string }[],
): Promise<Map<string, Organisation[] | string>> {
  const entries = await Promise.all(
    connections.map(async (c) => {
      try {
        return [c.name, await listOrganisations(client, c.token)] as const;
      } catch (err) {
        return [c.name, (err as Error).message] as const;
      }
    }),
  );
  return new Map<string, Organisation[] | string>(entries);
}
