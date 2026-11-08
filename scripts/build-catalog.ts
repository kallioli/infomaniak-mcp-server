/**
 * Downloads the official Infomaniak OpenAPI spec and compiles it into a compact
 * catalog (src/catalog.json) used at runtime by the MCP tools.
 *
 * Usage: npm run catalog [-- --spec ./openapi.json]
 */
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const SPEC_URL = "https://developer.infomaniak.com/openapi.json";
/** Undocumented operations and corrections, merged on top of the official spec. */
const EXTENSIONS = join(dirname(fileURLToPath(import.meta.url)), "..", "spec", "infomaniak-extensions.openapi.json");
const OUT = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "catalog.json");
const METHODS = ["get", "post", "put", "patch", "delete"] as const;

type Json = any;

const SCHEMA_KEYS = new Set([
  "type", "properties", "required", "items", "enum", "description", "allOf", "oneOf",
  "anyOf", "$ref", "format", "nullable", "default", "additionalProperties", "minimum",
  "maximum", "minLength", "maxLength", "pattern",
]);

export function cleanText(text: unknown, max = 400): string | undefined {
  if (typeof text !== "string") return undefined;
  const plain = text
    .replace(/<\/?(note|strong|b|i|em|code|br|p|ul|li|a)[^>]*>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!plain) return undefined;
  return plain.length > max ? `${plain.slice(0, max - 1)}…` : plain;
}

function trimSchema(schema: Json, depth = 0): Json {
  if (Array.isArray(schema)) return schema.map((s) => trimSchema(s, depth));
  if (!schema || typeof schema !== "object") return schema;
  const out: Json = {};
  for (const [key, value] of Object.entries(schema)) {
    if (!SCHEMA_KEYS.has(key)) continue;
    if (key === "description") {
      const d = cleanText(value, 200);
      if (d) out.description = d;
    } else if (key === "properties") {
      out.properties = Object.fromEntries(
        Object.entries(value as Json).map(([k, v]) => [k, trimSchema(v, depth + 1)]),
      );
    } else if (key === "enum" && Array.isArray(value) && value.length > 40) {
      out.enum = [...value.slice(0, 40), "…"];
    } else if (typeof value === "object") {
      out[key] = trimSchema(value, depth + 1);
    } else {
      out[key] = value;
    }
  }
  return out;
}

function collectRefs(node: Json, into: Set<string>): void {
  if (Array.isArray(node)) return node.forEach((n) => collectRefs(n, into));
  if (!node || typeof node !== "object") return;
  for (const [key, value] of Object.entries(node)) {
    if (key === "$ref" && typeof value === "string") into.add(value);
    else collectRefs(value, into);
  }
}

function paramType(schema: Json): string {
  if (!schema) return "string";
  if (schema.type === "array") return `array<${schema.items?.type ?? "string"}>`;
  return schema.type ?? (schema.enum ? "enum" : "string");
}

async function loadSpec(): Promise<Json> {
  const idx = process.argv.indexOf("--spec");
  if (idx > -1) return JSON.parse(await readFile(process.argv[idx + 1], "utf8"));
  const res = await fetch(SPEC_URL);
  if (!res.ok) throw new Error(`Failed to download spec: HTTP ${res.status}`);
  return res.json();
}

/**
 * Merges the extensions file (default spec/infomaniak-extensions.openapi.json, or --extensions <file>):
 * adds missing operations, replaces those flagged x-ik-replace (keeping the official scopes and tags when the
 * replacement has none), appends x-ik-extra-parameters that are not already declared.
 * A missing default file is fine; an unreadable or invalid one stops the build.
 */
async function applyExtensions(spec: Json): Promise<number> {
  const idx = process.argv.indexOf("--extensions");
  const file = idx > -1 ? process.argv[idx + 1] : EXTENSIONS;
  let raw: string;
  try {
    raw = await readFile(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT" && idx === -1) return 0;
    throw new Error(`Cannot read extensions file ${file}: ${(err as Error).message}`);
  }
  const ext = JSON.parse(raw);

  let applied = 0;
  for (const [path, item] of Object.entries<Json>(ext.paths ?? {})) {
    for (const [method, op] of Object.entries<Json>(item)) {
      const official = spec.paths[path]?.[method];
      if (op["x-ik-extra-parameters"]) {
        if (!official) continue;
        const existing = Object.values<Json>(official.parameters ?? []);
        const key = (p: Json) => `${p.in}:${p.name}`;
        const known = new Set(existing.filter((p) => p && typeof p === "object").map(key));
        official.parameters = [...existing, ...op["x-ik-extra-parameters"].filter((p: Json) => !known.has(key(p)))];
        applied++;
      } else if (op["x-ik-replace"] || !official) {
        spec.paths[path] ??= {};
        spec.paths[path][method] = {
          ...op,
          ...(official && !op["x-scopes"] && official["x-scopes"] ? { "x-scopes": official["x-scopes"] } : {}),
          ...(official && !op.tags && official.tags ? { tags: official.tags } : {}),
        };
        applied++;
      }
    }
  }

  // Components: additions only; an official definition is never overridden.
  spec.components ??= {};
  for (const [kind, defs] of Object.entries<Json>(ext.components ?? {})) {
    spec.components[kind] ??= {};
    for (const [name, def] of Object.entries<Json>(defs)) {
      if (spec.components[kind][name]) console.warn(`Extensions: keeping official components.${kind}.${name}`);
      else spec.components[kind][name] = def;
    }
  }
  return applied;
}

async function main() {
  const spec = await loadSpec();
  const extended = await applyExtensions(spec);
  const sharedParams = spec.components?.parameters ?? {};
  const operations: Json[] = [];

  // Prefix tags with their product group (x-tagGroups) so "channels" becomes "kChat > channels".
  const groupOf = new Map<string, string>();
  for (const group of spec["x-tagGroups"] ?? []) {
    for (const tag of group.tags ?? []) if (group.name !== "Others") groupOf.set(tag, group.name);
  }
  const fullTag = (raw: string) => {
    // The spec has a literal "Others/Others" tag.
    const tag = raw === "Others/Others" ? "Others" : raw;
    const group = groupOf.get(tag);
    return group && !tag.toLowerCase().startsWith(group.toLowerCase()) ? `${group} > ${tag}` : tag;
  };
  const refs = new Set<string>();

  for (const [path, item] of Object.entries<Json>(spec.paths)) {
    for (const method of METHODS) {
      const op = item[method];
      if (!op || op["x-visible"] === false) continue;

      // A few operations ship `parameters` as an object keyed by index instead of an array.
      const params = Object.values<Json>(op.parameters ?? [])
        .map((p: Json) => (p && typeof p === "object" && p.$ref ? sharedParams[p.$ref.split("/").pop()] : p))
        .filter((p: Json) => p && typeof p === "object" && p.name && ["path", "query", "header"].includes(p.in))
        .map((p: Json) => {
          const schema = p.schema ?? {};
          const values = p["x-values"] ?? schema.enum;
          return {
            name: p.name,
            in: p.in,
            ...(p.required || p.in === "path" ? { required: true } : {}),
            type: paramType(schema),
            ...(Array.isArray(values) && values.length ? { values: values.slice(0, 40) } : {}),
            ...(cleanText(p.description ?? schema.description, 200)
              ? { description: cleanText(p.description ?? schema.description, 200) }
              : {}),
          };
        });

      let body: Json;
      const content = op.requestBody?.content;
      if (content) {
        const contentType = Object.keys(content)[0];
        const schema = trimSchema(content[contentType]?.schema ?? {});
        collectRefs(schema, refs);
        body = { contentType, ...(op.requestBody.required ? { required: true } : {}), schema };
      }

      const okResponse = Object.entries<Json>(op.responses ?? {}).find(([code]) => code.startsWith("2"));
      const responseType = okResponse ? Object.keys(okResponse[1]?.content ?? {})[0] : undefined;

      operations.push({
        id: `${method.toUpperCase()} ${path}`,
        method: method.toUpperCase(),
        path,
        tag: fullTag(op.tags?.[0] ?? "Others"),
        summary: cleanText(op.summary, 160) ?? "",
        ...(cleanText(op.description, 600) && op.description !== op.summary
          ? { description: cleanText(op.description, 600) }
          : {}),
        ...(op.deprecated ? { deprecated: true } : {}),
        ...(op["x-ik-undocumented"] ? { undocumented: true } : {}),
        ...(op["x-ik-dangerous"] ? { dangerous: true } : {}),
        // Undocumented operations only known from the manager (never executed with a token) are flagged unverified.
        ...(op["x-ik-undocumented"] && op["x-ik-evidence"]?.token_check?.verdict !== "token-ok" ? { verified: false } : {}),
        ...(op["x-scopes"]?.length ? { scopes: op["x-scopes"] } : {}),
        params,
        ...(body ? { body } : {}),
        ...(responseType && responseType !== "application/json" ? { responseType } : {}),
      });
    }
  }

  // Keep only component schemas reachable from request bodies.
  const schemas: Json = {};
  const queue = [...refs];
  while (queue.length) {
    const ref = queue.pop()!;
    const name = ref.split("/").pop()!;
    if (schemas[name] || !spec.components?.schemas?.[name]) continue;
    schemas[name] = trimSchema(spec.components.schemas[name]);
    const nested = new Set<string>();
    collectRefs(schemas[name], nested);
    queue.push(...nested);
  }

  const catalog = {
    source: extended ? `${SPEC_URL} + infomaniak-extensions (${extended})` : SPEC_URL,
    generatedAt: new Date().toISOString(),
    operations,
    schemas,
  };
  await writeFile(OUT, JSON.stringify(catalog));
  if (extended) console.log(`Merged ${extended} operations from infomaniak-extensions`);
  console.log(`Wrote ${operations.length} operations, ${Object.keys(schemas).length} schemas to ${OUT}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
