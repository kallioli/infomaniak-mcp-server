import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Icon } from "@modelcontextprotocol/sdk/types.js";
import type { RequestHandler } from "express";

/** The logo, shared with the admin portal: assets/ sits next to both src/ and dist/. */
const ASSETS = join(dirname(fileURLToPath(import.meta.url)), "..", "assets");

/** Served files; `declared` ones are also listed in the MCP initialize response. */
const FILES = [
  { path: "/favicon.svg", file: "favicon.svg", type: "image/svg+xml", sizes: ["any"], declared: true },
  { path: "/favicon.png", file: "favicon.png", type: "image/png", sizes: ["256x256"], declared: true },
  { path: "/favicon.ico", file: "favicon.ico", type: "image/x-icon", sizes: ["16x16", "32x32", "48x48"], declared: false },
];

/**
 * Serves the logo without authentication, so clients can show it next to the connector. A missing file only turns
 * its route into a 404: the logo is not worth failing the server over.
 */
export function iconRoutes(): Record<string, RequestHandler> {
  return Object.fromEntries(
    FILES.map(({ path, file, type }) => {
      let content: Buffer | undefined;
      try {
        content = readFileSync(join(ASSETS, file));
      } catch (err) {
        console.warn(`Logo file ${file} not found, ${path} will answer 404: ${(err as Error).message}`);
      }
      const handler: RequestHandler = (_req, res, next) => {
        if (!content) return next();
        res.type(type).set("Cache-Control", "public, max-age=86400").send(content);
      };
      return [path, handler];
    }),
  );
}

/** The icons declared in the MCP initialize response, as absolute URLs on the server's origin. */
export function serverIcons(origin: string): Icon[] {
  return FILES.filter((f) => f.declared).map(({ path, type, sizes }) => ({ src: new URL(path, origin).href, mimeType: type, sizes }));
}

/** A minimal home page: some favicon services read the icon links of the site root rather than /favicon.ico. */
export const homePage: RequestHandler = (_req, res) => {
  res.type("html").send(`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Infomaniak MCP Server</title>
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="icon" href="/favicon.png" type="image/png" sizes="256x256">
<link rel="apple-touch-icon" href="/favicon.png">
</head>
<body>
<p>Infomaniak MCP Server. Add <code>/mcp</code> to an MCP client.</p>
</body>
</html>
`);
};
