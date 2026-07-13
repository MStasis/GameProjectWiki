const fs = require("node:fs/promises");
const crypto = require("node:crypto");
const path = require("node:path");
const zlib = require("node:zlib");
const { promisify } = require("node:util");

const gzip = promisify(zlib.gzip);

function timestamp(date = new Date()) {
  return date.toISOString().replace(/[:.]/g, "-");
}

async function createBackup(store, backupDirectory, reason = "manual") {
  await fs.mkdir(backupDirectory, { recursive: true });
  const documents = (typeof store.exportDocuments === "function"
    ? store.exportDocuments()
    : Object.values(store.exportState().documents || {}).map((record) => record?.document))
    .filter((document) => document && typeof document === "object")
    .sort((left, right) => String(left._id || "").localeCompare(String(right._id || "")));
  const serializedDocuments = JSON.stringify(documents);
  const payload = {
    format: "title-placeholder-wiki-backup",
    formatVersion: 1,
    schemaVersion: 1,
    reason,
    exportedAt: new Date().toISOString(),
    deviceId: "desktop-sync-host",
    documentCount: documents.length,
    integrity: {
      algorithm: "SHA-256",
      digest: crypto.createHash("sha256").update(serializedDocuments).digest("hex")
    },
    documents
  };
  const filePath = path.join(backupDirectory, `wiki-${timestamp()}.wiki-backup.json.gz`);
  await fs.writeFile(filePath, await gzip(Buffer.from(JSON.stringify(payload))), { mode: 0o600 });
  return filePath;
}

async function pruneBackups(backupDirectory, keep = 30) {
  let entries;
  try {
    entries = await fs.readdir(backupDirectory, { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
  const files = await Promise.all(
    entries
      .filter((entry) => entry.isFile() && /^wiki-.*\.wiki-backup\.json\.gz$/.test(entry.name))
      .map(async (entry) => ({
        path: path.join(backupDirectory, entry.name),
        stat: await fs.stat(path.join(backupDirectory, entry.name))
      }))
  );
  files.sort((left, right) => right.stat.mtimeMs - left.stat.mtimeMs);
  const removed = [];
  for (const file of files.slice(keep)) {
    await fs.unlink(file.path);
    removed.push(file.path);
  }
  return removed;
}

module.exports = { createBackup, pruneBackups, timestamp };
