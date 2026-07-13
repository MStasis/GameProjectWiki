import { createUuid, getOrCreateDeviceSettings, isUuid } from "./identity.js";
import { generateOrderKey, isValidOrderKey } from "./orderKey.js";
import {
  BLOCK_TYPES,
  DOCUMENT_TYPES,
  createAsset as createAssetRecord,
  createBlock as createBlockRecord,
  createNode as createNodeRecord,
  createRevision as createRevisionRecord,
  createTombstone as createTombstoneRecord,
  assertDocument,
} from "./schema.js";

export const DOCUMENT_PREFIXES = Object.freeze({
  node: "node:",
  block: "block:",
  asset: "asset:",
  revision: "revision:",
  tombstone: "tombstone:",
  conflict: "conflict:",
  outbox: "outbox:",
});

export const ALLOWED_IMAGE_MIME_TYPES = Object.freeze([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
  "image/avif",
]);

const MUTABLE_TYPES = new Set([
  DOCUMENT_TYPES.NODE,
  DOCUMENT_TYPES.BLOCK,
  DOCUMENT_TYPES.ASSET,
]);
const USER_DOCUMENT_TYPES = new Set(Object.values(DOCUMENT_TYPES));
const DEFAULT_MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const FORBIDDEN_KEYS = new Set(["__proto__", "prototype", "constructor"]);

export class WikiRepositoryError extends Error {
  constructor(message, { code = "REPOSITORY_ERROR", status, cause, details } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = "WikiRepositoryError";
    this.code = code;
    if (status !== undefined) this.status = status;
    if (details !== undefined) this.details = details;
  }
}

export class WikiNotFoundError extends WikiRepositoryError {
  constructor(entity, id, cause) {
    super(`${entity} ${id} was not found.`, {
      code: "NOT_FOUND",
      status: 404,
      cause,
      details: { entity, id },
    });
    this.name = "WikiNotFoundError";
  }
}

export class WikiConflictError extends WikiRepositoryError {
  constructor(message = "The document was changed by another operation.", details, cause) {
    super(message, { code: "CONFLICT", status: 409, cause, details });
    this.name = "WikiConflictError";
  }
}

function isNotFound(error) {
  return error?.status === 404 || error?.name === "not_found" || error?.error === "not_found";
}

function isPouchConflict(error) {
  return error?.status === 409 || error?.name === "conflict" || error?.error === "conflict";
}

function asIso(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw new TypeError("Clock returned an invalid date.");
  return date.toISOString();
}

function cleanText(value, maxLength, { required = false } = {}) {
  const text = String(value ?? "")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
    .trim();
  if (required && !text) throw new TypeError("A non-empty text value is required.");
  return text.slice(0, maxLength);
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function cloneJson(value, depth = 0, seen = new Set()) {
  if (depth > 30) throw new TypeError("JSON data is nested too deeply.");
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("JSON data cannot contain non-finite numbers.");
    return value;
  }
  if (typeof value !== "object") throw new TypeError("Only JSON-compatible data is supported.");
  if (seen.has(value)) throw new TypeError("Circular data is not supported.");
  seen.add(value);
  let result;
  if (Array.isArray(value)) {
    result = value.map((item) => cloneJson(item, depth + 1, seen));
  } else {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError("Only plain objects are supported.");
    }
    result = {};
    for (const [key, item] of Object.entries(value)) {
      if (FORBIDDEN_KEYS.has(key)) continue;
      result[key] = cloneJson(item, depth + 1, seen);
    }
  }
  seen.delete(value);
  return result;
}

function sanitizeRichData(value, sanitizer, depth = 0, key = "") {
  if (depth > 30) throw new TypeError("Block data is nested too deeply.");
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("Block data contains a non-finite number.");
    return value;
  }
  if (typeof value === "string") {
    if (key.toLowerCase() === "html" || key.toLowerCase().endsWith("html")) {
      const sanitized = sanitizer(value);
      if (typeof sanitized !== "string") {
        throw new TypeError("sanitizeHtml must synchronously return a string.");
      }
      return sanitized;
    }
    return value.replace(/\u0000/g, "").slice(0, 100_000);
  }
  if (Array.isArray(value)) {
    return value.slice(0, 2_000).map((item) => sanitizeRichData(item, sanitizer, depth + 1, key));
  }
  if (!value || typeof value !== "object") {
    throw new TypeError("Block data must be JSON-compatible.");
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError("Block data must contain plain objects only.");
  }
  const result = {};
  for (const [childKey, childValue] of Object.entries(value)) {
    if (FORBIDDEN_KEYS.has(childKey)) continue;
    result[childKey] = sanitizeRichData(childValue, sanitizer, depth + 1, childKey);
  }
  return result;
}

function normalizeTags(tags) {
  const unique = new Set();
  for (const item of Array.isArray(tags) ? tags : []) {
    const tag = cleanText(item, 50);
    if (tag) unique.add(tag);
    if (unique.size >= 100) break;
  }
  return Array.from(unique);
}

function normalizeEntityId(value, label = "ID") {
  const text = String(value ?? "").trim();
  const withoutPrefix = Object.values(DOCUMENT_PREFIXES).reduce(
    (candidate, prefix) => candidate.startsWith(prefix) ? candidate.slice(prefix.length) : candidate,
    text,
  );
  if (!isUuid(withoutPrefix)) throw new TypeError(`${label} must be a UUID.`);
  return withoutPrefix.toLowerCase();
}

function documentId(docType, id) {
  const prefix = DOCUMENT_PREFIXES[docType];
  if (!prefix) throw new TypeError(`Unsupported document type: ${String(docType)}`);
  return `${prefix}${id}`;
}

function prefixRange(prefix) {
  return { startkey: prefix, endkey: `${prefix}\uffff` };
}

function compareUpdatedAt(left, right) {
  const leftTime = Date.parse(left?.updatedAt || left?.createdAt || 0) || 0;
  const rightTime = Date.parse(right?.updatedAt || right?.createdAt || 0) || 0;
  return leftTime === rightTime ? 0 : leftTime < rightTime ? -1 : 1;
}

function sameVersion(left, right) {
  return Boolean(left && right)
    && left.counter === right.counter
    && left.deviceId === right.deviceId;
}

function validVersion(value) {
  return value
    && Number.isSafeInteger(value.counter)
    && value.counter >= 1
    && typeof value.deviceId === "string"
    && value.deviceId.length > 0;
}

function nextVersion(current, deviceId) {
  return {
    counter: Math.max(0, Number(current?.version?.counter) || 0) + 1,
    deviceId,
  };
}

function stripPouchMetadata(document, { attachments = true } = {}) {
  const result = {};
  for (const [key, value] of Object.entries(document || {})) {
    if (["_id", "_rev", "_revisions", "_conflicts"].includes(key)) continue;
    if (key === "_attachments" && !attachments) continue;
    result[key] = value;
  }
  return result;
}

function publicDocument(document) {
  if (!document) return null;
  const result = stripPouchMetadata(document, { attachments: false });
  result.id = document.id;
  if (document._rev) result.revision = document._rev;
  if (document.docType === DOCUMENT_TYPES.BLOCK) result.blockType = document.type;
  return result;
}

function searchStrings(value, output = [], depth = 0) {
  if (depth > 12 || output.length > 1_000) return output;
  if (typeof value === "string") {
    output.push(value.replace(/<[^>]*>/g, " "));
  } else if (Array.isArray(value)) {
    value.forEach((item) => searchStrings(item, output, depth + 1));
  } else if (value && typeof value === "object") {
    Object.values(value).forEach((item) => searchStrings(item, output, depth + 1));
  }
  return output;
}

function byteLength(data) {
  if (data == null) return 0;
  if (typeof Blob !== "undefined" && data instanceof Blob) return data.size;
  if (typeof data === "string") return Math.floor((data.replace(/=+$/, "").length * 3) / 4);
  if (Number.isFinite(data.byteLength)) return data.byteLength;
  if (Number.isFinite(data.length)) return data.length;
  return 0;
}

async function toArrayBuffer(data) {
  if (data == null) return new ArrayBuffer(0);
  if (typeof data.arrayBuffer === "function") return data.arrayBuffer();
  if (data instanceof ArrayBuffer) return data;
  if (ArrayBuffer.isView(data)) {
    return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
  }
  if (typeof data === "string" && typeof globalThis.atob === "function") {
    const binary = globalThis.atob(data.replace(/^data:[^,]+,/, ""));
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    return bytes.buffer;
  }
  throw new TypeError("Unsupported attachment data type.");
}

async function sha256Hex(data) {
  if (!globalThis.crypto?.subtle?.digest) {
    throw new WikiRepositoryError("Web Crypto is required to hash image attachments.", {
      code: "CRYPTO_UNAVAILABLE",
    });
  }
  const digest = await globalThis.crypto.subtle.digest("SHA-256", await toArrayBuffer(data));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function canonicalizeForComparison(value, seen = new Set()) {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : String(value);
  if (typeof value === "undefined") return undefined;
  if (typeof value !== "object") return String(value);
  if (seen.has(value)) throw new TypeError("Circular document data cannot be compared.");
  seen.add(value);
  let result;
  if (Array.isArray(value)) {
    result = value.map((item) => canonicalizeForComparison(item, seen));
  } else if (value instanceof ArrayBuffer) {
    result = Array.from(new Uint8Array(value));
  } else if (ArrayBuffer.isView(value)) {
    result = Array.from(new Uint8Array(value.buffer, value.byteOffset, value.byteLength));
  } else {
    result = {};
    for (const key of Object.keys(value).sort()) {
      const normalized = canonicalizeForComparison(value[key], seen);
      if (normalized !== undefined) result[key] = normalized;
    }
  }
  seen.delete(value);
  return result;
}

export function stableDocumentStringify(document) {
  return JSON.stringify(canonicalizeForComparison(stripPouchMetadata(document)));
}

function documentsEqual(left, right) {
  try {
    return stableDocumentStringify(left) === stableDocumentStringify(right);
  } catch {
    return false;
  }
}

/**
 * Offline-first persistence boundary for wiki data.
 *
 * The database is injected so the same class works with pouchdb-browser,
 * pouchdb-adapter-memory in tests, Electron, and Capacitor. Rich HTML is never
 * trusted: callers should inject DOMPurify (or an equivalent allow-list
 * sanitizer). The secure fallback stores markup as escaped text.
 */
export class WikiRepository {
  constructor(db, options = {}) {
    if (!db || typeof db.get !== "function" || typeof db.put !== "function" || typeof db.allDocs !== "function") {
      throw new TypeError("WikiRepository requires a PouchDB-compatible database.");
    }
    this.db = db;
    this.sanitizeHtml = options.sanitizeHtml || escapeHtml;
    if (typeof this.sanitizeHtml !== "function") throw new TypeError("sanitizeHtml must be a function.");
    this.clock = options.clock || (() => new Date());
    this.idFactory = options.idFactory || createUuid;
    this.deviceId = options.deviceId || null;
    this.deviceName = options.deviceName;
    this.maxRetries = Number.isSafeInteger(options.maxRetries) ? options.maxRetries : 5;
    this.maxImageBytes = Number.isSafeInteger(options.maxImageBytes)
      ? options.maxImageBytes
      : DEFAULT_MAX_IMAGE_BYTES;
    this.allowedImageMimeTypes = new Set(options.allowedImageMimeTypes || ALLOWED_IMAGE_MIME_TYPES);
    this.outboxCompactThreshold = Number.isSafeInteger(options.outboxCompactThreshold)
      ? Math.max(1, options.outboxCompactThreshold)
      : 250;
    this._initializing = null;
    this._initialized = false;
  }

  now() {
    return asIso(this.clock());
  }

  async init() {
    if (this._initializing) return this._initializing;
    this._initializing = (async () => {
      const settings = await getOrCreateDeviceSettings(this.db, {
        idFactory: this.deviceId ? () => this.deviceId : createUuid,
        clock: this.clock,
        name: this.deviceName,
        maxRetries: this.maxRetries,
      });
      this.deviceId = settings.deviceId;
      this._initialized = true;
      return { ...settings };
    })();
    try {
      return await this._initializing;
    } catch (error) {
      this._initializing = null;
      throw error;
    }
  }

  async _ready() {
    if (!this._initialized) await this.init();
  }

  _newId(label = "Generated ID") {
    return normalizeEntityId(this.idFactory(), label);
  }

  async _getRaw(docType, id, options = {}) {
    const normalized = normalizeEntityId(id);
    try {
      return await this.db.get(documentId(docType, normalized), options);
    } catch (error) {
      if (isNotFound(error)) throw new WikiNotFoundError(docType, normalized, error);
      throw error;
    }
  }

  async _allRaw(prefix, options = {}) {
    const result = await this.db.allDocs({
      include_docs: true,
      ...prefixRange(prefix),
      ...options,
    });
    return (result.rows || []).map((row) => row.doc).filter(Boolean);
  }

  async _putNew(document, { recordChange = true, operation = "upsert" } = {}) {
    const syncFields = document.version
      ? {}
      : {
          version: { counter: 1, deviceId: this.deviceId },
          baseVersion: null,
        };
    const candidate = {
      ...document,
      ...syncFields,
      _id: documentId(document.docType, document.id),
    };
    try {
      const result = await this.db.put(candidate);
      const stored = { ...candidate, _rev: result.rev || candidate._rev };
      if (recordChange) await this._recordChange(stored, operation);
      return stored;
    } catch (error) {
      if (isPouchConflict(error)) {
        throw new WikiConflictError(`${document.docType} ${document.id} already exists.`, {
          id: document.id,
          docType: document.docType,
        }, error);
      }
      throw error;
    }
  }

  async _mutate(docType, id, mutator, { recordChange = true, operation = "upsert" } = {}) {
    const normalized = normalizeEntityId(id);
    const pouchId = documentId(docType, normalized);
    for (let attempt = 0; attempt <= this.maxRetries; attempt += 1) {
      let current;
      try {
        current = await this.db.get(pouchId);
      } catch (error) {
        if (isNotFound(error)) throw new WikiNotFoundError(docType, normalized, error);
        throw error;
      }
      const next = await mutator({ ...current }, current);
      if (!next) return current;
      try {
        const result = await this.db.put({ ...next, _id: pouchId, _rev: current._rev });
        const stored = { ...next, _id: pouchId, _rev: result.rev || current._rev };
        if (recordChange) await this._recordChange(stored, operation);
        return stored;
      } catch (error) {
        if (isPouchConflict(error) && attempt < this.maxRetries) continue;
        if (isPouchConflict(error)) throw new WikiConflictError(undefined, { id: normalized, docType }, error);
        throw error;
      }
    }
    throw new WikiConflictError(undefined, { id: normalized, docType });
  }

  async _recordChange(document, operation = "upsert", metadata = {}) {
    await this._ready();
    const id = this._newId("Outbox change ID");
    const changedAt = this.now();
    const sequence = await this._nextOutboxSequence();
    const outbox = {
      _id: `${DOCUMENT_PREFIXES.outbox}${this.deviceId}:v2:${String(sequence).padStart(16, "0")}:${id}`,
      schemaVersion: 1,
      docType: "outbox",
      id,
      deviceId: this.deviceId,
      entityDocId: document._id || documentId(document.docType, document.id),
      entityId: document.id,
      entityType: document.docType,
      version: document.version ? { ...document.version } : null,
      baseVersion: document.baseVersion ? { ...document.baseVersion } : null,
      operation,
      ...(metadata.resolvesConflictId
        ? { resolvesConflictId: String(metadata.resolvesConflictId) }
        : {}),
      sequence,
      changedAt,
      createdAt: changedAt,
      // Exact snapshots preserve the logical version chain. Sending only the
      // latest entity for several queued edits would make v3(base=v2) reach a
      // server that still has v1, producing a false conflict.
      documentSnapshot: stripPouchMetadata(document, { attachments: false }),
    };
    try {
      await this.db.put(outbox);
    } catch (error) {
      if (!isPouchConflict(error)) throw error;
      // UUID collisions are extraordinarily unlikely; retrying keeps the
      // failure mode deterministic for injected test ID factories.
      if (this.maxRetries > 0) {
        const retryId = createUuid();
        await this.db.put({
          ...outbox,
          _id: `${DOCUMENT_PREFIXES.outbox}${this.deviceId}:v2:${String(sequence).padStart(16, "0")}:${retryId}`,
          id: retryId,
        });
      } else {
        throw error;
      }
    }
  }

  async _nextOutboxSequence() {
    const id = "_local/outbox-sequence";
    for (let attempt = 0; attempt <= this.maxRetries; attempt += 1) {
      let current;
      try {
        current = await this.db.get(id);
      } catch (error) {
        if (!isNotFound(error)) throw error;
        current = { _id: id, value: 0 };
      }
      const value = Math.max(0, Number(current.value) || 0) + 1;
      try {
        await this.db.put({ ...current, value, updatedAt: this.now() });
        return value;
      } catch (error) {
        if (isPouchConflict(error) && attempt < this.maxRetries) continue;
        throw error;
      }
    }
    throw new WikiConflictError("Could not allocate an outbox sequence number.");
  }

  async _resolveOrder(docType, ownerField, ownerId, input, excludeId = null) {
    if (input.orderKey !== undefined) {
      if (!isValidOrderKey(input.orderKey)) throw new TypeError("orderKey is invalid.");
      return input.orderKey;
    }
    const prefix = DOCUMENT_PREFIXES[docType];
    const documents = (await this._allRaw(prefix))
      .filter((item) => item.id !== excludeId && !item.deletedAt)
      .filter((item) => ownerField ? item[ownerField] === ownerId : true)
      .sort((left, right) => left.orderKey < right.orderKey ? -1 : left.orderKey > right.orderKey ? 1 : 0);
    if (!documents.length) return generateOrderKey(null, null);

    const beforeId = input.beforeId ? normalizeEntityId(input.beforeId, "beforeId") : null;
    const afterId = input.afterId ? normalizeEntityId(input.afterId, "afterId") : null;
    if (beforeId && afterId) throw new TypeError("Use either beforeId or afterId, not both.");
    if (beforeId) {
      const index = documents.findIndex((item) => item.id === beforeId);
      if (index < 0) throw new WikiNotFoundError(`${docType} sibling`, beforeId);
      return generateOrderKey(index > 0 ? documents[index - 1].orderKey : null, documents[index].orderKey);
    }
    if (afterId) {
      const index = documents.findIndex((item) => item.id === afterId);
      if (index < 0) throw new WikiNotFoundError(`${docType} sibling`, afterId);
      return generateOrderKey(documents[index].orderKey, documents[index + 1]?.orderKey ?? null);
    }
    return generateOrderKey(documents.at(-1).orderKey, null);
  }

  async _assertParent(parentId, movingNodeId = null) {
    if (parentId === null) return;
    const parent = await this._getRaw(DOCUMENT_TYPES.NODE, parentId);
    if (parent.deletedAt || parent.kind !== "folder") {
      throw new WikiRepositoryError("The parent must be an active folder.", {
        code: "INVALID_PARENT",
        status: 400,
      });
    }
    if (!movingNodeId) return;
    const visited = new Set([movingNodeId]);
    let ancestor = parent;
    while (ancestor) {
      if (visited.has(ancestor.id)) {
        throw new WikiRepositoryError("Moving this node would create a cycle.", {
          code: "NODE_CYCLE",
          status: 400,
        });
      }
      visited.add(ancestor.id);
      ancestor = ancestor.parentId
        ? await this._getRaw(DOCUMENT_TYPES.NODE, ancestor.parentId)
        : null;
    }
  }

  async createNode(input = {}) {
    await this._ready();
    const id = input.id ? normalizeEntityId(input.id) : this._newId();
    const parentId = input.parentId == null ? null : normalizeEntityId(input.parentId, "parentId");
    await this._assertParent(parentId);
    const orderKey = await this._resolveOrder(DOCUMENT_TYPES.NODE, "parentId", parentId, input);
    const timestamp = this.now();
    const record = createNodeRecord({
      ...input,
      id,
      parentId,
      title: cleanText(input.title, 180, { required: true }),
      summary: cleanText(input.summary, 500),
      kind: input.kind || "page",
      status: input.status || "draft",
      orderKey,
      tags: normalizeTags(input.tags),
      properties: cloneJson(input.properties || {}),
      deviceId: this.deviceId,
      version: { counter: 1, deviceId: this.deviceId },
      baseVersion: null,
      createdAt: timestamp,
      updatedAt: timestamp,
      deletedAt: null,
    });
    return publicDocument(await this._putNew(record));
  }

  async getNode(id, { includeDeleted = false } = {}) {
    const document = await this._getRaw(DOCUMENT_TYPES.NODE, id);
    if (document.deletedAt && !includeDeleted) throw new WikiNotFoundError("node", normalizeEntityId(id));
    return publicDocument(document);
  }

  async listNodes({ includeDeleted = false, parentId, kind, status } = {}) {
    let documents = await this._allRaw(DOCUMENT_PREFIXES.node);
    if (!includeDeleted) documents = documents.filter((item) => !item.deletedAt);
    if (parentId !== undefined) {
      const normalizedParent = parentId === null ? null : normalizeEntityId(parentId, "parentId");
      documents = documents.filter((item) => item.parentId === normalizedParent);
    }
    if (kind) documents = documents.filter((item) => item.kind === kind);
    if (status) documents = documents.filter((item) => item.status === status);
    documents.sort((left, right) => {
      if (left.orderKey !== right.orderKey) return left.orderKey < right.orderKey ? -1 : 1;
      return left.title.localeCompare(right.title);
    });
    return documents.map(publicDocument);
  }

  async updateNode(id, patch = {}) {
    await this._ready();
    const normalized = normalizeEntityId(id);
    const current = await this._getRaw(DOCUMENT_TYPES.NODE, normalized);
    const parentId = patch.parentId === undefined
      ? current.parentId
      : patch.parentId === null ? null : normalizeEntityId(patch.parentId, "parentId");
    await this._assertParent(parentId, normalized);
    const needsOrder = patch.orderKey !== undefined || patch.beforeId || patch.afterId || parentId !== current.parentId;
    const orderKey = needsOrder
      ? await this._resolveOrder(DOCUMENT_TYPES.NODE, "parentId", parentId, patch, normalized)
      : current.orderKey;
    const stored = await this._mutate(DOCUMENT_TYPES.NODE, normalized, (latest) => {
      const timestamp = this.now();
      const record = createNodeRecord({
        ...stripPouchMetadata(latest),
        parentId,
        orderKey,
        title: patch.title === undefined ? latest.title : cleanText(patch.title, 180, { required: true }),
        summary: patch.summary === undefined ? latest.summary : cleanText(patch.summary, 500),
        kind: patch.kind ?? latest.kind,
        status: patch.status ?? latest.status,
        tags: patch.tags === undefined ? latest.tags : normalizeTags(patch.tags),
        properties: patch.properties === undefined ? latest.properties : cloneJson(patch.properties),
        deletedAt: patch.deletedAt === undefined ? latest.deletedAt : patch.deletedAt,
        deviceId: this.deviceId,
        baseVersion: latest.version,
        version: nextVersion(latest, this.deviceId),
        createdAt: latest.createdAt,
        updatedAt: timestamp,
      });
      return { ...record, ...(latest._attachments ? { _attachments: latest._attachments } : {}) };
    });
    return publicDocument(stored);
  }

  async createBlock(nodeId, input = {}) {
    await this._ready();
    const normalizedNodeId = normalizeEntityId(nodeId, "nodeId");
    const node = await this._getRaw(DOCUMENT_TYPES.NODE, normalizedNodeId);
    if (node.deletedAt || node.kind !== "page") {
      throw new WikiRepositoryError("Blocks can only belong to an active page.", {
        code: "INVALID_BLOCK_PARENT",
        status: 400,
      });
    }
    const id = input.id ? normalizeEntityId(input.id) : this._newId();
    const orderKey = await this._resolveOrder(DOCUMENT_TYPES.BLOCK, "nodeId", normalizedNodeId, input);
    const timestamp = this.now();
    const type = input.blockType || input.type || "rich_text";
    const record = createBlockRecord({
      ...input,
      id,
      nodeId: normalizedNodeId,
      type,
      data: sanitizeRichData(input.data || {}, this.sanitizeHtml),
      orderKey,
      deviceId: this.deviceId,
      version: { counter: 1, deviceId: this.deviceId },
      baseVersion: null,
      createdAt: timestamp,
      updatedAt: timestamp,
      deletedAt: null,
    });
    return publicDocument(await this._putNew(record));
  }

  async getBlock(id, { includeDeleted = false } = {}) {
    const document = await this._getRaw(DOCUMENT_TYPES.BLOCK, id);
    if (document.deletedAt && !includeDeleted) throw new WikiNotFoundError("block", normalizeEntityId(id));
    return publicDocument(document);
  }

  async listBlocks(nodeId, { includeDeleted = false } = {}) {
    const normalizedNodeId = normalizeEntityId(nodeId, "nodeId");
    let documents = (await this._allRaw(DOCUMENT_PREFIXES.block))
      .filter((item) => item.nodeId === normalizedNodeId);
    if (!includeDeleted) documents = documents.filter((item) => !item.deletedAt);
    documents.sort((left, right) => left.orderKey < right.orderKey ? -1 : left.orderKey > right.orderKey ? 1 : 0);
    return documents.map(publicDocument);
  }

  async updateBlock(id, patch = {}) {
    await this._ready();
    const normalized = normalizeEntityId(id);
    const current = await this._getRaw(DOCUMENT_TYPES.BLOCK, normalized);
    const nodeId = patch.nodeId === undefined ? current.nodeId : normalizeEntityId(patch.nodeId, "nodeId");
    if (nodeId !== current.nodeId) {
      const node = await this._getRaw(DOCUMENT_TYPES.NODE, nodeId);
      if (node.deletedAt || node.kind !== "page") throw new WikiRepositoryError("Invalid target page.", { code: "INVALID_BLOCK_PARENT" });
    }
    const needsOrder = patch.orderKey !== undefined || patch.beforeId || patch.afterId || nodeId !== current.nodeId;
    const orderKey = needsOrder
      ? await this._resolveOrder(DOCUMENT_TYPES.BLOCK, "nodeId", nodeId, patch, normalized)
      : current.orderKey;
    const stored = await this._mutate(DOCUMENT_TYPES.BLOCK, normalized, (latest) => createBlockRecord({
      ...stripPouchMetadata(latest),
      nodeId,
      type: patch.blockType || patch.type || latest.type,
      data: patch.data === undefined ? latest.data : sanitizeRichData(patch.data, this.sanitizeHtml),
      orderKey,
      deletedAt: patch.deletedAt === undefined ? latest.deletedAt : patch.deletedAt,
      deviceId: this.deviceId,
      baseVersion: latest.version,
      version: nextVersion(latest, this.deviceId),
      createdAt: latest.createdAt,
      updatedAt: this.now(),
    }));
    return publicDocument(stored);
  }

  async _createTombstone(target, deletedAt, deletionBatch = null) {
    const tombstone = createTombstoneRecord({
      id: this._newId("Tombstone ID"),
      targetId: target.id,
      targetType: target.docType,
      deletedAt,
      deviceId: this.deviceId,
      createdAt: deletedAt,
    });
    const record = deletionBatch ? { ...tombstone, deletionBatch } : { ...tombstone };
    return this._putNew(record, { operation: "delete" });
  }

  async _softDelete(docType, id, deletionBatch = null) {
    const normalized = normalizeEntityId(id);
    let deletedAt;
    let changed = false;
    const stored = await this._mutate(docType, normalized, (current) => {
      if (current.deletedAt) {
        deletedAt = current.deletedAt;
        return null;
      }
      changed = true;
      deletedAt = this.now();
      const common = {
        ...stripPouchMetadata(current),
        deletedAt,
        deviceId: this.deviceId,
        baseVersion: current.version,
        version: nextVersion(current, this.deviceId),
        createdAt: current.createdAt,
        updatedAt: deletedAt,
      };
      let record;
      if (docType === DOCUMENT_TYPES.NODE) record = createNodeRecord(common);
      else if (docType === DOCUMENT_TYPES.BLOCK) record = createBlockRecord(common);
      else if (docType === DOCUMENT_TYPES.ASSET) record = createAssetRecord(common);
      else throw new TypeError("Only mutable documents can be soft-deleted.");
      return {
        ...record,
        ...(deletionBatch ? { deletionBatch } : {}),
        ...(current._attachments ? { _attachments: current._attachments } : {}),
      };
    }, { operation: "delete" });
    if (changed) await this._createTombstone(stored, deletedAt, deletionBatch);
    return stored;
  }

  async deleteBlock(id) {
    await this._ready();
    return publicDocument(await this._softDelete(DOCUMENT_TYPES.BLOCK, id));
  }

  async restoreBlock(id) {
    await this._ready();
    const stored = await this._mutate(DOCUMENT_TYPES.BLOCK, id, (current) => {
      if (!current.deletedAt) return null;
      return createBlockRecord({
        ...stripPouchMetadata(current),
        deletedAt: null,
        deviceId: this.deviceId,
        baseVersion: current.version,
        version: nextVersion(current, this.deviceId),
        createdAt: current.createdAt,
        updatedAt: this.now(),
      });
    }, { operation: "restore" });
    return publicDocument(stored);
  }

  async deleteNode(id, { cascade = true } = {}) {
    await this._ready();
    const rootId = normalizeEntityId(id);
    const root = await this._getRaw(DOCUMENT_TYPES.NODE, rootId);
    if (root.deletedAt) return publicDocument(root);
    const deletionBatch = this._newId("Deletion batch ID");
    let targets = [root];

    if (cascade) {
      const nodes = await this._allRaw(DOCUMENT_PREFIXES.node);
      const targetIds = new Set([rootId]);
      let added = true;
      while (added) {
        added = false;
        for (const node of nodes) {
          if (!targetIds.has(node.id) && targetIds.has(node.parentId)) {
            targetIds.add(node.id);
            targets.push(node);
            added = true;
          }
        }
      }
      const [blocks, assets] = await Promise.all([
        this._allRaw(DOCUMENT_PREFIXES.block),
        this._allRaw(DOCUMENT_PREFIXES.asset),
      ]);
      for (const block of blocks) {
        if (targetIds.has(block.nodeId) && !block.deletedAt) {
          await this._softDelete(DOCUMENT_TYPES.BLOCK, block.id, deletionBatch);
        }
      }
      for (const asset of assets) {
        if (targetIds.has(asset.nodeId) && !asset.deletedAt) {
          await this._softDelete(DOCUMENT_TYPES.ASSET, asset.id, deletionBatch);
        }
      }
    }

    // Children are deleted first so a partially interrupted cascade never
    // leaves visible descendants beneath an already deleted ancestor.
    for (const node of targets.reverse()) {
      if (!node.deletedAt) await this._softDelete(DOCUMENT_TYPES.NODE, node.id, deletionBatch);
    }
    return this.getNode(rootId, { includeDeleted: true });
  }

  async restoreNode(id, { cascade = true } = {}) {
    await this._ready();
    const root = await this._getRaw(DOCUMENT_TYPES.NODE, id);
    if (!root.deletedAt) return publicDocument(root);
    const batch = root.deletionBatch;
    const restoreDocument = async (docType, document) => this._mutate(docType, document.id, (current) => {
      if (!current.deletedAt) return null;
      const common = {
        ...stripPouchMetadata(current),
        deletedAt: null,
        deviceId: this.deviceId,
        baseVersion: current.version,
        version: nextVersion(current, this.deviceId),
        createdAt: current.createdAt,
        updatedAt: this.now(),
      };
      delete common.deletionBatch;
      let restored;
      if (docType === DOCUMENT_TYPES.NODE) restored = createNodeRecord(common);
      else if (docType === DOCUMENT_TYPES.BLOCK) restored = createBlockRecord(common);
      else restored = createAssetRecord(common);
      return { ...restored, ...(current._attachments ? { _attachments: current._attachments } : {}) };
    }, { operation: "restore" });

    if (cascade && batch) {
      for (const [docType, prefix] of [
        [DOCUMENT_TYPES.NODE, DOCUMENT_PREFIXES.node],
        [DOCUMENT_TYPES.BLOCK, DOCUMENT_PREFIXES.block],
        [DOCUMENT_TYPES.ASSET, DOCUMENT_PREFIXES.asset],
      ]) {
        const documents = (await this._allRaw(prefix)).filter((item) => item.deletionBatch === batch);
        for (const document of documents) await restoreDocument(docType, document);
      }
    } else {
      await restoreDocument(DOCUMENT_TYPES.NODE, root);
    }
    return this.getNode(root.id, { includeDeleted: true });
  }

  async addAsset(input = {}, attachment = {}) {
    await this._ready();
    const data = attachment.data ?? input.data ?? input.file ?? null;
    if (data == null) throw new TypeError("Image attachment data is required.");
    const mimeType = cleanText(
      attachment.contentType || input.contentType || input.mimeType || data.type,
      100,
      { required: true },
    ).toLowerCase();
    if (!this.allowedImageMimeTypes.has(mimeType)) {
      throw new WikiRepositoryError(`Unsupported image type: ${mimeType}`, {
        code: "UNSUPPORTED_IMAGE_TYPE",
        status: 415,
      });
    }
    const size = byteLength(data);
    if (size <= 0 || size > this.maxImageBytes) {
      throw new WikiRepositoryError(`Image must be between 1 and ${this.maxImageBytes} bytes.`, {
        code: "IMAGE_SIZE_LIMIT",
        status: 413,
      });
    }
    const nodeId = input.nodeId == null ? null : normalizeEntityId(input.nodeId, "nodeId");
    if (nodeId) await this._getRaw(DOCUMENT_TYPES.NODE, nodeId);
    const id = input.id ? normalizeEntityId(input.id) : this._newId();
    const timestamp = this.now();
    const hash = input.sha256 ? String(input.sha256).toLowerCase() : await sha256Hex(data);
    const record = createAssetRecord({
      ...input,
      id,
      nodeId,
      name: cleanText(attachment.filename || input.name || "image", 255, { required: true }),
      mimeType,
      size,
      width: Number.isSafeInteger(input.width) ? input.width : 0,
      height: Number.isSafeInteger(input.height) ? input.height : 0,
      sha256: hash,
      altText: cleanText(input.altText, 240),
      caption: cleanText(input.caption, 500),
      deviceId: this.deviceId,
      version: { counter: 1, deviceId: this.deviceId },
      baseVersion: null,
      createdAt: timestamp,
      updatedAt: timestamp,
      deletedAt: null,
    });
    let attachmentData = data;
    if (data instanceof ArrayBuffer) {
      attachmentData = new Uint8Array(data);
    } else if (ArrayBuffer.isView(data) && !(data instanceof Uint8Array)) {
      attachmentData = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    }
    const withAttachment = {
      ...record,
      _attachments: {
        file: {
          content_type: mimeType,
          data: attachmentData,
        },
      },
    };
    return publicDocument(await this._putNew(withAttachment));
  }

  async createAsset(input = {}, attachment = {}) {
    return this.addAsset(input, attachment);
  }

  async getAsset(id, { withData = false, includeDeleted = false } = {}) {
    const document = await this._getRaw(DOCUMENT_TYPES.ASSET, id, withData
      ? { attachments: true, binary: true }
      : {});
    if (document.deletedAt && !includeDeleted) throw new WikiNotFoundError("asset", normalizeEntityId(id));
    const result = publicDocument(document);
    if (withData) {
      const attachment = document._attachments?.file;
      result.attachment = attachment ? {
        name: document.name,
        contentType: attachment.content_type || document.mimeType,
        data: attachment.data,
        size: document.size,
      } : null;
    }
    return result;
  }

  async getAssetData(id) {
    const asset = await this._getRaw(DOCUMENT_TYPES.ASSET, id);
    if (asset.deletedAt) throw new WikiNotFoundError("asset", normalizeEntityId(id));
    if (typeof this.db.getAttachment === "function") {
      return this.db.getAttachment(asset._id, "file");
    }
    const withData = await this.db.get(asset._id, { attachments: true, binary: true });
    return withData._attachments?.file?.data ?? null;
  }

  async listAssets({ nodeId, includeDeleted = false } = {}) {
    let documents = await this._allRaw(DOCUMENT_PREFIXES.asset);
    if (nodeId !== undefined) {
      const normalized = nodeId === null ? null : normalizeEntityId(nodeId, "nodeId");
      documents = documents.filter((item) => item.nodeId === normalized);
    }
    if (!includeDeleted) documents = documents.filter((item) => !item.deletedAt);
    documents.sort((left, right) => compareUpdatedAt(right, left));
    return documents.map(publicDocument);
  }

  async updateAsset(id, patch = {}) {
    await this._ready();
    const stored = await this._mutate(DOCUMENT_TYPES.ASSET, id, (current) => {
      const record = createAssetRecord({
        ...stripPouchMetadata(current),
        nodeId: patch.nodeId === undefined
          ? current.nodeId
          : patch.nodeId === null ? null : normalizeEntityId(patch.nodeId, "nodeId"),
        name: patch.name === undefined ? current.name : cleanText(patch.name, 255, { required: true }),
        altText: patch.altText === undefined ? current.altText : cleanText(patch.altText, 240),
        caption: patch.caption === undefined ? current.caption : cleanText(patch.caption, 500),
        deletedAt: patch.deletedAt === undefined ? current.deletedAt : patch.deletedAt,
        deviceId: this.deviceId,
        baseVersion: current.version,
        version: nextVersion(current, this.deviceId),
        createdAt: current.createdAt,
        updatedAt: this.now(),
      });
      return { ...record, _attachments: current._attachments };
    });
    return publicDocument(stored);
  }

  async deleteAsset(id) {
    await this._ready();
    return publicDocument(await this._softDelete(DOCUMENT_TYPES.ASSET, id));
  }

  async restoreAsset(id) {
    await this._ready();
    const stored = await this._mutate(DOCUMENT_TYPES.ASSET, id, (current) => {
      if (!current.deletedAt) return null;
      const record = createAssetRecord({
        ...stripPouchMetadata(current),
        deletedAt: null,
        deviceId: this.deviceId,
        baseVersion: current.version,
        version: nextVersion(current, this.deviceId),
        createdAt: current.createdAt,
        updatedAt: this.now(),
      });
      return { ...record, _attachments: current._attachments };
    }, { operation: "restore" });
    return publicDocument(stored);
  }

  async saveRevision(nodeId, { reason = "" } = {}) {
    await this._ready();
    const normalizedNodeId = normalizeEntityId(nodeId, "nodeId");
    const [node, blocks] = await Promise.all([
      this._getRaw(DOCUMENT_TYPES.NODE, normalizedNodeId),
      this._allRaw(DOCUMENT_PREFIXES.block),
    ]);
    const timestamp = this.now();
    const revision = createRevisionRecord({
      id: this._newId("Revision ID"),
      nodeId: normalizedNodeId,
      reason: cleanText(reason, 200),
      snapshot: {
        node: stripPouchMetadata(node, { attachments: false }),
        blocks: blocks
          .filter((block) => block.nodeId === normalizedNodeId)
          .sort((left, right) => left.orderKey < right.orderKey ? -1 : 1)
          .map((block) => stripPouchMetadata(block, { attachments: false })),
      },
      deviceId: this.deviceId,
      createdAt: timestamp,
    });
    return publicDocument(await this._putNew({ ...revision }));
  }

  async createRevision(nodeId, options) {
    return this.saveRevision(nodeId, options);
  }

  async getRevision(id) {
    return publicDocument(await this._getRaw(DOCUMENT_TYPES.REVISION, id));
  }

  async listRevisions(nodeId, { limit = 100 } = {}) {
    const normalized = normalizeEntityId(nodeId, "nodeId");
    const documents = (await this._allRaw(DOCUMENT_PREFIXES.revision))
      .filter((document) => document.nodeId === normalized)
      .sort((left, right) => compareUpdatedAt(right, left))
      .slice(0, Math.max(0, limit));
    return documents.map(publicDocument);
  }

  async search(query, { includeDeleted = false, limit = 100 } = {}) {
    const needle = String(query ?? "").normalize("NFKC").trim().toLocaleLowerCase();
    if (!needle) return [];
    const [nodes, blocks] = await Promise.all([
      this._allRaw(DOCUMENT_PREFIXES.node),
      this._allRaw(DOCUMENT_PREFIXES.block),
    ]);
    const blocksByNode = new Map();
    for (const block of blocks) {
      if (!includeDeleted && block.deletedAt) continue;
      if (!blocksByNode.has(block.nodeId)) blocksByNode.set(block.nodeId, []);
      blocksByNode.get(block.nodeId).push(block);
    }
    const matches = [];
    for (const node of nodes) {
      if (!includeDeleted && node.deletedAt) continue;
      let score = 0;
      const normalizedTitle = node.title.normalize("NFKC").toLocaleLowerCase();
      if (normalizedTitle === needle) score += 100;
      else if (normalizedTitle.includes(needle)) score += 50;
      const nodeText = [node.summary, ...node.tags, ...searchStrings(node.properties)]
        .join(" ")
        .normalize("NFKC")
        .toLocaleLowerCase();
      if (nodeText.includes(needle)) score += 15;
      const matchedBlockIds = [];
      let excerpt = "";
      for (const block of blocksByNode.get(node.id) || []) {
        const text = searchStrings(block.data).join(" ").replace(/\s+/g, " ").trim();
        const normalized = text.normalize("NFKC").toLocaleLowerCase();
        const index = normalized.indexOf(needle);
        if (index >= 0) {
          score += 10;
          matchedBlockIds.push(block.id);
          if (!excerpt) excerpt = text.slice(Math.max(0, index - 50), index + needle.length + 100);
        }
      }
      if (score > 0) matches.push({ ...publicDocument(node), score, excerpt, matchedBlockIds });
    }
    matches.sort((left, right) => right.score - left.score || left.title.localeCompare(right.title));
    return matches.slice(0, Math.max(0, limit));
  }

  _documentTypeFromId(value) {
    const id = String(value || "");
    return Object.values(DOCUMENT_TYPES).find((type) => id.startsWith(DOCUMENT_PREFIXES[type])) || null;
  }

  _prepareUserDocument(rawDocument, entityDocId = null, { requireVersion = true } = {}) {
    if (!rawDocument || typeof rawDocument !== "object" || Array.isArray(rawDocument)) {
      throw new TypeError("A synced document must be an object.");
    }
    const attachments = rawDocument._attachments;
    const plainInput = {};
    for (const [key, value] of Object.entries(rawDocument)) {
      if (["_id", "_rev", "_revisions", "_conflicts", "revision", "blockType", "_attachments"].includes(key)) continue;
      plainInput[key] = value;
    }
    const document = cloneJson(plainInput);
    const hintedId = entityDocId || rawDocument._id;
    const docType = document.docType || this._documentTypeFromId(hintedId);
    if (!USER_DOCUMENT_TYPES.has(docType)) {
      throw new TypeError(`Unsupported synced document type: ${String(docType)}`);
    }
    document.docType = docType;
    const prefix = DOCUMENT_PREFIXES[docType];
    const hintedEntityId = String(hintedId || "").startsWith(prefix)
      ? String(hintedId).slice(prefix.length)
      : hintedId;
    document.id = normalizeEntityId(document.id || hintedEntityId, "document.id");
    const expectedPouchId = documentId(docType, document.id);
    if (hintedId && String(hintedId) !== document.id && String(hintedId) !== expectedPouchId) {
      throw new TypeError("The document ID does not match its entity ID.");
    }

    if (requireVersion && !validVersion(document.version)) {
      throw new WikiRepositoryError("Synced documents must include a valid version.", {
        code: "SYNC_VERSION_REQUIRED",
        status: 400,
        details: { entityId: expectedPouchId },
      });
    }
    if (document.baseVersion != null && !validVersion(document.baseVersion)) {
      throw new TypeError("baseVersion is invalid.");
    }

    if (docType === DOCUMENT_TYPES.NODE) {
      document.title = cleanText(document.title, 180, { required: true });
      document.summary = cleanText(document.summary, 500);
      document.tags = normalizeTags(document.tags);
      document.properties = cloneJson(document.properties || {});
    } else if (docType === DOCUMENT_TYPES.BLOCK) {
      document.type = document.type || rawDocument.blockType;
      document.data = sanitizeRichData(document.data || {}, this.sanitizeHtml);
    } else if (docType === DOCUMENT_TYPES.ASSET) {
      if (!this.allowedImageMimeTypes.has(document.mimeType)) {
        throw new WikiRepositoryError(`Unsupported image type: ${document.mimeType}`, {
          code: "UNSUPPORTED_IMAGE_TYPE",
          status: 415,
        });
      }
      if (attachments?.file) {
        const attachmentType = attachments.file.content_type || document.mimeType;
        if (!this.allowedImageMimeTypes.has(attachmentType)) {
          throw new WikiRepositoryError("The image attachment MIME type is not allowed.", {
            code: "UNSUPPORTED_IMAGE_TYPE",
            status: 415,
          });
        }
        const attachmentSize = byteLength(attachments.file.data);
        if (attachmentSize > this.maxImageBytes) {
          throw new WikiRepositoryError("The image attachment exceeds the configured size limit.", {
            code: "IMAGE_SIZE_LIMIT",
            status: 413,
          });
        }
      }
    } else if (docType === DOCUMENT_TYPES.REVISION) {
      if (document.snapshot?.blocks) {
        document.snapshot.blocks = document.snapshot.blocks.map((block) => ({
          ...block,
          data: sanitizeRichData(block.data || {}, this.sanitizeHtml),
        }));
      }
    }
    assertDocument(document);
    return {
      ...document,
      ...(attachments ? { _attachments: attachments } : {}),
      _id: expectedPouchId,
    };
  }

  async getPendingChanges({ limit = 100, includeAttachments = true } = {}) {
    await this._ready();
    const outbox = await this._allRaw(DOCUMENT_PREFIXES.outbox);
    const pending = outbox
      .filter((entry) => entry.deviceId === this.deviceId)
      .sort((left, right) => left._id < right._id ? -1 : 1);

    const changes = [];
    for (const entry of pending.slice(0, Math.max(0, limit))) {
      let snapshot = entry.documentSnapshot ? cloneJson(entry.documentSnapshot) : null;
      let current = null;
      // Asset snapshots deliberately omit the potentially large attachment.
      // Hydrate bytes from the immutable asset document only at send time.
      if (!snapshot || (includeAttachments && entry.entityType === DOCUMENT_TYPES.ASSET)) {
        try {
          current = await this.db.get(entry.entityDocId, includeAttachments
            ? { attachments: true, binary: false }
            : {});
        } catch (error) {
          if (isNotFound(error)) {
            throw new WikiRepositoryError("An outbox entry references a missing document.", {
              code: "OUTBOX_DOCUMENT_MISSING",
              details: { changeId: entry._id, entityId: entry.entityDocId },
              cause: error,
            });
          }
          throw error;
        }
      }
      snapshot ||= stripPouchMetadata(current, { attachments: false });
      if (!validVersion(snapshot.version)) {
        throw new WikiRepositoryError("Pending documents must include a version.", {
          code: "SYNC_VERSION_REQUIRED",
          details: { entityId: entry.entityDocId },
        });
      }
      const outbound = {
        ...snapshot,
        ...(includeAttachments && current?._attachments ? { _attachments: current._attachments } : {}),
        _id: entry.entityDocId,
      };
      changes.push({
        changeId: entry._id,
        id: entry._id,
        entityId: entry.entityDocId,
        documentId: entry.entityDocId,
        deviceId: this.deviceId,
        baseVersion: outbound.baseVersion ?? null,
        version: outbound.version,
        operation: entry.operation,
        resolvesConflictId: entry.resolvesConflictId || null,
        createdAt: entry.changedAt,
        document: outbound,
      });
    }
    return changes;
  }

  async acknowledgeChanges(changeIds) {
    await this._ready();
    const requested = new Set(
      (Array.isArray(changeIds) ? changeIds : [changeIds])
        .map((item) => typeof item === "string" ? item : item?.changeId || item?.id)
        .filter(Boolean),
    );
    if (!requested.size) return 0;
    const deviceOutbox = (await this._allRaw(DOCUMENT_PREFIXES.outbox))
      .filter((entry) => entry.deviceId === this.deviceId)
      .sort((left, right) => left._id < right._id ? -1 : 1);
    const selected = deviceOutbox.filter((entry) => requested.has(entry._id));
    if (!selected.length) return 0;
    const deletions = selected.map((entry) => ({ _id: entry._id, _rev: entry._rev, _deleted: true }));
    const results = typeof this.db.bulkDocs === "function"
      ? await this.db.bulkDocs(deletions)
      : await Promise.all(deletions.map((entry) => this.db.remove(entry._id, entry._rev)));
    const failures = (results || []).filter((item) => item?.error && item.status !== 404);
    if (failures.length) {
      throw new WikiRepositoryError("Some acknowledged outbox entries could not be removed.", {
        code: "OUTBOX_ACK_ERROR",
        details: { failures },
      });
    }
    await this._maintainOutbox(selected.length);
    return selected.length;
  }

  async _maintainOutbox(removedCount) {
    if (typeof this.db.compact !== "function") return;
    const id = "_local/outbox-maintenance";
    for (let attempt = 0; attempt <= this.maxRetries; attempt += 1) {
      let current;
      try {
        current = await this.db.get(id);
      } catch (error) {
        if (!isNotFound(error)) throw error;
        current = { _id: id, removedSinceCompaction: 0 };
      }
      const total = (Number(current.removedSinceCompaction) || 0) + removedCount;
      const shouldCompact = total >= this.outboxCompactThreshold;
      try {
        await this.db.put({
          ...current,
          removedSinceCompaction: shouldCompact ? 0 : total,
          updatedAt: this.now(),
        });
        if (shouldCompact) {
          try {
            await this.db.compact();
          } catch {
            // Compaction is maintenance only. ACK deletion is already durable
            // and server-side change IDs make a crash/retry idempotent.
          }
        }
        return;
      } catch (error) {
        if (isPouchConflict(error) && attempt < this.maxRetries) continue;
        throw error;
      }
    }
  }

  _makeConflictDocument({
    entityDocId,
    local,
    remote,
    source = "sync",
    reason = "concurrent-edit",
    id = null,
    serverVersion,
    expectedLocalVersion,
  }) {
    const timestamp = this.now();
    const conflictId = id && String(id).startsWith(DOCUMENT_PREFIXES.conflict)
      ? String(id)
      : `${DOCUMENT_PREFIXES.conflict}${encodeURIComponent(entityDocId)}:${this._newId("Conflict ID")}`;
    return {
      _id: conflictId,
      schemaVersion: 1,
      docType: "conflict",
      type: "conflict",
      entityDocId,
      entityId: entityDocId,
      local: local ? stripPouchMetadata(local) : null,
      remote: remote ? stripPouchMetadata(remote) : null,
      localVersion: local?.version ? { ...local.version } : null,
      remoteVersion: remote?.version ? { ...remote.version } : null,
      serverVersion: serverVersion === undefined
        ? null
        : serverVersion ? { ...serverVersion } : null,
      expectedLocalVersion: expectedLocalVersion === undefined
        ? (local?.version ? { ...local.version } : null)
        : expectedLocalVersion ? { ...expectedLocalVersion } : null,
      source,
      reason,
      status: "open",
      createdAt: timestamp,
      updatedAt: timestamp,
    };
  }

  async _persistConflict(details) {
    const document = this._makeConflictDocument(details);
    try {
      await this.db.put(document);
      return document;
    } catch (error) {
      if (isPouchConflict(error)) return this.db.get(document._id);
      throw error;
    }
  }

  async _markConflictResolved(conflictId, entityDocId, resolutionVersion, resolvedAt = this.now()) {
    if (!conflictId || !String(conflictId).startsWith(DOCUMENT_PREFIXES.conflict)) return false;
    for (let attempt = 0; attempt <= this.maxRetries; attempt += 1) {
      let conflict;
      try {
        conflict = await this.db.get(String(conflictId));
      } catch (error) {
        if (isNotFound(error)) return false;
        throw error;
      }
      if (conflict.status === "resolved") return false;
      if ((conflict.entityDocId || conflict.entityId) !== entityDocId) return false;
      try {
        await this.db.put({
          ...conflict,
          status: "resolved",
          resolution: "remote-sync",
          resolutionVersion: resolutionVersion ? { ...resolutionVersion } : null,
          resolvedAt,
          updatedAt: resolvedAt,
        });
        return true;
      } catch (error) {
        if (isPouchConflict(error) && attempt < this.maxRetries) continue;
        throw error;
      }
    }
    return false;
  }

  async applyRemoteChanges(changes, { source = "sync" } = {}) {
    await this._ready();
    if (!Array.isArray(changes)) throw new TypeError("Remote changes must be an array.");
    const result = { applied: 0, duplicates: 0, stale: 0, conflicts: 0, conflictIds: [] };
    for (const change of changes) {
      if (change?.kind === "conflict-resolution") {
        const marked = await this._markConflictResolved(
          change.conflictId || change.resolvesConflictId,
          change.entityId,
          change.resolutionVersion || null,
          change.resolvedAt || this.now(),
        );
        if (marked) result.applied += 1;
        else result.duplicates += 1;
        continue;
      }
      if (change?.kind === "conflict" || (change?.conflict && !change?.document)) {
        const remoteConflict = change.conflict || change;
        const entityDocId = remoteConflict.entityId || change.entityId;
        if (typeof entityDocId !== "string" || !entityDocId) {
          throw new TypeError("Remote conflict is missing entityId.");
        }
        const conflict = this._makeConflictDocument({
          entityDocId,
          local: remoteConflict.current || remoteConflict.local || null,
          remote: remoteConflict.incoming || remoteConflict.remote || null,
          source,
          reason: "remote-conflict",
          id: remoteConflict._id,
          serverVersion: remoteConflict.currentVersion
            || remoteConflict.current?.version
            || remoteConflict.local?.version
            || null,
          expectedLocalVersion: remoteConflict.incomingVersion
            || remoteConflict.incoming?.version
            || remoteConflict.remote?.version
            || null,
        });
        try {
          await this.db.put(conflict);
          result.conflicts += 1;
          result.conflictIds.push(conflict._id);
        } catch (error) {
          if (isPouchConflict(error)) result.duplicates += 1;
          else throw error;
        }
        continue;
      }

      const rawDocument = change?.document || change?.doc || change;
      const hintedId = change?.entityId || rawDocument?._id;
      const incoming = this._prepareUserDocument(rawDocument, hintedId, { requireVersion: true });
      if (change?.resolvesConflictId) {
        await this._markConflictResolved(
          change.resolvesConflictId,
          incoming._id,
          incoming.version,
          incoming.updatedAt || this.now(),
        );
      }
      let current = null;
      try {
        current = await this.db.get(incoming._id, { attachments: true, binary: false });
      } catch (error) {
        if (!isNotFound(error)) throw error;
      }

      if (!current) {
        if (incoming.baseVersion !== null) {
          const conflict = await this._persistConflict({
            entityDocId: incoming._id,
            local: null,
            remote: incoming,
            source,
            reason: "missing-base",
            serverVersion: incoming.version,
            expectedLocalVersion: null,
          });
          result.conflicts += 1;
          result.conflictIds.push(conflict._id);
          continue;
        }
        await this.db.put(incoming);
        result.applied += 1;
        continue;
      }

      if (!validVersion(current.version)) {
        const conflict = await this._persistConflict({
          entityDocId: incoming._id,
          local: current,
          remote: incoming,
          source,
          reason: "local-version-missing",
          serverVersion: incoming.version,
          expectedLocalVersion: null,
        });
        result.conflicts += 1;
        result.conflictIds.push(conflict._id);
        continue;
      }
      if (sameVersion(current.version, incoming.version)) {
        if (documentsEqual(current, incoming)) result.duplicates += 1;
        else {
          const conflict = await this._persistConflict({
            entityDocId: incoming._id,
            local: current,
            remote: incoming,
            source,
            reason: "same-version-different-content",
            serverVersion: incoming.version,
            expectedLocalVersion: current.version,
          });
          result.conflicts += 1;
          result.conflictIds.push(conflict._id);
        }
        continue;
      }
      if (
        current.version.deviceId === incoming.version.deviceId
        && current.version.counter > incoming.version.counter
      ) {
        // A single device emits strictly increasing per-document versions.
        // This commonly occurs when a device pushes v1/v2/v3 and immediately
        // pulls its own server log while its local database is already at v3.
        result.stale += 1;
        continue;
      }
      if (sameVersion(current.version, incoming.baseVersion)) {
        await this.db.put({ ...incoming, _rev: current._rev });
        result.applied += 1;
        continue;
      }
      if (sameVersion(current.baseVersion, incoming.version)) {
        result.stale += 1;
        continue;
      }

      const conflict = await this._persistConflict({
        entityDocId: incoming._id,
        local: current,
        remote: incoming,
        source,
        reason: "concurrent-edit",
        serverVersion: incoming.version,
        expectedLocalVersion: current.version,
      });
      result.conflicts += 1;
      result.conflictIds.push(conflict._id);
    }
    return result;
  }

  async listConflicts({ includeResolved = false } = {}) {
    const [appConflicts, pouchRows] = await Promise.all([
      this._allRaw(DOCUMENT_PREFIXES.conflict),
      this.db.allDocs({ include_docs: true, conflicts: true }),
    ]);
    const result = appConflicts
      .filter((conflict) => includeResolved || conflict.status === "open")
      .map((conflict) => ({
        ...stripPouchMetadata(conflict),
        id: conflict._id,
        conflictType: "application",
      }));
    for (const row of pouchRows.rows || []) {
      if (!row.doc?._conflicts?.length || row.id.startsWith("_")) continue;
      result.push({
        id: row.id,
        entityDocId: row.id,
        conflictType: "pouchdb",
        winningRevision: row.doc._rev,
        revisions: [...row.doc._conflicts],
        local: publicDocument(row.doc),
        status: "open",
      });
    }
    result.sort((left, right) => String(right.createdAt || "").localeCompare(String(left.createdAt || "")));
    return result;
  }

  async resolveConflict(conflictId, { winner = "local", merge = null, force = false } = {}) {
    await this._ready();
    if (String(conflictId).startsWith(DOCUMENT_PREFIXES.conflict)) {
      const conflict = await this.db.get(String(conflictId));
      if (conflict.status !== "open") throw new WikiConflictError("This conflict is already resolved.");
      const entityDocId = conflict.entityDocId || conflict.entityId;
      let current = null;
      try {
        current = await this.db.get(entityDocId, { attachments: true, binary: false });
      } catch (error) {
        if (!isNotFound(error)) throw error;
      }
      const expectedLocalVersion = conflict.expectedLocalVersion === undefined
        ? conflict.localVersion
        : conflict.expectedLocalVersion;
      if (!force && !sameVersion(current?.version ?? null, expectedLocalVersion ?? null)) {
        throw new WikiConflictError("The local document changed after this conflict was recorded.", {
          code: "STALE_CONFLICT_RESOLUTION",
          entityDocId,
        });
      }
      let selected;
      if (typeof merge === "function") selected = await merge(conflict.local, conflict.remote);
      else if (merge && typeof merge === "object") selected = merge;
      else if (winner === "remote" || winner === "incoming") selected = conflict.remote;
      else selected = conflict.local;
      if (!selected) throw new TypeError("The selected conflict version is empty.");
      const prepared = this._prepareUserDocument(selected, entityDocId, { requireVersion: false });
      const maximumCounter = Math.max(
        Number(conflict.localVersion?.counter) || 0,
        Number(conflict.remoteVersion?.counter) || 0,
        Number(current?.version?.counter) || 0,
        Number(conflict.serverVersion?.counter) || 0,
      );
      prepared.deviceId = this.deviceId;
      // The desktop server accepts a resolution only when it is based on the
      // version the server kept. For a rejected phone push that version is the
      // conflict's `currentVersion`, not the phone's current local version.
      prepared.baseVersion = conflict.serverVersion ?? current?.version ?? null;
      prepared.version = { counter: maximumCounter + 1, deviceId: this.deviceId };
      prepared.updatedAt = this.now();
      if (!current) prepared.createdAt = prepared.createdAt || prepared.updatedAt;
      assertDocument(prepared);
      const putResult = await this.db.put({ ...prepared, ...(current?._rev ? { _rev: current._rev } : {}) });
      const stored = { ...prepared, _rev: putResult.rev };
      await this._recordChange(stored, "conflict-resolution", { resolvesConflictId: conflict._id });
      await this.db.put({
        ...conflict,
        status: "resolved",
        resolution: winner,
        resolutionVersion: prepared.version,
        resolvedAt: this.now(),
        updatedAt: this.now(),
      });
      return publicDocument(stored);
    }

    const entityDocId = String(conflictId).includes(":")
      ? String(conflictId)
      : documentId(DOCUMENT_TYPES.NODE, normalizeEntityId(conflictId));
    const current = await this.db.get(entityDocId, { conflicts: true, attachments: true, binary: false });
    const losingRevisions = current._conflicts || [];
    if (!losingRevisions.length) throw new WikiConflictError("No PouchDB conflict exists for this document.");
    let selected = current;
    if (typeof merge === "function") selected = await merge(current, await Promise.all(
      losingRevisions.map((revision) => this.db.get(entityDocId, { rev: revision, attachments: true, binary: false })),
    ));
    else if (merge && typeof merge === "object") selected = merge;
    else if (typeof winner === "string" && winner !== "local" && winner !== current._rev) {
      selected = await this.db.get(entityDocId, { rev: winner, attachments: true, binary: false });
    }
    const prepared = this._prepareUserDocument(selected, entityDocId, { requireVersion: false });
    prepared.baseVersion = current.version || null;
    prepared.version = nextVersion(current, this.deviceId);
    prepared.deviceId = this.deviceId;
    prepared.updatedAt = this.now();
    assertDocument(prepared);
    const putResult = await this.db.put({ ...prepared, _rev: current._rev });
    for (const revision of losingRevisions) {
      try {
        await this.db.remove(entityDocId, revision);
      } catch (error) {
        if (!isNotFound(error) && !isPouchConflict(error)) throw error;
      }
    }
    const stored = { ...prepared, _id: entityDocId, _rev: putResult.rev };
    await this._recordChange(stored, "conflict-resolution");
    return publicDocument(stored);
  }

  async restoreRevision(revisionId, { reason = "Before revision restore" } = {}) {
    const revision = await this._getRaw(DOCUMENT_TYPES.REVISION, revisionId);
    const snapshot = revision.snapshot;
    if (!snapshot?.node || !Array.isArray(snapshot.blocks)) throw new TypeError("Revision snapshot is incomplete.");
    await this.saveRevision(revision.nodeId, { reason });
    const node = await this.updateNode(revision.nodeId, {
      parentId: snapshot.node.parentId,
      title: snapshot.node.title,
      summary: snapshot.node.summary,
      kind: snapshot.node.kind,
      status: snapshot.node.status,
      orderKey: snapshot.node.orderKey,
      tags: snapshot.node.tags,
      properties: snapshot.node.properties,
      deletedAt: snapshot.node.deletedAt,
    });
    const currentBlocks = await this.listBlocks(revision.nodeId, { includeDeleted: true });
    const currentIds = new Set(currentBlocks.map((block) => block.id));
    const snapshotIds = new Set(snapshot.blocks.map((block) => block.id));
    for (const block of snapshot.blocks) {
      if (currentIds.has(block.id)) {
        await this.updateBlock(block.id, {
          type: block.type,
          data: block.data,
          orderKey: block.orderKey,
          deletedAt: block.deletedAt,
        });
      } else {
        await this.createBlock(revision.nodeId, block);
      }
    }
    for (const block of currentBlocks) {
      if (!snapshotIds.has(block.id) && !block.deletedAt) await this.deleteBlock(block.id);
    }
    return node;
  }

  async exportData({ includeDeleted = true, includeRevisions = true, includeConflicts = true } = {}) {
    await this._ready();
    const prefixes = [DOCUMENT_PREFIXES.node, DOCUMENT_PREFIXES.block, DOCUMENT_PREFIXES.asset];
    if (includeRevisions) prefixes.push(DOCUMENT_PREFIXES.revision, DOCUMENT_PREFIXES.tombstone);
    if (includeConflicts) prefixes.push(DOCUMENT_PREFIXES.conflict);
    const groups = await Promise.all(prefixes.map((prefix) => this._allRaw(prefix, {
      attachments: true,
      binary: false,
    })));
    const documents = groups.flat()
      .filter((document) => includeDeleted || !document.deletedAt)
      .map((document) => ({
        ...stripPouchMetadata(document),
        _id: document._id,
      }))
      .sort((left, right) => left._id.localeCompare(right._id));
    const serialized = JSON.stringify(documents);
    const integrity = globalThis.crypto?.subtle?.digest && typeof TextEncoder !== "undefined"
      ? { algorithm: "SHA-256", digest: await sha256Hex(new TextEncoder().encode(serialized)) }
      : null;
    return {
      format: "title-placeholder-wiki-backup",
      formatVersion: 1,
      schemaVersion: 1,
      exportedAt: this.now(),
      deviceId: this.deviceId,
      documentCount: documents.length,
      integrity,
      documents,
    };
  }

  async importData(payload, { mode = "merge", strategy } = {}) {
    await this._ready();
    const selectedMode = strategy || mode;
    if (!["merge", "replace", "keep-local"].includes(selectedMode)) {
      throw new TypeError("Import mode must be merge, replace, or keep-local.");
    }
    let backup;
    try {
      backup = typeof payload === "string" ? JSON.parse(payload) : payload;
    } catch (error) {
      throw new WikiRepositoryError("Backup JSON is malformed.", {
        code: "INVALID_BACKUP_JSON",
        cause: error,
      });
    }
    if (
      !backup
      || backup.format !== "title-placeholder-wiki-backup"
      || backup.formatVersion !== 1
      || !Array.isArray(backup.documents)
    ) {
      throw new WikiRepositoryError("Unsupported or incomplete backup format.", {
        code: "INVALID_BACKUP_FORMAT",
      });
    }
    if (backup.integrity?.algorithm === "SHA-256") {
      const calculated = await sha256Hex(new TextEncoder().encode(JSON.stringify(backup.documents)));
      if (calculated !== backup.integrity.digest) {
        throw new WikiRepositoryError("Backup integrity verification failed.", {
          code: "BACKUP_INTEGRITY_ERROR",
        });
      }
    }

    // Validate and sanitize every entry before the first write. This prevents
    // a corrupt item near the end of an archive from producing a half-import.
    const deduplicated = new Map();
    const duplicateIds = [];
    for (const raw of backup.documents) {
      let candidate;
      if (raw?.docType === "conflict" || String(raw?._id || "").startsWith(DOCUMENT_PREFIXES.conflict)) {
        candidate = cloneJson(raw);
        if (!String(candidate._id || "").startsWith(DOCUMENT_PREFIXES.conflict)) {
          throw new TypeError("Imported conflict document has an invalid ID.");
        }
      } else {
        candidate = this._prepareUserDocument(raw, raw?._id, { requireVersion: true });
      }
      const existingCandidate = deduplicated.get(candidate._id);
      if (existingCandidate) {
        duplicateIds.push(candidate._id);
        if (compareUpdatedAt(candidate, existingCandidate) > 0) deduplicated.set(candidate._id, candidate);
      } else {
        deduplicated.set(candidate._id, candidate);
      }
    }

    const writes = [];
    const appliedDocuments = [];
    const report = {
      mode: selectedMode,
      imported: 0,
      replaced: 0,
      skipped: 0,
      conflicts: 0,
      duplicateIds: Array.from(new Set(duplicateIds)),
      conflictIds: [],
    };
    for (const candidate of deduplicated.values()) {
      let local = null;
      try {
        local = await this.db.get(candidate._id, { attachments: true, binary: false });
      } catch (error) {
        if (!isNotFound(error)) throw error;
      }
      if (!local) {
        writes.push(candidate);
        if (candidate.docType !== "conflict") appliedDocuments.push(candidate);
        report.imported += 1;
        continue;
      }
      if (documentsEqual(local, candidate)) {
        report.skipped += 1;
        continue;
      }
      if (candidate.docType === "conflict") {
        report.skipped += 1;
        continue;
      }
      if (!MUTABLE_TYPES.has(candidate.docType)) {
        // Revision and tombstone IDs are append-only facts. Even explicit
        // replace mode must not rewrite history; retain both payloads in an
        // inspectable conflict record instead.
        const immutableConflict = this._makeConflictDocument({
          entityDocId: candidate._id,
          local,
          remote: candidate,
          source: "import",
          reason: "immutable-id-collision",
        });
        writes.push(immutableConflict);
        report.conflicts += 1;
        report.conflictIds.push(immutableConflict._id);
        continue;
      }
      if (selectedMode === "keep-local") {
        report.skipped += 1;
        continue;
      }

      const canFastForward = sameVersion(local.version, candidate.baseVersion);
      const localIsDescendant = sameVersion(local.baseVersion, candidate.version);
      if (selectedMode === "merge" && localIsDescendant) {
        report.skipped += 1;
        continue;
      }
      if (selectedMode === "merge" && !canFastForward) {
        const conflict = this._makeConflictDocument({
          entityDocId: candidate._id,
          local,
          remote: candidate,
          source: "import",
          reason: compareUpdatedAt(local, candidate) >= 0
            ? "newer-local-document"
            : "concurrent-import",
        });
        writes.push(conflict);
        report.conflicts += 1;
        report.conflictIds.push(conflict._id);
        continue;
      }

      if (selectedMode === "replace") {
        const safetyConflict = this._makeConflictDocument({
          entityDocId: candidate._id,
          local,
          remote: candidate,
          source: "import",
          reason: "explicit-replace-safety-copy",
        });
        writes.push(safetyConflict);
        report.conflicts += 1;
        report.conflictIds.push(safetyConflict._id);
      }
      const replacement = { ...candidate, _rev: local._rev };
      writes.push(replacement);
      appliedDocuments.push(replacement);
      report.replaced += 1;
    }

    if (writes.length) {
      if (typeof this.db.bulkDocs === "function") {
        const results = await this.db.bulkDocs(writes);
        const failures = (results || []).filter((item) => item?.error);
        if (failures.length) {
          throw new WikiRepositoryError("Import was interrupted by concurrent database changes.", {
            code: "IMPORT_WRITE_CONFLICT",
            status: 409,
            details: { failures },
          });
        }
      } else {
        for (const write of writes) await this.db.put(write);
      }
      for (const document of appliedDocuments) {
        await this._recordChange(document, "import");
      }
    }
    return report;
  }
}

export function createWikiRepository(db, options) {
  return new WikiRepository(db, options);
}

export { documentId as toDocumentId, publicDocument as toPublicDocument };

export default WikiRepository;
