// @vitest-environment node

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const { createSyncServer } = require("../electron/sync-server.cjs");
const { SyncStore } = require("../electron/sync-store.cjs");

const credentials = { username: "wiki-sync", password: "test-secret" };
const authorization = `Basic ${Buffer.from(`${credentials.username}:${credentials.password}`).toString("base64")}`;

describe("desktop sync HTTP server", () => {
  let directory;
  let runtime;

  beforeEach(async () => {
    directory = await fs.mkdtemp(path.join(os.tmpdir(), "wiki-sync-server-"));
    const distDirectory = path.join(directory, "dist");
    await fs.mkdir(distDirectory, { recursive: true });
    await fs.writeFile(path.join(distDirectory, "index.html"), "<!doctype html><title>Wiki</title>");
    const store = new SyncStore(path.join(directory, "data"));
    await store.init();
    runtime = await createSyncServer({
      store,
      distDirectory,
      credentials,
      host: "127.0.0.1",
      port: 0,
    });
  });

  afterEach(async () => {
    await runtime?.close();
    await fs.rm(directory, { recursive: true, force: true });
  });

  it("serves the application and exposes a CORS-safe health check", async () => {
    const page = await fetch(runtime.localUrl);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain("<title>Wiki</title>");

    const preflight = await fetch(`${runtime.localUrl}/api/health`, {
      method: "OPTIONS",
      headers: { Origin: "https://localhost" },
    });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get("access-control-allow-origin")).toBe("https://localhost");
  });

  it("requires credentials and round-trips a versioned document", async () => {
    const denied = await fetch(`${runtime.localUrl}/api/sync/status`);
    expect(denied.status).toBe(401);

    const document = {
      _id: "node:weapons",
      type: "node",
      title: "Weapons",
      baseVersion: null,
      version: { counter: 1, deviceId: "desktop-test" },
    };
    const pushed = await fetch(`${runtime.localUrl}/api/sync/push`, {
      method: "POST",
      headers: { Authorization: authorization, "Content-Type": "application/json" },
      body: JSON.stringify({
        changes: [
          {
            changeId: "change:desktop-test:1",
            entityId: document._id,
            deviceId: "desktop-test",
            baseVersion: null,
            version: document.version,
            document,
          },
        ],
      }),
    });
    expect(pushed.status).toBe(200);
    expect((await pushed.json()).accepted).toEqual(["change:desktop-test:1"]);

    const pulled = await fetch(`${runtime.localUrl}/api/sync/pull`, {
      method: "POST",
      headers: { Authorization: authorization, "Content-Type": "application/json" },
      body: JSON.stringify({ checkpoint: 0 }),
    });
    expect(pulled.status).toBe(200);
    const result = await pulled.json();
    expect(result.checkpoint).toBe(1);
    expect(result.changes[0].document.title).toBe("Weapons");
  });
});
