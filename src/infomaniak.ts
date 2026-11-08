import type { HttpMethod } from "./catalog.js";

export const DEFAULT_BASE_URL = "https://api.infomaniak.com";
const MAX_RETRY_WAIT_MS = 15_000;

export interface ApiRequest {
  token: string;
  method: HttpMethod;
  path: string;
  query?: Record<string, unknown>;
  body?: unknown;
  /** Overrides the API host, e.g. for kChat which lives on <team>.kchat.infomaniak.com. */
  baseUrl?: string;
}

export interface ApiResponse {
  status: number;
  ok: boolean;
  contentType: string;
  /** Parsed JSON, text, or a description of a binary payload. */
  data: unknown;
}

export interface ApiClientOptions {
  baseUrl?: string;
  timeoutMs?: number;
  fetch?: typeof fetch;
}

function buildUrl(baseUrl: string, path: string, query?: Record<string, unknown>): string {
  const url = new URL(path, baseUrl);
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value === undefined || value === null) continue;
    url.searchParams.set(key, Array.isArray(value) ? value.join(",") : String(value));
  }
  return url.toString();
}

export class InfomaniakClient {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(options: ApiClientOptions = {}) {
    this.baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.fetchImpl = options.fetch ?? fetch;
  }

  async request(req: ApiRequest): Promise<ApiResponse> {
    const url = buildUrl(req.baseUrl ?? this.baseUrl, req.path, req.query);
    const init: RequestInit = {
      method: req.method,
      headers: {
        Authorization: `Bearer ${req.token}`,
        Accept: "application/json",
        ...(req.body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      body: req.body !== undefined ? JSON.stringify(req.body) : undefined,
    };

    let res = await this.fetchImpl(url, { ...init, signal: AbortSignal.timeout(this.timeoutMs) });
    if (res.status === 429) {
      // Infomaniak allows 60 requests/minute; honour Retry-After once if it is short enough.
      const waitMs = Number(res.headers.get("retry-after") ?? "5") * 1000;
      if (waitMs <= MAX_RETRY_WAIT_MS) {
        await new Promise((r) => setTimeout(r, waitMs));
        res = await this.fetchImpl(url, { ...init, signal: AbortSignal.timeout(this.timeoutMs) });
      }
    }

    const contentType = res.headers.get("content-type") ?? "";
    let data: unknown;
    if (contentType.includes("json")) {
      const text = await res.text();
      try {
        data = text ? JSON.parse(text) : null;
      } catch {
        data = text;
      }
    } else if (contentType.startsWith("text/") || contentType.includes("csv")) {
      data = await res.text();
    } else {
      const size = (await res.arrayBuffer()).byteLength;
      data = { binary: true, contentType, bytes: size, note: "Binary payloads are not returned through MCP." };
    }
    return { status: res.status, ok: res.ok, contentType, data };
  }
}
