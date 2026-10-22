/* Serves site-dist/ over HTTP for the browser tests, the way GitHub Pages serves it: a directory URL answers with its index.html, a file answers with its media type, and a file the browser may reuse says so with a max-age. It also counts the requests each file receives (`/__hits/<path>`), and ends every service worker script with a line naming the request, so the browser installs each fetch of it as an update. */

import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(fileURLToPath(new URL("../..", import.meta.url)), "site-dist");
const port = Number(process.env["PORT"]);
if (!Number.isInteger(port)) {
  throw new Error("PORT must be set to the port to serve on");
}

const TYPES: Readonly<Record<string, string>> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".webmanifest": "application/manifest+json",
};

const NOT_FOUND = 404;
const OK = 200;

/** How long the browser may reuse app.js without asking again, as a static host lets it. */
const APP_MAX_AGE_SECONDS = 600;

const hits = new Map<string, number>();

createServer((request, response) => {
  const { pathname } = new URL(request.url ?? "/", "http://localhost");
  if (pathname.startsWith("/__hits/")) {
    response.writeHead(OK, { "content-type": "text/plain" });
    response.end(String(hits.get(pathname.slice("/__hits".length)) ?? 0));

    return;
  }
  hits.set(pathname, (hits.get(pathname) ?? 0) + 1);
  const relative = normalize(decodeURIComponent(pathname)).replace(/^(\.\.[/\\])+/, "");
  const file = join(root, relative.endsWith("/") ? `${relative}index.html` : relative);
  readFile(file).then(
    (bytes) => {
      const headers: Record<string, string> = { "content-type": TYPES[extname(file)] ?? "application/octet-stream" };
      if (pathname === "/app.js") {
        headers["cache-control"] = `public, max-age=${String(APP_MAX_AGE_SECONDS)}`;
      }
      response.writeHead(OK, headers);
      response.end(pathname === "/sw.js" ? `${bytes.toString("utf8")}\n// request ${String(hits.get(pathname))}\n` : bytes);
    },
    () => {
      response.writeHead(NOT_FOUND);
      response.end();
    },
  );
}).listen(port);
