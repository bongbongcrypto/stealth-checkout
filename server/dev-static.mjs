#!/usr/bin/env node
// Static file server for the demos, for local development only.
//
//   npm run dev        → http://127.0.0.1:4173
//
// It exists because the obvious alternatives lie to you. A plain static server
// sends Last-Modified and nothing else, and browsers then apply heuristic
// freshness: an edited file keeps serving from cache across reloads AND across
// server restarts, so a fix looks like it did not work. Every response here is
// no-store, so what you see is what is on disk.
import { createServer } from "node:http";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { extname, join, normalize, resolve, sep } from "node:path";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const PORT = Number(process.env.DEV_PORT ?? 4173);

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".map": "application/json; charset=utf-8",
};

createServer(async (req, res) => {
  const send = (code, body) => {
    res.writeHead(code, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" });
    res.end(body);
  };
  try {
    const rel = decodeURIComponent(new URL(req.url, "http://localhost").pathname);
    // Resolve first, then check containment: "../" and encoded variants must
    // not be able to read the rest of the disk.
    const target = resolve(join(ROOT, normalize(rel)));
    if (target !== ROOT && !target.startsWith(ROOT + sep)) return send(403, "forbidden");

    let file = target;
    const info = await stat(file).catch(() => null);
    if (info?.isDirectory()) file = join(file, "index.html");
    const fileInfo = info?.isDirectory() ? await stat(file).catch(() => null) : info;
    if (!fileInfo?.isFile()) return send(404, "not found");

    res.writeHead(200, {
      "Content-Type": TYPES[extname(file).toLowerCase()] ?? "application/octet-stream",
      "Content-Length": fileInfo.size,
      "Cache-Control": "no-store, no-cache, must-revalidate",
      "Pragma": "no-cache",
    });
    createReadStream(file).pipe(res);
  } catch (err) {
    send(500, String(err?.message ?? err));
  }
}).listen(PORT, "127.0.0.1", () => {
  console.log(`dev server: http://127.0.0.1:${PORT} (serving ${ROOT}, cache disabled)`);
});
