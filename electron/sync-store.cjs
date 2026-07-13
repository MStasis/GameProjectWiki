const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const path = require("node:path");

const STORE_SCHEMA_VERSION = 1;
const MAX_CHANGE_COUNT = 500;
const MAX_DOCUMENT_BYTES = 24 * 1024 * 1024;

function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function safeId(value, label = "id") {
  if (typeof value !== "string" || !value || value.length > 300) {
    throw new Error(`${label} is invalid`);
  }
  if (/[^a-zA-Z0-9:_\-.]/.test(value) || ["__proto__", "prototype", "constructor"].includes(value)) {
    throw new Error(`${label} contains unsupported characters`);
  }
  return value;
}

function normalizeVersion(value) {
  if (value == null) return null;
  const counter = Number(value.counter);
  const deviceId = safeId(String(value.deviceId || ""), "version.deviceId");
  if (!Number.isSafeInteger(counter) || counter < 0) {
    throw new Error("version.counter is invalid");
  }
  return { counter, deviceId };
}

function sameVersion(left, right) {
  if (left == null || right == null) return left == null && right == null;
  return Number(left.counter) === Number(right.counter) && left.deviceId === right.deviceId;
}

function stableHash(value) {
  return crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function stripPouchMetadata(document) {
  const result = clone(document || {});
  delete result._rev;
  delete result._revisions;
  delete result._revs_info;
  delete result._conflicts;
  delete result._local_seq;
  return result;
}

function stripAttachments(document) {
  const result = clone(document || {});
  delete result._attachments;
  return result;
}

function normalizeChange(raw) {
  if (!raw || typeof raw !== "object") throw new Error("change must be an object");
  const changeId = safeId(String(raw.changeId || raw.id || raw._id || ""), "changeId");
  const document = stripPouchMetadata(raw.document || raw.doc || {});
  if (!document || typeof document !== "object" || Array.isArray(document)) {
    throw new Error("document must be an object");
  }
  const entityId = safeId(String(raw.entityId || document._id || ""), "entityId");
  document._id = entityId;
  const baseVersion = normalizeVersion(raw.baseVersion ?? document.baseVersion ?? null);
  const version = normalizeVersion(raw.version ?? document.version);
  if (version == null) throw new Error("version is required");
  document.baseVersion = clone(baseVersion);
  document.version = clone(version);
  const serializedBytes = Buffer.byteLength(JSON.stringify(document));
  if (serializedBytes > MAX_DOCUMENT_BYTES) throw new Error("document is too large to sync");
  return {
    changeId,
    entityId,
    deviceId: safeId(String(raw.deviceId || version.deviceId), "deviceId"),
    baseVersion,
    version,
    resolvesConflictId: raw.resolvesConflictId
      ? safeId(String(raw.resolvesConflictId), "resolvesConflictId")
      : null,
    createdAt: typeof raw.createdAt === "string" ? raw.createdAt : new Date().toISOString(),
    document
  };
}

function emptyState() {
  return {
    schemaVersion: STORE_SCHEMA_VERSION,
    sequence: 0,
    documents: {},
    changes: [],
    conflicts: {},
    seenChangeIds: {}
  };
}

class SyncStore {
  constructor(directory) {
    this.directory = directory;
    this.statePath = path.join(directory, "sync-state.json");
    this.state = emptyState();
    this.writeQueue = Promise.resolve();
  }

  async init() {
    await fs.mkdir(this.directory, { recursive: true });
    try {
      const parsed = JSON.parse(await fs.readFile(this.statePath, "utf8"));
      if (parsed.schemaVersion !== STORE_SCHEMA_VERSION) {
        throw new Error(`Unsupported sync store schema: ${parsed.schemaVersion}`);
      }
      this.state = parsed;
    } catch (error) {
      if (error.code === "ENOENT") {
        await this.persist();
        return;
      }
      if (error instanceof SyntaxError) {
        const recoveryPath = `${this.statePath}.corrupt-${Date.now()}`;
        await fs.copyFile(this.statePath, recoveryPath);
        throw new Error(`Sync data is damaged. A recovery copy was saved to ${recoveryPath}`);
      }
      throw error;
    }
  }

  async persist() {
    // A transient disk failure must not permanently poison every later save.
    // Each caller still receives its own failure, while the next save can retry.
    this.writeQueue = this.writeQueue.catch(() => undefined).then(async () => {
      const temporaryPath = `${this.statePath}.tmp`;
      await fs.writeFile(temporaryPath, JSON.stringify(this.state), { encoding: "utf8", mode: 0o600 });
      await fs.rename(temporaryPath, this.statePath);
    });
    return this.writeQueue;
  }

  getStatus() {
    return {
      schemaVersion: this.state.schemaVersion,
      sequence: this.state.sequence,
      documentCount: Object.keys(this.state.documents).length,
      conflictCount: Object.values(this.state.conflicts).filter((conflict) => !conflict.resolved).length
    };
  }

  exportState() {
    return clone({
      exportedAt: new Date().toISOString(),
      ...this.state
    });
  }

  exportDocuments() {
    return Object.values(this.state.documents)
      .map((record) => clone(record?.document))
      .filter((document) => document && typeof document === "object");
  }

  async push(rawChanges) {
    if (!Array.isArray(rawChanges)) throw new Error("changes must be an array");
    if (rawChanges.length > MAX_CHANGE_COUNT) throw new Error("too many changes in one request");

    const accepted = [];
    const duplicates = [];
    const conflicts = [];

    for (const raw of rawChanges) {
      const change = normalizeChange(raw);
      if (this.state.seenChangeIds[change.changeId]) {
        duplicates.push(change.changeId);
        continue;
      }

      const current = this.state.documents[change.entityId] || null;
      const currentVersion = current?.version ?? null;
      const incomingHash = stableHash(change.document);
      const isDuplicateDocument = current && sameVersion(currentVersion, change.version) && current.hash === incomingHash;
      const mayApply = (!current && change.baseVersion == null) || (current && sameVersion(currentVersion, change.baseVersion));

      if (isDuplicateDocument) {
        const resolvedConflict = this._markConflictResolved(change, this.state.sequence + 1);
        if (resolvedConflict) {
          this.state.sequence += 1;
          this.state.changes.push({
            sequence: this.state.sequence,
            kind: "conflict-resolution",
            entityId: change.entityId,
            conflictId: resolvedConflict._id,
            resolutionVersion: clone(change.version),
            resolvedAt: resolvedConflict.resolvedAt
          });
        }
        this.state.seenChangeIds[change.changeId] = this.state.sequence;
        duplicates.push(change.changeId);
        continue;
      }

      if (!mayApply) {
        this.state.sequence += 1;
        const conflictId = `conflict:${change.entityId}:${crypto.randomUUID()}`;
        const conflict = {
          _id: conflictId,
          type: "conflict",
          entityId: change.entityId,
          sequence: this.state.sequence,
          detectedAt: new Date().toISOString(),
          current: current ? clone(current.document) : null,
          incoming: clone(change.document),
          currentVersion: clone(currentVersion),
          incomingVersion: clone(change.version),
          incomingChangeId: change.changeId,
          resolved: false
        };
        this.state.conflicts[conflictId] = conflict;
        this.state.seenChangeIds[change.changeId] = this.state.sequence;
        this.state.changes.push({
          sequence: this.state.sequence,
          kind: "conflict",
          entityId: change.entityId,
          conflict: clone(conflict)
        });
        conflicts.push(conflict);
        continue;
      }

      this.state.sequence += 1;
      this.state.documents[change.entityId] = {
        version: clone(change.version),
        hash: incomingHash,
        document: clone(change.document),
        updatedAt: change.createdAt
      };
      this.state.seenChangeIds[change.changeId] = this.state.sequence;
      this._markConflictResolved(change, this.state.sequence);
      this.state.changes.push({
        sequence: this.state.sequence,
        kind: "document",
        changeId: change.changeId,
        entityId: change.entityId,
        version: clone(change.version),
        resolvesConflictId: change.resolvesConflictId,
        // Binary attachments already live in the current document map. Keeping
        // them in every historical event would multiply large image data in
        // sync-state.json and every automatic backup.
        document: stripAttachments(change.document)
      });
      accepted.push(change.changeId);
    }

    if (accepted.length || duplicates.length || conflicts.length) await this.persist();
    return { accepted, duplicates, conflicts, checkpoint: this.state.sequence };
  }

  _markConflictResolved(change, sequence) {
    if (!change.resolvesConflictId) return null;
    const conflict = this.state.conflicts[change.resolvesConflictId];
    if (!conflict || conflict.resolved || conflict.entityId !== change.entityId) return null;
    conflict.resolved = true;
    conflict.resolvedAt = new Date().toISOString();
    conflict.resolutionChangeId = change.changeId;
    conflict.resolutionVersion = clone(change.version);
    conflict.resolutionSequence = sequence;
    return conflict;
  }

  pull(checkpoint = 0, limit = 500) {
    const since = Number(checkpoint) || 0;
    const safeLimit = Math.min(Math.max(Number(limit) || 500, 1), 1000);
    const changes = clone(this.state.changes.filter((entry) => entry.sequence > since).slice(0, safeLimit));
    const lastDocumentIndex = new Map();
    changes.forEach((entry, index) => {
      if (entry.kind === "document") lastDocumentIndex.set(entry.entityId, index);
    });
    for (const [entityId, index] of lastDocumentIndex) {
      const attachments = this.state.documents[entityId]?.document?._attachments;
      if (attachments && changes[index]?.document) changes[index].document._attachments = clone(attachments);
    }
    const nextCheckpoint = changes.length ? changes.at(-1).sequence : this.state.sequence;
    return {
      checkpoint: nextCheckpoint,
      hasMore: this.state.changes.some((entry) => entry.sequence > nextCheckpoint),
      changes
    };
  }

  async resolveConflict(conflictId, rawChange) {
    safeId(conflictId, "conflictId");
    const conflict = this.state.conflicts[conflictId];
    if (!conflict || conflict.resolved) throw new Error("conflict not found");
    const result = await this.push([rawChange]);
    if (result.accepted.length === 0 && result.duplicates.length === 0) return result;
    conflict.resolved = true;
    conflict.resolvedAt = new Date().toISOString();
    conflict.resolutionChangeId = rawChange.changeId || rawChange.id;
    await this.persist();
    return result;
  }
}

module.exports = {
  MAX_DOCUMENT_BYTES,
  STORE_SCHEMA_VERSION,
  SyncStore,
  normalizeChange,
  normalizeVersion,
  sameVersion,
  safeId,
  stableHash,
  stripPouchMetadata
};
