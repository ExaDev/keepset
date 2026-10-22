/* Serves site-dist/ over HTTP for the browser tests, the way GitHub Pages serves it: a directory URL answers with its index.html, and a file answers with its media type. */

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

createServer((request, response) => {
  const { pathname } = new URL(request.url ?? "/", "http://localhost");
  const relative = normalize(decodeURIComponent(pathname)).replace(/^(\.\.[/\\])+/, "");
  const file = join(root, relative.endsWith("/") ? `${relative}index.html` : relative);
  readFile(file).then(
    (bytes) => {
      response.writeHead(OK, { "content-type": TYPES[extname(file)] ?? "application/octet-stream" });
      response.end(bytes);
    },
    () => {
      response.writeHead(NOT_FOUND);
      response.end();
    },
  );
}).listen(port);
