import assert from "node:assert/strict";
import { test } from "vitest";

import {
  INITIAL_ORDER_KEY,
  compareOrderKeys,
  isValidOrderKey,
  orderKeyBetween,
} from "../src/lib/orderKey.js";
import {
  DOCUMENT_TYPES,
  SchemaValidationError,
  assertDocument,
  createAsset,
  createBlock,
  createNode,
  createRevision,
  createTombstone,
  validateAsset,
  validateBlock,
  validateDocument,
  validateNode,
  validateRevision,
  validateTombstone,
} from "../src/lib/schema.js";

const NOW = "2026-07-13T12:00:00.000Z";
const DEVICE = "test-device";
const DIGEST = "a".repeat(64);

function mutableMetadata(id) {
  return {
    id,
    deviceId: DEVICE,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

test("fractional keys sort before, between, and after existing keys", () => {
  const first = orderKeyBetween();
  const before = orderKeyBetween(null, first);
  const after = orderKeyBetween(first, null);
  const middle = orderKeyBetween(first, after);

  assert.equal(first, INITIAL_ORDER_KEY);
  assert.ok(before < first);
  assert.ok(first < middle);
  assert.ok(middle < after);
  assert.deepEqual(
    [after, before, middle, first].sort(compareOrderKeys),
    [before, first, middle, after],
  );
  [before, first, middle, after].forEach((key) =>
    assert.equal(isValidOrderKey(key), true),
  );
});

test("fractional keys remain valid through dense repeated insertion", () => {
  let upper = INITIAL_ORDER_KEY;
  const descending = [upper];
  for (let index = 0; index < 180; index += 1) {
    upper = orderKeyBetween(null, upper);
    descending.push(upper);
  }
  for (let index = 1; index < descending.length; index += 1) {
    assert.ok(descending[index] < descending[index - 1]);
    assert.equal(isValidOrderKey(descending[index]), true);
  }

  let lower = "A";
  const fixedUpper = "B";
  for (let index = 0; index < 180; index += 1) {
    const key = orderKeyBetween(lower, fixedUpper);
    assert.ok(lower < key && key < fixedUpper);
    lower = key;
  }
});

test("fractional key boundaries reject malformed or inverted input", () => {
  assert.equal(isValidOrderKey(""), false);
  assert.equal(isValidOrderKey("A0"), false);
  assert.equal(isValidOrderKey("한글"), false);
  assert.throws(() => orderKeyBetween("B", "A"), RangeError);
  assert.throws(() => orderKeyBetween("A", "A"), RangeError);
  assert.throws(() => orderKeyBetween("bad key", null), TypeError);
});

test("node creation normalizes input without retaining mutable references", () => {
  const properties = { caliber: 5.56, nested: { enabled: true } };
  const node = createNode({
    ...mutableMetadata("node-1"),
    title: "  돌격소총  ",
    tags: ["무기", "무기", "소총"],
    properties,
  });

  properties.nested.enabled = false;
  assert.equal(node.docType, DOCUMENT_TYPES.NODE);
  assert.equal(node.title, "돌격소총");
  assert.deepEqual(node.tags, ["무기", "소총"]);
  assert.equal(node.properties.nested.enabled, true);
  assert.deepEqual(node.version, { counter: 1, deviceId: DEVICE });
  assert.equal(node.baseVersion, null);
  assert.equal(validateNode(node).valid, true);
  assert.equal(validateDocument(node).valid, true);
  assert.equal(assertDocument(node), node);
});

test("mutable schemas accept an explicit version lineage", () => {
  const block = createBlock({
    ...mutableMetadata("block-1"),
    nodeId: "node-1",
    type: "text",
    data: { html: "<p>본문</p>" },
    version: { counter: 4, deviceId: DEVICE },
    baseVersion: { counter: 3, deviceId: DEVICE },
  });

  assert.equal(block.type, "rich_text");
  assert.deepEqual(block.version, { counter: 4, deviceId: DEVICE });
  assert.deepEqual(block.baseVersion, { counter: 3, deviceId: DEVICE });
  assert.equal(validateBlock(block).valid, true);
});

test("asset schema validates portable metadata and excludes attachment data", () => {
  const asset = createAsset({
    ...mutableMetadata("asset-1"),
    nodeId: "node-1",
    name: "rifle.png",
    mimeType: "IMAGE/PNG",
    size: 1024,
    width: 800,
    height: 600,
    sha256: DIGEST.toUpperCase(),
    altText: "돌격소총",
  });

  assert.equal(asset.mimeType, "image/png");
  assert.equal(asset.sha256, DIGEST);
  assert.equal("_attachments" in asset, false);
  assert.equal(validateAsset(asset).valid, true);
});

test("revision snapshots are detached, deeply frozen, and immutable", () => {
  const node = createNode({
    ...mutableMetadata("node-1"),
    title: "문서",
  });
  const block = createBlock({
    ...mutableMetadata("block-1"),
    nodeId: node.id,
    data: { html: "<p>초안</p>" },
  });
  const revision = createRevision({
    id: "revision-1",
    deviceId: DEVICE,
    createdAt: NOW,
    node,
    blocks: [block],
    reason: "게시 전 저장",
  });

  assert.equal(revision.nodeId, node.id);
  assert.notEqual(revision.snapshot.node, node);
  assert.notEqual(revision.snapshot.blocks[0], block);
  assert.equal(Object.isFrozen(revision), true);
  assert.equal(Object.isFrozen(revision.snapshot.blocks[0].data), true);
  assert.equal(validateRevision(revision).valid, true);
  assert.throws(() => {
    revision.snapshot.blocks[0].data.html = "바뀜";
  }, TypeError);
});

test("tombstones identify a deleted mutable record and are append-only", () => {
  const tombstone = createTombstone({
    id: "tombstone-1",
    deviceId: DEVICE,
    targetId: "block-1",
    targetType: "block",
    deletedAt: NOW,
  });

  assert.equal(tombstone.createdAt, NOW);
  assert.equal(tombstone.updatedAt, NOW);
  assert.equal(Object.isFrozen(tombstone), true);
  assert.equal(validateTombstone(tombstone).valid, true);
});

test("schema validation reports actionable field paths", () => {
  const invalidNode = {
    ...createNode({ ...mutableMetadata("node-2"), title: "문서" }),
    title: "",
    orderKey: "A0",
    version: { counter: 0, deviceId: DEVICE },
  };
  const validation = validateNode(invalidNode);

  assert.equal(validation.valid, false);
  assert.ok(validation.errors.some((error) => error.path === "title"));
  assert.ok(validation.errors.some((error) => error.path === "orderKey"));
  assert.ok(validation.errors.some((error) => error.path === "version.counter"));
  assert.throws(() => assertDocument(invalidNode), SchemaValidationError);

  const invalidAsset = {
    ...createAsset({
      ...mutableMetadata("asset-2"),
      name: "image.png",
      mimeType: "image/png",
      sha256: DIGEST,
    }),
    sha256: "not-a-digest",
  };
  assert.equal(validateAsset(invalidAsset).valid, false);
  assert.equal(validateDocument({ docType: "unknown" }).valid, false);
});
