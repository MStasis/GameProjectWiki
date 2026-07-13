import { createRequire } from "node:module";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const { SyncStore } = require("../electron/sync-store.cjs");

const directories = [];

async function createStore() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "wiki-sync-test-"));
  directories.push(directory);
  const store = new SyncStore(directory);
  await store.init();
  return store;
}

function change(overrides = {}) {
  return {
    changeId: overrides.changeId || `change:${crypto.randomUUID()}`,
    entityId: "node:test",
    deviceId: "device-a",
    baseVersion: null,
    version: { counter: 1, deviceId: "device-a" },
    document: {
      _id: "node:test",
      type: "node",
      title: "Test",
      version: { counter: 1, deviceId: "device-a" }
    },
    ...overrides
  };
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })));
});

describe("SyncStore", () => {
  it("accepts, persists and pulls a change", async () => {
    const store = await createStore();
    const first = change({ changeId: "change:first" });
    const pushed = await store.push([first]);
    expect(pushed.accepted).toEqual(["change:first"]);
    expect(store.pull(0).changes[0].document.title).toBe("Test");

    const reopened = new SyncStore(store.directory);
    await reopened.init();
    expect(reopened.getStatus().documentCount).toBe(1);
  });

  it("deduplicates the same change", async () => {
    const store = await createStore();
    const first = change({ changeId: "change:duplicate" });
    await store.push([first]);
    const result = await store.push([first]);
    expect(result.duplicates).toEqual(["change:duplicate"]);
    expect(store.getStatus().sequence).toBe(1);
  });

  it("preserves concurrent versions as a conflict", async () => {
    const store = await createStore();
    await store.push([change({ changeId: "change:base" })]);
    const concurrent = change({
      changeId: "change:phone",
      deviceId: "device-phone",
      version: { counter: 1, deviceId: "device-phone" },
      document: {
        _id: "node:test",
        type: "node",
        title: "Phone version",
        version: { counter: 1, deviceId: "device-phone" }
      }
    });
    const result = await store.push([concurrent]);
    expect(result.conflicts).toHaveLength(1);
    expect(result.conflicts[0].incoming.title).toBe("Phone version");
    expect(store.getStatus().conflictCount).toBe(1);
  });

  it("closes a server conflict when the accepted resolution references it", async () => {
    const store = await createStore();
    const serverVersion = { counter: 1, deviceId: "device-a" };
    await store.push([change({ changeId: "change:base" })]);
    const rejected = await store.push([change({
      changeId: "change:phone",
      deviceId: "device-phone",
      version: { counter: 1, deviceId: "device-phone" },
      document: {
        _id: "node:test",
        type: "node",
        title: "Phone version",
        version: { counter: 1, deviceId: "device-phone" },
      },
    })]);
    const conflictId = rejected.conflicts[0]._id;

    const resolutionVersion = { counter: 2, deviceId: "device-phone" };
    const resolution = change({
      changeId: "change:resolution",
      deviceId: "device-phone",
      baseVersion: serverVersion,
      version: resolutionVersion,
      resolvesConflictId: conflictId,
      document: {
        _id: "node:test",
        type: "node",
        title: "Resolved phone version",
        baseVersion: serverVersion,
        version: resolutionVersion,
      },
    });
    const result = await store.push([resolution]);

    expect(result.accepted).toEqual(["change:resolution"]);
    expect(store.getStatus().conflictCount).toBe(0);
    const resolutionEvent = store.pull(0).changes.at(-1);
    expect(resolutionEvent.resolvesConflictId).toBe(conflictId);
    expect(store.exportState().conflicts[conflictId].resolved).toBe(true);
  });

  it("stores image bytes once and hydrates only the latest pulled event", async () => {
    const store = await createStore();
    const firstVersion = { counter: 1, deviceId: "device-a" };
    const attachment = { file: { content_type: "image/png", data: "iVBORw0KGgo=" } };
    await store.push([change({
      changeId: "change:asset-1",
      entityId: "asset:image",
      version: firstVersion,
      document: {
        _id: "asset:image",
        type: "asset",
        title: "Image",
        version: firstVersion,
        _attachments: attachment,
      },
    })]);
    const secondVersion = { counter: 2, deviceId: "device-a" };
    await store.push([change({
      changeId: "change:asset-2",
      entityId: "asset:image",
      baseVersion: firstVersion,
      version: secondVersion,
      document: {
        _id: "asset:image",
        type: "asset",
        title: "Renamed image",
        baseVersion: firstVersion,
        version: secondVersion,
        _attachments: attachment,
      },
    })]);

    expect(store.exportState().changes.every((entry) => !entry.document?._attachments)).toBe(true);
    const pulled = store.pull(0).changes;
    expect(pulled[0].document._attachments).toBeUndefined();
    expect(pulled[1].document._attachments).toEqual(attachment);
  });
});
