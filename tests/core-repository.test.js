import { afterEach, beforeEach, describe, expect, it } from "vitest";
import PouchDB from "pouchdb-browser";
import memoryAdapter from "pouchdb-adapter-memory";

import { WikiRepository } from "../src/lib/wikiRepository.js";

PouchDB.plugin(memoryAdapter);

const DEVICE_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const DEVICE_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

function idSequence(start = 1) {
  let value = start;
  return () => `00000000-0000-4000-8000-${String(value++).padStart(12, "0")}`;
}

function advancingClock() {
  let value = Date.parse("2026-07-13T12:00:00.000Z");
  return () => new Date(value++);
}

function sanitizer(html) {
  return String(html).replace(/<script[\s\S]*?<\/script>/gi, "").replace(/\son\w+="[^"]*"/gi, "");
}

describe("WikiRepository", () => {
  let db;
  let repository;

  beforeEach(async () => {
    db = new PouchDB(`core-${Math.random()}`, { adapter: "memory" });
    repository = new WikiRepository(db, {
      deviceId: DEVICE_A,
      idFactory: idSequence(),
      clock: advancingClock(),
      sanitizeHtml: sanitizer,
    });
    await repository.init();
  });

  afterEach(async () => {
    await db.destroy();
  });

  it("stores one document per entity, sanitizes blocks, searches, and keeps revisions", async () => {
    const folder = await repository.createNode({ title: "Weapons", kind: "folder" });
    const page = await repository.createNode({ title: "M4A1", parentId: folder.id, tags: ["AR"] });
    const block = await repository.createBlock(page.id, {
      type: "rich_text",
      data: { html: '<p onclick="bad()">Reliable rifle</p><script>bad()</script>' },
    });

    expect(block.data.html).toBe("<p>Reliable rifle</p>");
    expect((await repository.listBlocks(page.id))).toHaveLength(1);
    expect((await repository.search("reliable"))[0].id).toBe(page.id);

    const revision = await repository.saveRevision(page.id, { reason: "first draft" });
    expect(revision.snapshot.node.id).toBe(page.id);
    expect(revision.snapshot.blocks).toHaveLength(1);
    expect((await repository.listRevisions(page.id))[0].reason).toBe("first draft");

    const rows = await db.allDocs({ include_docs: true });
    expect(rows.rows.filter((row) => row.id.startsWith("node:"))).toHaveLength(2);
    expect(rows.rows.filter((row) => row.id.startsWith("block:"))).toHaveLength(1);
    expect(rows.rows.filter((row) => row.id.startsWith("revision:"))).toHaveLength(1);
  });

  it("preserves the complete version chain and removes acknowledged outbox entries", async () => {
    const page = await repository.createNode({ title: "Draft" });
    await repository.updateNode(page.id, { title: "Draft 2" });
    await repository.updateNode(page.id, { title: "Draft 3" });

    const pending = await repository.getPendingChanges();
    expect(pending).toHaveLength(3);
    expect(pending.map((change) => change.document.title)).toEqual(["Draft", "Draft 2", "Draft 3"]);
    expect(pending.map((change) => change.version.counter)).toEqual([1, 2, 3]);
    expect(pending[1].baseVersion).toEqual(pending[0].version);
    expect(pending[2].baseVersion).toEqual(pending[1].version);

    await repository.acknowledgeChanges(pending.map((change) => change.changeId));
    expect(await repository.getPendingChanges()).toEqual([]);
    const outboxRows = await db.allDocs({ ...{ startkey: "outbox:", endkey: "outbox:\uffff" } });
    expect(outboxRows.rows).toHaveLength(0);
  });

  it("does not create conflicts while pulling back its own earlier version chain", async () => {
    const page = await repository.createNode({ title: "v1" });
    await repository.updateNode(page.id, { title: "v2" });
    await repository.updateNode(page.id, { title: "v3" });
    const pending = await repository.getPendingChanges();
    const result = await repository.applyRemoteChanges(pending.map((change, index) => ({
      sequence: index + 1,
      kind: "document",
      entityId: change.entityId,
      document: change.document,
    })));
    expect(result).toMatchObject({ stale: 2, duplicates: 1, conflicts: 0 });
    expect((await repository.getNode(page.id)).title).toBe("v3");
  });

  it("treats reordered repeated remote payloads as duplicates", async () => {
    const original = await repository.createNode({
      title: "Version one",
      properties: { damage: 30, nested: { range: 100, mode: "auto" } },
    });
    const remote = {
      ...original,
      _id: `node:${original.id}`,
      revision: undefined,
      title: "Version two",
      deviceId: DEVICE_B,
      baseVersion: original.version,
      version: { counter: 2, deviceId: DEVICE_B },
      updatedAt: "2026-07-13T13:00:00.000Z",
    };
    const first = await repository.applyRemoteChanges([{ entityId: remote._id, document: remote }]);
    expect(first.applied).toBe(1);

    const reordered = {
      version: remote.version,
      title: remote.title,
      properties: { nested: { mode: "auto", range: 100 }, damage: 30 },
      ...Object.fromEntries(Object.entries(remote).filter(([key]) => !["version", "title", "properties"].includes(key))),
    };
    const second = await repository.applyRemoteChanges([{ entityId: remote._id, document: reordered }]);
    expect(second).toMatchObject({ duplicates: 1, conflicts: 0, applied: 0 });
    expect(await repository.listConflicts()).toEqual([]);
  });

  it("bases a server-rejected conflict resolution on the version retained by the server", async () => {
    const original = await repository.createNode({ title: "Common base" });
    const phone = await repository.updateNode(original.id, { title: "Phone edit" });
    await repository.acknowledgeChanges((await repository.getPendingChanges()).map((item) => item.changeId));
    const serverVersion = { counter: 2, deviceId: DEVICE_B };
    const serverDocument = {
      ...original,
      _id: `node:${original.id}`,
      title: "PC edit",
      deviceId: DEVICE_B,
      baseVersion: original.version,
      version: serverVersion,
      updatedAt: "2026-07-13T13:00:00.000Z",
    };
    await repository.applyRemoteChanges([{
      kind: "conflict",
      entityId: serverDocument._id,
      conflict: {
        _id: `conflict:${serverDocument._id}:99999999-9999-4999-8999-999999999999`,
        entityId: serverDocument._id,
        current: serverDocument,
        incoming: { ...phone, _id: serverDocument._id },
        currentVersion: serverVersion,
        incomingVersion: phone.version,
      },
    }]);

    const [conflict] = await repository.listConflicts();
    const resolved = await repository.resolveConflict(conflict.id, { winner: "incoming" });
    expect(resolved.baseVersion).toEqual(serverVersion);
    const [resolutionChange] = await repository.getPendingChanges();
    expect(resolutionChange.baseVersion).toEqual(serverVersion);
    expect(resolutionChange.document.title).toBe("Phone edit");
    expect(resolutionChange.resolvesConflictId).toBe(conflict.id);
    expect(await repository.listConflicts()).toEqual([]);
  });

  it("closes a pulled conflict when a remote resolution event arrives", async () => {
    const original = await repository.createNode({ title: "Local" });
    const remoteVersion = { counter: 1, deviceId: DEVICE_B };
    const conflictId = `conflict:node:${original.id}:99999999-9999-4999-8999-999999999998`;
    await repository.applyRemoteChanges([{
      kind: "conflict",
      entityId: `node:${original.id}`,
      conflict: {
        _id: conflictId,
        entityId: `node:${original.id}`,
        current: { ...original, _id: `node:${original.id}` },
        incoming: { ...original, _id: `node:${original.id}`, version: remoteVersion },
        currentVersion: original.version,
        incomingVersion: remoteVersion,
      },
    }]);
    expect(await repository.listConflicts()).toHaveLength(1);

    await repository.applyRemoteChanges([{
      kind: "conflict-resolution",
      entityId: `node:${original.id}`,
      conflictId,
      resolutionVersion: { counter: 2, deviceId: DEVICE_B },
      resolvedAt: "2026-07-13T13:30:00.000Z",
    }]);
    expect(await repository.listConflicts()).toEqual([]);
  });

  it("does not retain an unbounded acknowledgement ledger after repeated syncs", async () => {
    const page = await repository.createNode({ title: "0" });
    for (let index = 1; index <= 20; index += 1) {
      await repository.updateNode(page.id, { title: String(index) });
      const pending = await repository.getPendingChanges();
      await repository.acknowledgeChanges(pending.map((change) => change.changeId));
    }
    const rows = await db.allDocs({ startkey: "outbox:", endkey: "outbox:\uffff" });
    expect(rows.rows).toHaveLength(0);
    await expect(db.get("_local/outbox-acknowledgements")).rejects.toMatchObject({ status: 404 });
  });

  it("preserves concurrent remote edits as conflict documents until explicitly resolved", async () => {
    const original = await repository.createNode({ title: "Local draft" });
    const local = await repository.updateNode(original.id, { title: "Local edit" });
    const remote = {
      ...original,
      _id: `node:${original.id}`,
      revision: undefined,
      title: "Phone edit",
      deviceId: DEVICE_B,
      baseVersion: original.version,
      version: { counter: 2, deviceId: DEVICE_B },
      updatedAt: "2026-07-13T13:00:00.000Z",
    };

    const applied = await repository.applyRemoteChanges([
      { kind: "document", entityId: remote._id, document: remote },
    ]);
    expect(applied.conflicts).toBe(1);
    expect((await repository.getNode(original.id)).title).toBe("Local edit");

    const conflicts = await repository.listConflicts();
    expect(conflicts).toHaveLength(1);
    const resolved = await repository.resolveConflict(conflicts[0].id, { winner: "remote" });
    expect(resolved.title).toBe("Phone edit");
    expect(resolved.version.counter).toBe(3);
    expect(await repository.listConflicts()).toEqual([]);
    expect(local.version.counter).toBe(2);
  });

  it("round-trips verified backups and never overwrites a divergent local document during merge", async () => {
    const page = await repository.createNode({ title: "Backup page" });
    await repository.createBlock(page.id, { type: "callout", data: { html: "<p>Keep me</p>" } });
    const backup = await repository.exportData();

    const targetDb = new PouchDB(`core-import-${Math.random()}`, { adapter: "memory" });
    const target = new WikiRepository(targetDb, {
      deviceId: DEVICE_B,
      idFactory: idSequence(500),
      clock: advancingClock(),
      sanitizeHtml: sanitizer,
    });
    await target.init();
    try {
      const firstImport = await target.importData(backup);
      expect(firstImport.imported).toBeGreaterThanOrEqual(2);
      expect((await target.getNode(page.id)).title).toBe("Backup page");

      await target.updateNode(page.id, { title: "Newer local title" });
      const secondImport = await target.importData(backup);
      expect(secondImport.replaced).toBe(0);
      expect(secondImport.conflicts).toBe(0);
      expect((await target.getNode(page.id)).title).toBe("Newer local title");
    } finally {
      await targetDb.destroy();
    }
  });

  it("stores image bytes as a PouchDB attachment", async () => {
    const asset = await repository.addAsset({
      name: "pixel.png",
      mimeType: "image/png",
      sha256: "a".repeat(64),
    }, {
      data: new Uint8Array([137, 80, 78, 71, 1, 2, 3]),
      contentType: "image/png",
    });
    expect(asset.mimeType).toBe("image/png");
    const withData = await repository.getAsset(asset.id, { withData: true });
    expect(withData.attachment.contentType).toBe("image/png");
    expect(await repository.getAssetData(asset.id)).toBeTruthy();
  });
});
