const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");

const MAX_REQUEST_BYTES = 64 * 1024 * 1024;
const MIME_TYPES = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".webp": "image/webp",
  ".woff2": "font/woff2"
};

function secureEqual(left, right) {
  const a = Buffer.from(String(left));
  const b = Buffer.from(String(right));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function isLocalRequest(request) {
  const address = request.socket.remoteAddress || "";
  return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
}

function isAuthorized(request, credentials) {
  const header = request.headers.authorization || "";
  if (!header.startsWith("Basic ")) return false;
  try {
    const [username, password] = Buffer.from(header.slice(6), "base64").toString("utf8").split(":", 2);
    return secureEqual(username, credentials.username) && secureEqual(password, credentials.password);
  } catch {
    return false;
  }
}

function applyCors(request, response) {
  const origin = String(request.headers.origin || "");
  const allowed =
    /^https?:\/\/(?:localhost|127\.0\.0\.1)(?::\d+)?$/.test(origin) ||
    origin === "capacitor://localhost" ||
    /^https:\/\/[a-zA-Z0-9.-]+\.ts\.net(?::\d+)?$/.test(origin);
  if (allowed) {
    response.setHeader("Access-Control-Allow-Origin", origin);
    response.setHeader("Vary", "Origin");
    response.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type");
    response.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    response.setHeader("Access-Control-Max-Age", "600");
  }
}

function sendJson(response, status, body) {
  const payload = Buffer.from(JSON.stringify(body));
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": payload.length,
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff"
  });
  response.end(payload);
}

function readJson(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    request.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_REQUEST_BYTES) {
        reject(Object.assign(new Error("request is too large"), { statusCode: 413 }));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => {
      try {
        const text = Buffer.concat(chunks).toString("utf8");
        resolve(text ? JSON.parse(text) : {});
      } catch {
        reject(Object.assign(new Error("invalid JSON"), { statusCode: 400 }));
      }
    });
    request.on("error", reject);
  });
}

function securityHeaders() {
  return {
    "Content-Security-Policy": [
      "default-src 'self' data: blob:",
      "script-src 'self'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: blob:",
      "connect-src 'self' https://*.ts.net",
      "frame-src https://www.youtube-nocookie.com https://docs.google.com",
      "object-src 'none'",
      "base-uri 'none'",
      "frame-ancestors 'none'"
    ].join("; "),
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY"
  };
}

function serveStatic(request, response, distDirectory) {
  let pathname;
  try {
    pathname = decodeURIComponent(new URL(request.url, "http://localhost").pathname);
  } catch {
    response.writeHead(400).end("Bad request");
    return;
  }
  const relativePath = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
  const candidate = path.resolve(distDirectory, relativePath);
  const root = path.resolve(distDirectory) + path.sep;
  if (!candidate.startsWith(root)) {
    response.writeHead(403).end("Forbidden");
    return;
  }
  let filePath = candidate;
  if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) filePath = path.join(distDirectory, "index.html");
  const extension = path.extname(filePath).toLowerCase();
  const filename = path.basename(filePath).toLowerCase();
  const mustRevalidate = extension === ".html"
    || extension === ".webmanifest"
    || filename === "sw.js"
    || filename === "registersw.js";
  const headers = {
    ...securityHeaders(),
    "Content-Type": MIME_TYPES[extension] || "application/octet-stream",
    "Cache-Control": mustRevalidate ? "no-cache" : "public, max-age=31536000, immutable"
  };
  response.writeHead(200, headers);
  if (request.method === "HEAD") {
    response.end();
    return;
  }
  fs.createReadStream(filePath).pipe(response);
}

function createSyncServer({ store, distDirectory, credentials, host = "127.0.0.1", port = 8765 }) {
  const server = http.createServer(async (request, response) => {
    try {
      const url = new URL(request.url, `http://${request.headers.host || "localhost"}`);
      if (url.pathname.startsWith("/api/")) {
        applyCors(request, response);
        if (request.method === "OPTIONS") {
          response.writeHead(204).end();
          return;
        }
      }
      if (url.pathname === "/api/health" && request.method === "GET") {
        sendJson(response, 200, { ok: true, ...store.getStatus() });
        return;
      }
      if (url.pathname.startsWith("/api/sync/")) {
        if (!isAuthorized(request, credentials)) {
          response.setHeader("WWW-Authenticate", 'Basic realm="Title Placeholder Wiki Sync"');
          sendJson(response, 401, { error: "authentication_required" });
          return;
        }
        if (url.pathname === "/api/sync/push" && request.method === "POST") {
          const body = await readJson(request);
          sendJson(response, 200, await store.push(body.changes || []));
          return;
        }
        if (url.pathname === "/api/sync/pull" && request.method === "POST") {
          const body = await readJson(request);
          sendJson(response, 200, store.pull(body.checkpoint, body.limit));
          return;
        }
        if (url.pathname === "/api/sync/status" && request.method === "GET") {
          sendJson(response, 200, store.getStatus());
          return;
        }
        sendJson(response, 404, { error: "not_found" });
        return;
      }
      if (request.method !== "GET" && request.method !== "HEAD") {
        sendJson(response, 405, { error: "method_not_allowed" });
        return;
      }
      serveStatic(request, response, distDirectory);
    } catch (error) {
      sendJson(response, error.statusCode || 500, {
        error: error.statusCode ? error.message : "internal_error"
      });
    }
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.removeListener("error", reject);
      const address = server.address();
      const listeningPort = typeof address === "object" && address ? address.port : port;
      resolve({
        server,
        host,
        port: listeningPort,
        localUrl: `http://${host}:${listeningPort}`,
        close: () => new Promise((done, fail) => server.close((error) => (error ? fail(error) : done())))
      });
    });
  });
}

module.exports = {
  MAX_REQUEST_BYTES,
  createSyncServer,
  isAuthorized,
  isLocalRequest,
  readJson,
  secureEqual,
  serveStatic
};
