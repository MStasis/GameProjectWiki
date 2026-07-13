// @vitest-environment node

import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { promisify } from "node:util";
import { createRequire } from "node:module";
import { afterEach, describe, expect, it } from "vitest";
import { createNode } from "../src/lib/schema.js";

const require = createRequire(import.meta.url);
const { createBackup } = require("../electron/backup-service.cjs");
const { SyncStore } = require("../electron/sync-store.cjs");
const gunzip = promisify(zlib.gunzip);
const directories = [];

describe("desktop automatic backup", () => {
  afterEach(async () => {
    await Promise.all(directories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })));
  });

  it("writes a compressed backup that the normal repository importer understands", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "wiki-backup-test-"));
    directories.push(directory);
    const store = new SyncStore(path.join(directory, "data"));
    await store.init();
    const deviceId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const nodeId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    const version = { counter: 1, deviceId };
    const node = createNode({
      id: nodeId,
      deviceId,
      title: "Backup test",
      version,
      baseVersion: null,
      createdAt: "2026-07-13T12:00:00.000Z",
      updatedAt: "2026-07-13T12:00:00.000Z",
    });
    await store.push([{
      changeId: "change:backup-test",
      entityId: `node:${nodeId}`,
      deviceId,
      baseVersion: null,
      version,
      document: {
        ...node,
        _id: `node:${nodeId}`,
      },
    }]);

    const filePath = await createBackup(store, path.join(directory, "backups"), "test");
    expect(filePath).toMatch(/\.wiki-backup\.json\.gz$/);
    const payload = JSON.parse((await gunzip(await fs.readFile(filePath))).toString("utf8"));
    expect(payload).toMatchObject({
      format: "title-placeholder-wiki-backup",
      formatVersion: 1,
      schemaVersion: 1,
      reason: "test",
      documentCount: 1,
    });
    expect(Array.isArray(payload.documents)).toBe(true);
    expect(payload.documents[0].title).toBe("Backup test");
    const digest = crypto.createHash("sha256").update(JSON.stringify(payload.documents)).digest("hex");
    expect(payload.integrity.digest).toBe(digest);
  });
});
