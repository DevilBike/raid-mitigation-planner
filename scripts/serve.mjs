// Serves www/ at http://localhost:5173 with no dependencies: `npm start`.
// Also relays /fflogs/* to www.fflogs.com, which doesn't accept calls from web pages directly.
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../www/", import.meta.url));
const port = Number(process.env.PORT) || 5173;
const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png" };
const FFLOGS = process.env.FFLOGS_URL || "https://www.fflogs.com";

async function relay(req, res, path) {
  if (!/^\/(oauth\/token|api\/v2\/client)$/.test(path)) { res.writeHead(404).end(); return; }
  const chunks = []; for await (const c of req) chunks.push(c);
  try {
    const r = await fetch(FFLOGS + path, {
      method: req.method,
      headers: { "content-type": req.headers["content-type"] || "", authorization: req.headers.authorization || "" },
      body: req.method === "GET" ? undefined : Buffer.concat(chunks),
    });
    res.writeHead(r.status, { "content-type": r.headers.get("content-type") || "application/json" }).end(Buffer.from(await r.arrayBuffer()));
  } catch (e) { res.writeHead(502, { "content-type": "text/plain" }).end("Couldn't reach FF Logs: " + e.message); }
}

createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  if (url.pathname.startsWith("/fflogs/")) return relay(req, res, url.pathname.slice("/fflogs".length));
  if (url.pathname === "/js/platform/env.js") {
    res.writeHead(200, { "content-type": "text/javascript" }).end(`window.RMP_ENV = { fflogsBase: "/fflogs" };\n`);
    return;
  }
  const path = normalize(decodeURIComponent(url.pathname)).replace(/^([/\\])+/, "");
  if (path.startsWith("..")) { res.writeHead(403).end(); return; }
  try {
    const body = await readFile(join(root, path || "index.html"));
    res.writeHead(200, { "content-type": types[extname(path || "index.html")] || "application/octet-stream" }).end(body);
  } catch { res.writeHead(404).end("Not found"); }
}).listen(port, () => console.log(`Raid Mitigation Planner: http://localhost:${port}`));
