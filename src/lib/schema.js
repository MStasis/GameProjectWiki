import {
  INITIAL_ORDER_KEY,
  assertOrderKey,
  isValidOrderKey,
} from "./orderKey.js";

export const SCHEMA_VERSION = 1;

export const DOCUMENT_TYPES = Object.freeze({
  NODE: "node",
  BLOCK: "block",
  ASSET: "asset",
  REVISION: "revision",
  TOMBSTONE: "tombstone",
});

export const NODE_KINDS = Object.freeze(["folder", "page"]);
export const NODE_STATUSES = Object.freeze(["draft", "published"]);
export const BLOCK_TYPES = Object.freeze([
  "rich_text",
  "image",
  "youtube",
  "google_sheet",
  "callout",
  "divider",
]);
export const TOMBSTONE_TARGET_TYPES = Object.freeze([
  DOCUMENT_TYPES.NODE,
  DOCUMENT_TYPES.BLOCK,
  DOCUMENT_TYPES.ASSET,
]);

const BLOCK_TYPE_ALIASES = Object.freeze({
  text: "rich_text",
  richtext: "rich_text",
  sheet: "google_sheet",
  googlesheet: "google_sheet",
  video: "youtube",
});
const ISO_UTC_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;
const MIME_TYPE_PATTERN = /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/i;
const SHA256_PATTERN = /^[a-f0-9]{64}$/i;
const FORBIDDEN_JSON_KEYS = new Set(["__proto__", "prototype", "constructor"]);
const MAX_JSON_DEPTH = 30;

export class SchemaValidationError extends TypeError {
  constructor(errors, message = "Document does not match its schema.") {
    const normalized = Array.isArray(errors) ? errors : [];
    const detail = normalized
      .slice(0, 3)
      .map((error) => `${error.path}: ${error.message}`)
      .join("; ");
    super(detail ? `${message} ${detail}` : message);
    this.name = "SchemaValidationError";
    this.errors = normalized;
  }
}

function issue(errors, path, message) {
  errors.push(Object.freeze({ path, message }));
}

function result(errors) {
  return Object.freeze({ valid: errors.length === 0, errors: Object.freeze(errors) });
}

function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function validateIdentifier(value, path, errors, { nullable = false } = {}) {
  if (nullable && value === null) {
    return;
  }
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > 200 ||
    value.trim() !== value ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    issue(errors, path, "must be a non-empty identifier of at most 200 characters");
  }
}

function isTimestamp(value) {
  if (typeof value !== "string" || !ISO_UTC_PATTERN.test(value)) {
    return false;
  }
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === value;
}

function validateTimestamp(value, path, errors, { nullable = false } = {}) {
  if (nullable && value === null) {
    return;
  }
  if (!isTimestamp(value)) {
    issue(errors, path, "must be a canonical UTC ISO-8601 timestamp");
  }
}

function validateString(
  value,
  path,
  errors,
  { min = 0, max = Number.POSITIVE_INFINITY } = {},
) {
  if (typeof value !== "string" || value.length < min || value.length > max) {
    issue(errors, path, `must be a string between ${min} and ${max} characters`);
  }
}

function validateInteger(value, path, errors, { min = 0 } = {}) {
  if (!Number.isSafeInteger(value) || value < min) {
    issue(errors, path, `must be a safe integer greater than or equal to ${min}`);
  }
}

function validateJsonValue(value, path, errors, ancestors = new Set(), depth = 0) {
  if (depth > MAX_JSON_DEPTH) {
    issue(errors, path, `must not be nested deeper than ${MAX_JSON_DEPTH} levels`);
    return;
  }
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      issue(errors, path, "must contain only finite numbers");
    }
    return;
  }
  if (typeof value !== "object") {
    issue(errors, path, "must contain only JSON-compatible values");
    return;
  }
  if (ancestors.has(value)) {
    issue(errors, path, "must not contain circular references");
    return;
  }

  ancestors.add(value);
  if (Array.isArray(value)) {
    value.forEach((item, index) =>
      validateJsonValue(item, `${path}[${index}]`, errors, ancestors, depth + 1),
    );
  } else if (!isPlainObject(value)) {
    issue(errors, path, "must contain only plain objects and arrays");
  } else {
    for (const [key, item] of Object.entries(value)) {
      if (FORBIDDEN_JSON_KEYS.has(key)) {
        issue(errors, `${path}.${key}`, "uses a reserved object key");
        continue;
      }
      validateJsonValue(item, `${path}.${key}`, errors, ancestors, depth + 1);
    }
  }
  ancestors.delete(value);
}

function validateVersion(value, path, errors) {
  if (!isPlainObject(value)) {
    issue(errors, path, "must be an object with counter and deviceId");
    return;
  }
  validateInteger(value.counter, `${path}.counter`, errors, { min: 1 });
  validateIdentifier(value.deviceId, `${path}.deviceId`, errors, { nullable: true });
}

function validateBaseVersion(value, path, errors) {
  if (value === null) {
    return;
  }
  validateVersion(value, path, errors);
}

function validateCommon(document, expectedType, errors, { mutable = false } = {}) {
  if (!isPlainObject(document)) {
    issue(errors, "$", "must be a plain object");
    return false;
  }
  if (document.schemaVersion !== SCHEMA_VERSION) {
    issue(errors, "schemaVersion", `must equal ${SCHEMA_VERSION}`);
  }
  if (document.docType !== expectedType) {
    issue(errors, "docType", `must equal ${JSON.stringify(expectedType)}`);
  }
  validateIdentifier(document.id, "id", errors);
  validateIdentifier(document.deviceId, "deviceId", errors, { nullable: true });
  validateTimestamp(document.createdAt, "createdAt", errors);
  validateTimestamp(document.updatedAt, "updatedAt", errors);
  if (
    isTimestamp(document.createdAt) &&
    isTimestamp(document.updatedAt) &&
    document.updatedAt < document.createdAt
  ) {
    issue(errors, "updatedAt", "must not be earlier than createdAt");
  }
  if (mutable) {
    validateVersion(document.version, "version", errors);
    validateBaseVersion(document.baseVersion, "baseVersion", errors);
  }
  return true;
}

function validateDeletedAt(value, errors) {
  validateTimestamp(value, "deletedAt", errors, { nullable: true });
}

function nodeErrors(document) {
  const errors = [];
  if (!validateCommon(document, DOCUMENT_TYPES.NODE, errors, { mutable: true })) {
    return errors;
  }
  validateIdentifier(document.parentId, "parentId", errors, { nullable: true });
  if (document.parentId !== null && document.parentId === document.id) {
    issue(errors, "parentId", "must not reference the node itself");
  }
  if (!NODE_KINDS.includes(document.kind)) {
    issue(errors, "kind", `must be one of: ${NODE_KINDS.join(", ")}`);
  }
  validateString(document.title, "title", errors, { min: 1, max: 180 });
  if (typeof document.title === "string" && document.title.trim().length === 0) {
    issue(errors, "title", "must contain visible text");
  }
  validateString(document.summary, "summary", errors, { max: 500 });
  if (!NODE_STATUSES.includes(document.status)) {
    issue(errors, "status", `must be one of: ${NODE_STATUSES.join(", ")}`);
  }
  if (!isValidOrderKey(document.orderKey)) {
    issue(errors, "orderKey", "must be a canonical fractional order key");
  }
  if (!Array.isArray(document.tags)) {
    issue(errors, "tags", "must be an array");
  } else {
    if (document.tags.length > 100) {
      issue(errors, "tags", "must contain at most 100 tags");
    }
    const seen = new Set();
    document.tags.forEach((tag, index) => {
      validateString(tag, `tags[${index}]`, errors, { min: 1, max: 50 });
      if (typeof tag === "string") {
        if (tag.trim() !== tag) {
          issue(errors, `tags[${index}]`, "must not have surrounding whitespace");
        }
        if (seen.has(tag)) {
          issue(errors, `tags[${index}]`, "must be unique");
        }
        seen.add(tag);
      }
    });
  }
  if (!isPlainObject(document.properties)) {
    issue(errors, "properties", "must be a plain object");
  } else {
    validateJsonValue(document.properties, "properties", errors);
  }
  validateDeletedAt(document.deletedAt, errors);
  return errors;
}

function blockErrors(document) {
  const errors = [];
  if (!validateCommon(document, DOCUMENT_TYPES.BLOCK, errors, { mutable: true })) {
    return errors;
  }
  validateIdentifier(document.nodeId, "nodeId", errors);
  if (!BLOCK_TYPES.includes(document.type)) {
    issue(errors, "type", `must be one of: ${BLOCK_TYPES.join(", ")}`);
  }
  if (!isPlainObject(document.data)) {
    issue(errors, "data", "must be a plain object");
  } else {
    validateJsonValue(document.data, "data", errors);
  }
  if (!isValidOrderKey(document.orderKey)) {
    issue(errors, "orderKey", "must be a canonical fractional order key");
  }
  validateDeletedAt(document.deletedAt, errors);
  return errors;
}

function assetErrors(document) {
  const errors = [];
  if (!validateCommon(document, DOCUMENT_TYPES.ASSET, errors, { mutable: true })) {
    return errors;
  }
  validateIdentifier(document.nodeId, "nodeId", errors, { nullable: true });
  validateString(document.name, "name", errors, { min: 1, max: 255 });
  if (
    typeof document.mimeType !== "string" ||
    document.mimeType.length > 100 ||
    !MIME_TYPE_PATTERN.test(document.mimeType)
  ) {
    issue(errors, "mimeType", "must be a valid MIME type of at most 100 characters");
  }
  validateInteger(document.size, "size", errors);
  validateInteger(document.width, "width", errors);
  validateInteger(document.height, "height", errors);
  if (typeof document.sha256 !== "string" || !SHA256_PATTERN.test(document.sha256)) {
    issue(errors, "sha256", "must be a 64-character hexadecimal SHA-256 digest");
  }
  validateString(document.altText, "altText", errors, { max: 240 });
  validateString(document.caption, "caption", errors, { max: 500 });
  validateDeletedAt(document.deletedAt, errors);
  return errors;
}

function revisionErrors(document) {
  const errors = [];
  if (!validateCommon(document, DOCUMENT_TYPES.REVISION, errors)) {
    return errors;
  }
  if (document.updatedAt !== document.createdAt) {
    issue(errors, "updatedAt", "must equal createdAt for an immutable revision");
  }
  validateIdentifier(document.nodeId, "nodeId", errors);
  validateString(document.reason, "reason", errors, { max: 200 });
  if (!isPlainObject(document.snapshot)) {
    issue(errors, "snapshot", "must be a plain object containing node and blocks");
    return errors;
  }
  const nestedNode = validateNode(document.snapshot.node);
  nestedNode.errors.forEach((error) =>
    issue(errors, `snapshot.node.${error.path}`, error.message),
  );
  if (
    isPlainObject(document.snapshot.node) &&
    document.snapshot.node.id !== document.nodeId
  ) {
    issue(errors, "snapshot.node.id", "must equal nodeId");
  }
  if (!Array.isArray(document.snapshot.blocks)) {
    issue(errors, "snapshot.blocks", "must be an array");
  } else {
    const ids = new Set();
    document.snapshot.blocks.forEach((block, index) => {
      const nestedBlock = validateBlock(block);
      nestedBlock.errors.forEach((error) =>
        issue(errors, `snapshot.blocks[${index}].${error.path}`, error.message),
      );
      if (isPlainObject(block)) {
        if (block.nodeId !== document.nodeId) {
          issue(errors, `snapshot.blocks[${index}].nodeId`, "must equal nodeId");
        }
        if (ids.has(block.id)) {
          issue(errors, `snapshot.blocks[${index}].id`, "must be unique in a revision");
        }
        ids.add(block.id);
      }
    });
  }
  return errors;
}

function tombstoneErrors(document) {
  const errors = [];
  if (!validateCommon(document, DOCUMENT_TYPES.TOMBSTONE, errors)) {
    return errors;
  }
  if (document.updatedAt !== document.createdAt) {
    issue(errors, "updatedAt", "must equal createdAt for an append-only tombstone");
  }
  validateIdentifier(document.targetId, "targetId", errors);
  if (!TOMBSTONE_TARGET_TYPES.includes(document.targetType)) {
    issue(
      errors,
      "targetType",
      `must be one of: ${TOMBSTONE_TARGET_TYPES.join(", ")}`,
    );
  }
  validateTimestamp(document.deletedAt, "deletedAt", errors);
  return errors;
}

export function validateNode(document) {
  return result(nodeErrors(document));
}

export function validateBlock(document) {
  return result(blockErrors(document));
}

export function validateAsset(document) {
  return result(assetErrors(document));
}

export function validateRevision(document) {
  return result(revisionErrors(document));
}

export function validateTombstone(document) {
  return result(tombstoneErrors(document));
}

export function validateDocument(document) {
  if (!isPlainObject(document)) {
    return result([{ path: "$", message: "must be a plain object" }]);
  }
  switch (document.docType) {
    case DOCUMENT_TYPES.NODE:
      return validateNode(document);
    case DOCUMENT_TYPES.BLOCK:
      return validateBlock(document);
    case DOCUMENT_TYPES.ASSET:
      return validateAsset(document);
    case DOCUMENT_TYPES.REVISION:
      return validateRevision(document);
    case DOCUMENT_TYPES.TOMBSTONE:
      return validateTombstone(document);
    default:
      return result([
        {
          path: "docType",
          message: `must be one of: ${Object.values(DOCUMENT_TYPES).join(", ")}`,
        },
      ]);
  }
}

function assertWith(validator, document, name) {
  const validation = validator(document);
  if (!validation.valid) {
    throw new SchemaValidationError(validation.errors, `Invalid ${name}.`);
  }
  return document;
}

export const assertNode = (document) => assertWith(validateNode, document, "node");
export const assertBlock = (document) => assertWith(validateBlock, document, "block");
export const assertAsset = (document) => assertWith(validateAsset, document, "asset");
export const assertRevision = (document) =>
  assertWith(validateRevision, document, "revision");
export const assertTombstone = (document) =>
  assertWith(validateTombstone, document, "tombstone");
export const assertDocument = (document) =>
  assertWith(validateDocument, document, "document");

export const isNode = (document) => validateNode(document).valid;
export const isBlock = (document) => validateBlock(document).valid;
export const isAsset = (document) => validateAsset(document).valid;
export const isRevision = (document) => validateRevision(document).valid;
export const isTombstone = (document) => validateTombstone(document).valid;

export function generateId() {
  const cryptoApi = globalThis.crypto;
  if (cryptoApi && typeof cryptoApi.randomUUID === "function") {
    return cryptoApi.randomUUID();
  }
  if (cryptoApi && typeof cryptoApi.getRandomValues === "function") {
    const bytes = new Uint8Array(16);
    cryptoApi.getRandomValues(bytes);
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0"));
    return `${hex.slice(0, 4).join("")}-${hex.slice(4, 6).join("")}-${hex
      .slice(6, 8)
      .join("")}-${hex.slice(8, 10).join("")}-${hex.slice(10).join("")}`;
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 14)}`;
}

function creationFailure(path, message) {
  throw new SchemaValidationError([{ path, message }], "Cannot create document.");
}

function normalizeIdentifier(value, path, { nullable = false, fallback } = {}) {
  const candidate = value === undefined ? fallback : value;
  if (nullable && (candidate === null || candidate === undefined)) {
    return null;
  }
  const errors = [];
  validateIdentifier(candidate, path, errors);
  if (errors.length) {
    throw new SchemaValidationError(errors, "Cannot create document.");
  }
  return candidate;
}

function normalizeTimestamp(value, path) {
  if (value === undefined) {
    return new Date().toISOString();
  }
  let date;
  if (value instanceof Date) {
    date = value;
  } else if (typeof value === "string" || typeof value === "number") {
    date = new Date(value);
  } else {
    creationFailure(path, "must be a Date or a parseable date value");
  }
  if (!Number.isFinite(date.getTime())) {
    creationFailure(path, "must be a valid date");
  }
  return date.toISOString();
}

function normalizeNullableTimestamp(value, path) {
  return value === null || value === undefined ? null : normalizeTimestamp(value, path);
}

function normalizeString(value, path, { fallback = "", trim = false } = {}) {
  const candidate = value === undefined ? fallback : value;
  if (typeof candidate !== "string") {
    creationFailure(path, "must be a string");
  }
  return trim ? candidate.trim() : candidate;
}

function cloneJson(value, path = "value", ancestors = new Set(), depth = 0) {
  const errors = [];
  validateJsonValue(value, path, errors, ancestors, depth);
  if (errors.length) {
    throw new SchemaValidationError(errors, "Cannot create document.");
  }
  if (value === null || typeof value !== "object") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item, index) => cloneJson(item, `${path}[${index}]`));
  }
  const copy = {};
  for (const [key, item] of Object.entries(value)) {
    copy[key] = cloneJson(item, `${path}.${key}`);
  }
  return copy;
}

function normalizeVersion(value, deviceId) {
  const candidate = value ?? { counter: 1, deviceId };
  const errors = [];
  validateVersion(candidate, "version", errors);
  if (errors.length) {
    throw new SchemaValidationError(errors, "Cannot create document.");
  }
  return Object.freeze({ counter: candidate.counter, deviceId: candidate.deviceId });
}

function normalizeBaseVersion(value) {
  if (value === undefined || value === null) {
    return null;
  }
  const errors = [];
  validateVersion(value, "baseVersion", errors);
  if (errors.length) {
    throw new SchemaValidationError(errors, "Cannot create document.");
  }
  return Object.freeze({ counter: value.counter, deviceId: value.deviceId });
}

function commonFields(input, docType, { mutable = false, immutable = false } = {}) {
  if (!isPlainObject(input)) {
    creationFailure("$", "must be a plain input object");
  }
  const id = normalizeIdentifier(input.id, "id", { fallback: generateId() });
  const deviceId = normalizeIdentifier(input.deviceId, "deviceId", {
    nullable: true,
    fallback: null,
  });
  const firstTimestampInput = input.createdAt ?? input.updatedAt;
  const createdAt = normalizeTimestamp(firstTimestampInput, "createdAt");
  const updatedAt = immutable
    ? createdAt
    : normalizeTimestamp(input.updatedAt ?? createdAt, "updatedAt");
  const fields = {
    schemaVersion: SCHEMA_VERSION,
    docType,
    id,
    deviceId,
    createdAt,
    updatedAt,
  };
  if (mutable) {
    fields.version = normalizeVersion(input.version, deviceId);
    fields.baseVersion = normalizeBaseVersion(input.baseVersion);
  }
  return fields;
}

function normalizeOrderKey(value) {
  const orderKey = value ?? INITIAL_ORDER_KEY;
  assertOrderKey(orderKey);
  return orderKey;
}

export function createNode(input = {}) {
  const tagsInput = input.tags ?? [];
  if (!Array.isArray(tagsInput)) {
    creationFailure("tags", "must be an array");
  }
  const tags = [];
  const seenTags = new Set();
  tagsInput.forEach((tag, index) => {
    const normalized = normalizeString(tag, `tags[${index}]`, { trim: true });
    if (!seenTags.has(normalized)) {
      seenTags.add(normalized);
      tags.push(normalized);
    }
  });
  const propertiesInput = input.properties ?? {};
  if (!isPlainObject(propertiesInput)) {
    creationFailure("properties", "must be a plain object");
  }
  const record = {
    ...commonFields(input, DOCUMENT_TYPES.NODE, { mutable: true }),
    parentId: normalizeIdentifier(input.parentId, "parentId", {
      nullable: true,
      fallback: null,
    }),
    kind: normalizeString(input.kind, "kind", { fallback: "page" }),
    title: normalizeString(input.title, "title", { fallback: "제목 없음", trim: true }),
    summary: normalizeString(input.summary, "summary"),
    status: normalizeString(input.status, "status", { fallback: "draft" }),
    orderKey: normalizeOrderKey(input.orderKey),
    tags,
    properties: cloneJson(propertiesInput, "properties"),
    deletedAt: normalizeNullableTimestamp(input.deletedAt, "deletedAt"),
  };
  return assertNode(record);
}

export function createBlock(input = {}) {
  const rawType = normalizeString(input.type, "type", { fallback: "rich_text" })
    .toLowerCase()
    .replaceAll("-", "_");
  const type = BLOCK_TYPE_ALIASES[rawType] ?? rawType;
  const dataInput = input.data ?? {};
  if (!isPlainObject(dataInput)) {
    creationFailure("data", "must be a plain object");
  }
  const record = {
    ...commonFields(input, DOCUMENT_TYPES.BLOCK, { mutable: true }),
    nodeId: normalizeIdentifier(input.nodeId, "nodeId"),
    type,
    data: cloneJson(dataInput, "data"),
    orderKey: normalizeOrderKey(input.orderKey),
    deletedAt: normalizeNullableTimestamp(input.deletedAt, "deletedAt"),
  };
  return assertBlock(record);
}

export function createAsset(input = {}) {
  const sha256 = normalizeString(input.sha256, "sha256").toLowerCase();
  const record = {
    ...commonFields(input, DOCUMENT_TYPES.ASSET, { mutable: true }),
    nodeId: normalizeIdentifier(input.nodeId, "nodeId", {
      nullable: true,
      fallback: null,
    }),
    name: normalizeString(input.name, "name", { trim: true }),
    mimeType: normalizeString(input.mimeType, "mimeType", { trim: true }).toLowerCase(),
    size: input.size ?? 0,
    width: input.width ?? 0,
    height: input.height ?? 0,
    sha256,
    altText: normalizeString(input.altText, "altText"),
    caption: normalizeString(input.caption, "caption"),
    deletedAt: normalizeNullableTimestamp(input.deletedAt, "deletedAt"),
  };
  return assertAsset(record);
}

function deepFreeze(value, seen = new Set()) {
  if (value === null || typeof value !== "object" || seen.has(value)) {
    return value;
  }
  seen.add(value);
  Object.values(value).forEach((item) => deepFreeze(item, seen));
  return Object.freeze(value);
}

export function createRevision(input = {}) {
  const snapshotInput = input.snapshot ?? {
    node: input.node,
    blocks: input.blocks,
  };
  if (!isPlainObject(snapshotInput)) {
    creationFailure("snapshot", "must be a plain object containing node and blocks");
  }
  const snapshot = cloneJson(
    {
      node: snapshotInput.node,
      blocks: snapshotInput.blocks,
    },
    "snapshot",
  );
  const inferredNodeId = isPlainObject(snapshot.node) ? snapshot.node.id : undefined;
  const record = {
    ...commonFields(input, DOCUMENT_TYPES.REVISION, { immutable: true }),
    nodeId: normalizeIdentifier(input.nodeId, "nodeId", { fallback: inferredNodeId }),
    snapshot,
    reason: normalizeString(input.reason, "reason", { trim: true }),
  };
  assertRevision(record);
  return deepFreeze(record);
}

export function createTombstone(input = {}) {
  const deletedAt = normalizeTimestamp(
    input.deletedAt ?? input.createdAt ?? input.updatedAt,
    "deletedAt",
  );
  const commonInput = {
    ...input,
    createdAt: input.createdAt ?? deletedAt,
    updatedAt: input.createdAt ?? deletedAt,
  };
  const record = {
    ...commonFields(commonInput, DOCUMENT_TYPES.TOMBSTONE, { immutable: true }),
    targetId: normalizeIdentifier(input.targetId, "targetId"),
    targetType: normalizeString(input.targetType, "targetType"),
    deletedAt,
  };
  assertTombstone(record);
  return deepFreeze(record);
}

export function createDocument(docType, input = {}) {
  switch (docType) {
    case DOCUMENT_TYPES.NODE:
      return createNode(input);
    case DOCUMENT_TYPES.BLOCK:
      return createBlock(input);
    case DOCUMENT_TYPES.ASSET:
      return createAsset(input);
    case DOCUMENT_TYPES.REVISION:
      return createRevision(input);
    case DOCUMENT_TYPES.TOMBSTONE:
      return createTombstone(input);
    default:
      creationFailure("docType", `unsupported document type: ${String(docType)}`);
  }
}
