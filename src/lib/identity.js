const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Create a standards-compliant random UUID without importing Node-only code.
 * Modern browsers, Electron renderers, Capacitor WebViews, and recent Node
 * versions all expose Web Crypto through globalThis.crypto.
 */
export function createUuid(cryptoSource = globalThis.crypto) {
  if (typeof cryptoSource?.randomUUID === "function") {
    return cryptoSource.randomUUID();
  }

  if (typeof cryptoSource?.getRandomValues !== "function") {
    throw new Error("A Web Crypto implementation is required to create IDs.");
  }

  const bytes = new Uint8Array(16);
  cryptoSource.getRandomValues(bytes);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0"));
  return [
    hex.slice(0, 4).join(""),
    hex.slice(4, 6).join(""),
    hex.slice(6, 8).join(""),
    hex.slice(8, 10).join(""),
    hex.slice(10, 16).join(""),
  ].join("-");
}

export const uuid = createUuid;

export function isUuid(value) {
  return typeof value === "string" && UUID_PATTERN.test(value);
}

export function assertUuid(value, label = "ID") {
  if (!isUuid(value)) {
    throw new TypeError(`${label} must be a valid UUID.`);
  }
  return value.toLowerCase();
}

export function createDeviceId(cryptoSource = globalThis.crypto) {
  return createUuid(cryptoSource);
}

function isoNow(clock) {
  const value = typeof clock === "function" ? clock() : new Date();
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new TypeError("The clock must return a Date or a valid date value.");
  }
  return date.toISOString();
}

function defaultDeviceName() {
  const platform = globalThis.navigator?.userAgentData?.platform
    || globalThis.navigator?.platform
    || "Personal device";
  return String(platform).replace(/[\u0000-\u001f\u007f]/g, "").slice(0, 80) || "Personal device";
}

function isNotFound(error) {
  return error?.status === 404 || error?.name === "not_found" || error?.error === "not_found";
}

function isConflict(error) {
  return error?.status === 409 || error?.name === "conflict" || error?.error === "conflict";
}

/**
 * Read or atomically create the local-only device settings document.
 * `_local/*` documents are intentionally never replicated by PouchDB.
 */
export async function getOrCreateDeviceSettings(db, options = {}) {
  if (!db || typeof db.get !== "function" || typeof db.put !== "function") {
    throw new TypeError("A PouchDB-compatible database is required.");
  }

  const {
    idFactory = createDeviceId,
    clock = () => new Date(),
    name = defaultDeviceName(),
    maxRetries = 5,
  } = options;

  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    try {
      const existing = await db.get("_local/device");
      if (isUuid(existing.deviceId)) {
        return existing;
      }
      const updated = {
        ...existing,
        deviceId: assertUuid(idFactory(), "Generated device ID"),
        name: String(existing.name || name).slice(0, 80),
        schemaVersion: 1,
        updatedAt: isoNow(clock),
      };
      const result = await db.put(updated);
      return { ...updated, _rev: result.rev || updated._rev };
    } catch (error) {
      if (!isNotFound(error)) {
        if (isConflict(error) && attempt < maxRetries) continue;
        throw error;
      }

      const timestamp = isoNow(clock);
      const created = {
        _id: "_local/device",
        deviceId: assertUuid(idFactory(), "Generated device ID"),
        name: String(name || "Personal device")
          .replace(/[\u0000-\u001f\u007f]/g, "")
          .slice(0, 80),
        schemaVersion: 1,
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      try {
        const result = await db.put(created);
        return { ...created, _rev: result.rev || created._rev };
      } catch (putError) {
        if (isConflict(putError) && attempt < maxRetries) continue;
        throw putError;
      }
    }
  }

  throw new Error("Could not initialize device settings after repeated conflicts.");
}

export async function updateDeviceSettings(db, patch, options = {}) {
  const { clock = () => new Date(), maxRetries = 5 } = options;
  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    const current = await getOrCreateDeviceSettings(db, options);
    const next = {
      ...current,
      ...patch,
      _id: "_local/device",
      deviceId: current.deviceId,
      name: String(patch?.name ?? current.name).replace(/[\u0000-\u001f\u007f]/g, "").slice(0, 80),
      updatedAt: isoNow(clock),
    };
    try {
      const result = await db.put(next);
      return { ...next, _rev: result.rev || next._rev };
    } catch (error) {
      if (isConflict(error) && attempt < maxRetries) continue;
      throw error;
    }
  }
  throw new Error("Could not update device settings after repeated conflicts.");
}

export { UUID_PATTERN };
