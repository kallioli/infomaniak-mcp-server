import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export interface OperationParam {
  name: string;
  in: "path" | "query" | "header";
  required?: boolean;
  type: string;
  values?: unknown[];
  description?: string;
}

export interface Operation {
  id: string;
  method: HttpMethod;
  path: string;
  tag: string;
  summary: string;
  description?: string;
  deprecated?: boolean;
  /** Not in the official spec (discovered by ik-api-explore). */
  undocumented?: boolean;
  /** Explicitly flagged as dangerous (orders, transfers…); see isDangerous for the full rule. */
  dangerous?: boolean;
  /** false for undocumented operations only seen in the manager, never executed with an API token. */
  verified?: boolean;
  scopes?: string[];
  params: OperationParam[];
  body?: { contentType: string; required?: boolean; schema: unknown };
  responseType?: string;
}

interface CatalogFile {
  source: string;
  generatedAt: string;
  operations: Operation[];
  schemas: Record<string, unknown>;
}

/** Categories disabled by default the first time they appear: they can place orders or touch billing. */
export const SENSITIVE_CATEGORIES = ["Orders", "Invoicing & Payments"];

/**
 * Operations requiring an explicit confirmation: those flagged dangerous, every DELETE, and restores, checkouts and
 * transfers, whether documented or not.
 */
export function isDangerous(op: Operation): boolean {
  if (op.dangerous) return true;
  if (op.method === "GET") return false;
  return op.method === "DELETE" || /(^|\/)(restore|restore_backups|checkout|transfer)(\/|$)/.test(op.path);
}

export interface SearchOptions {
  query?: string;
  tag?: string;
  method?: HttpMethod;
  limit?: number;
}

/** Product names and common wording mapped to the vocabulary used by the spec. */
const SYNONYMS: Record<string, string[]> = {
  kdrive: ["drive"],
  email: ["mail"],
  mails: ["mail"],
  mailbox: ["mailbox"],
  dns: ["dns", "zone"],
  k8s: ["kubernetes"],
  kaas: ["kubernetes"],
  s3: ["object", "storage"],
  bucket: ["object", "storage"],
  db: ["database"],
  dbaas: ["database"],
  chat: ["kchat"],
  message: ["message", "post"],
  meet: ["kmeet"],
  backup: ["backup"],
  video: ["vod", "video"],
  radio: ["radio"],
};

function stem(word: string): string {
  return word.length > 3 && word.endsWith("s") && !word.endsWith("ss") ? word.slice(0, -1) : word;
}

function words(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 1)
    .map(stem);
}

/** Each query term becomes a group of alternatives; a term matches if any alternative does. */
function queryTerms(query: string): string[][] {
  return words(query).map((w) => SYNONYMS[w]?.map(stem) ?? [w]);
}

export class Catalog {
  readonly operations: Operation[];
  readonly generatedAt: string;
  private readonly file: CatalogFile;
  private readonly schemas: Record<string, unknown>;
  private readonly views = new Map<string, Catalog>();
  private readonly byId = new Map<string, Operation>();
  private readonly matchers: { op: Operation; regex: RegExp; names: string[] }[] = [];

  constructor(file: CatalogFile) {
    this.file = file;
    this.operations = file.operations;
    this.schemas = file.schemas;
    this.generatedAt = file.generatedAt;
    for (const op of this.operations) {
      this.byId.set(op.id, op);
      const names: string[] = [];
      const pattern = op.path
        .split(/(\{[^}]+\})/)
        .map((part) => {
          const m = part.match(/^\{([^}]+)\}$/);
          if (!m) return part.replace(/[.*+?^$()|[\]\\]/g, "\\$&");
          names.push(m[1]);
          return "([^/]+)";
        })
        .join("");
      this.matchers.push({ op, regex: new RegExp(`^${pattern}$`), names });
    }
    // Prefer literal paths over templated ones (e.g. /1/products/count before /1/products/{id}).
    this.matchers.sort((a, b) => a.names.length - b.names.length);
  }

  static load(): Catalog {
    const here = dirname(fileURLToPath(import.meta.url));
    const raw = readFileSync(join(here, "catalog.json"), "utf8");
    return new Catalog(JSON.parse(raw) as CatalogFile);
  }

  /** Top-level product category of an operation, e.g. "kDrive" for "kDrive > Drive > Files". */
  static categoryOf(op: Operation): string {
    return op.tag.split(" > ")[0];
  }

  categories(): { name: string; count: number }[] {
    const counts = new Map<string, number>();
    for (const op of this.operations) {
      const name = Catalog.categoryOf(op);
      counts.set(name, (counts.get(name) ?? 0) + 1);
    }
    return [...counts.entries()].map(([name, count]) => ({ name, count })).sort((a, b) => a.name.localeCompare(b.name));
  }

  /** A catalog limited to the given categories (cached per combination). */
  restrict(categories: Iterable<string>): Catalog {
    const allowed = new Set(categories);
    const key = [...allowed].sort().join("\n");
    let view = this.views.get(key);
    if (!view) {
      view = new Catalog({
        ...this.file,
        operations: this.operations.filter((op) => allowed.has(Catalog.categoryOf(op))),
      });
      this.views.set(key, view);
    }
    return view;
  }

  get(id: string): Operation | undefined {
    return this.byId.get(id);
  }

  /** Resolves a concrete path such as /2/zones/example.ch/records to its operation. */
  match(method: HttpMethod, path: string): { op: Operation; pathParams: Record<string, string> } | undefined {
    const clean = path.split("?")[0];
    for (const { op, regex, names } of this.matchers) {
      if (op.method !== method) continue;
      const m = clean.match(regex);
      if (!m) continue;
      const pathParams = Object.fromEntries(names.map((n, i) => [n, decodeURIComponent(m[i + 1])]));
      return { op, pathParams };
    }
    return undefined;
  }

  tags(): { tag: string; count: number }[] {
    const counts = new Map<string, number>();
    for (const op of this.operations) counts.set(op.tag, (counts.get(op.tag) ?? 0) + 1);
    return [...counts.entries()].map(([tag, count]) => ({ tag, count })).sort((a, b) => a.tag.localeCompare(b.tag));
  }

  search({ query = "", tag, method, limit = 20 }: SearchOptions): Operation[] {
    const terms = queryTerms(query);
    const tagFilter = tag?.toLowerCase();
    const candidates = this.operations.filter(
      (op) => (!method || op.method === method) && (!tagFilter || op.tag.toLowerCase().includes(tagFilter)),
    );
    if (!terms.length) return candidates.slice(0, limit);

    const scored = candidates.map((op) => {
      const fields: [string[], number][] = [
        [words(op.summary), 4],
        [words(op.tag), 3],
        [words(op.path), 2],
        [words(op.description ?? ""), 1],
      ];
      let score = 0;
      let matched = 0;
      for (const alternatives of terms) {
        let best = 0;
        for (const [fieldWords, weight] of fields) {
          if (fieldWords.some((w) => alternatives.some((a) => w.startsWith(a)))) best = Math.max(best, weight);
        }
        if (best) matched++;
        score += best;
      }
      if (op.deprecated) score -= 1;
      return { op, score, matched };
    });

    const all = scored.filter((s) => s.matched === terms.length);
    const pool = all.length ? all : scored.filter((s) => s.matched > 0);
    return pool
      .sort((a, b) => b.matched - a.matched || b.score - a.score || a.op.path.length - b.op.path.length)
      .slice(0, limit)
      .map((s) => s.op);
  }

  /** Inlines component $refs up to a fixed depth so the schema is self-contained. */
  resolveSchema(schema: unknown, depth = 0): unknown {
    if (Array.isArray(schema)) return schema.map((s) => this.resolveSchema(s, depth));
    if (!schema || typeof schema !== "object") return schema;
    const obj = schema as Record<string, unknown>;
    if (typeof obj.$ref === "string") {
      const name = obj.$ref.split("/").pop()!;
      if (depth >= 4 || !this.schemas[name]) return { $ref: name };
      return this.resolveSchema(this.schemas[name], depth + 1);
    }
    return Object.fromEntries(Object.entries(obj).map(([k, v]) => [k, this.resolveSchema(v, depth)]));
  }
}
