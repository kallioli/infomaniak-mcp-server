/**
 * Removes real-world data from the extensions spec produced by ik-api-explore, whose response schemas are inferred
 * from real responses:
 * - objects keyed by domain names (e.g. {"example.ch": {...}}) become maps (additionalProperties), which is also the
 *   correct schema;
 * - example values lose identifiers: UUIDs, long numbers and host names other than example/infomaniak ones.
 *
 * Usage: npm run extensions:sanitize [-- <file>]   (rewrites the file in place)
 */
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

type Json = any;

const DEFAULT_FILE = join(dirname(fileURLToPath(import.meta.url)), "..", "spec", "infomaniak-extensions.openapi.json");
export const DOMAIN_KEY = /^[a-z0-9-]+(\.[a-z0-9-]+)+$/i;
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const LONG_NUMBER = /\d{5,}/g;
const HOST = /\b[a-z0-9-]+(\.[a-z0-9-]+)*\.(ch|fr|com|net|org|io|de|it|eu)\b/gi;
const KEPT_HOSTS = /(^|\.)(example\.(com|org|net)|infomaniak\.(com|ch))$/i;

function scrubValue(value: unknown): unknown {
  if (typeof value === "number") return Number.isInteger(value) && Math.abs(value) >= 100_000 ? 123456 : value;
  if (typeof value !== "string") return value;
  return value
    .replace(UUID, "00000000-0000-0000-0000-000000000000")
    .replace(HOST, (host) => (KEPT_HOSTS.test(host) ? host : "example.com"))
    .replace(LONG_NUMBER, "123456");
}

export function sanitize(node: Json): Json {
  if (Array.isArray(node)) return node.map(sanitize);
  if (!node || typeof node !== "object") return node;
  const out: Json = {};
  for (const [key, value] of Object.entries(node)) {
    if (key === "example" || key === "examples") {
      out[key] = Array.isArray(value) ? value.map(scrubValue) : scrubValue(value);
    } else {
      out[key] = sanitize(value);
    }
  }
  // Domain names used as property names: the object is really a map keyed by domain.
  if (out.properties && typeof out.properties === "object") {
    const domainKeys = Object.keys(out.properties).filter((k) => DOMAIN_KEY.test(k));
    if (domainKeys.length) {
      out.additionalProperties ??= out.properties[domainKeys[0]];
      for (const k of domainKeys) delete out.properties[k];
      if (Array.isArray(out.required)) {
        out.required = out.required.filter((k: string) => !domainKeys.includes(k));
        if (!out.required.length) delete out.required;
      }
      if (!Object.keys(out.properties).length) delete out.properties;
      out.description ??= "Keyed by domain name.";
    }
  }
  return out;
}

async function main() {
  const file = process.argv[2] ?? DEFAULT_FILE;
  const before = await readFile(file, "utf8");
  // Same layout as ik-api-explore writes it (one-space indent, no final newline) to keep diffs small.
  const after = JSON.stringify(sanitize(JSON.parse(before)), null, 1);
  if (after === before) {
    console.log(`${file}: already clean`);
    return;
  }
  await writeFile(file, after);
  console.log(`${file}: sanitized`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
