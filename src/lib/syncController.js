const DEFAULT_POLL_INTERVAL = 5_000;

function serializeError(error) {
  if (!error) return null;
  return {
    name: String(error.name || "Error"),
    message: String(error.message || error.reason || error),
    status: Number.isFinite(error.status) ? error.status : undefined,
  };
}

function isTransport(value) {
  return value && typeof value.push === "function" && typeof value.pull === "function";
}

function addEmitterListener(emitter, event, listener, removers) {
  if (!emitter || typeof emitter.on !== "function") return;
  emitter.on(event, listener);
  removers.push(() => {
    if (typeof emitter.off === "function") emitter.off(event, listener);
    else if (typeof emitter.removeListener === "function") emitter.removeListener(event, listener);
  });
}

function abortableDelay(milliseconds, signal) {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve(false);
    const timer = setTimeout(() => resolve(true), milliseconds);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      resolve(false);
    }, { once: true });
  });
}

/**
 * Runs either native PouchDB replication or app-level transport sync.
 *
 * Native mode:
 *   new SyncController(localDb, remotePouchDb).start()
 *
 * Transport mode:
 *   new SyncController(repository, { push, pull }).start()
 * The transport's push receives repository outbox entries. pull receives the
 * latest checkpoint and returns `{ changes, checkpoint }` (an array is also
 * accepted). Concurrent documents are delegated to applyRemoteChanges(),
 * which records rather than overwrites conflicts.
 */
export class SyncController {
  constructor(local, remote, options = {}) {
    if (!local) throw new TypeError("A local database or WikiRepository is required.");
    if (!remote) throw new TypeError("A remote PouchDB database or sync transport is required.");

    this.local = local;
    this.remote = remote;
    this.options = options;
    this._listeners = new Set();
    this._handle = null;
    this._secondaryHandles = [];
    this._removers = [];
    this._abortController = null;
    this._loopPromise = null;
    this._checkpoint = options.checkpoint ?? null;
    this._status = Object.freeze({
      state: "idle",
      running: false,
      direction: null,
      lastChangedAt: null,
      lastSyncedAt: null,
      error: null,
    });
  }

  get status() {
    return this._status;
  }

  get running() {
    return this._status.running;
  }

  subscribe(listener) {
    if (typeof listener !== "function") throw new TypeError("Listener must be a function.");
    this._listeners.add(listener);
    listener(this._status);
    return () => this._listeners.delete(listener);
  }

  _setStatus(patch) {
    this._status = Object.freeze({ ...this._status, ...patch });
    for (const listener of this._listeners) {
      try {
        listener(this._status);
      } catch {
        // A view listener must never be allowed to terminate replication.
      }
    }
  }

  start() {
    if (this.running) return this;
    this._setStatus({ state: "connecting", running: true, error: null });

    if (isTransport(this.remote)) {
      this._startTransport();
    } else {
      this._startNative();
    }
    return this;
  }

  _startNative() {
    const db = this.local?.db && typeof this.local.db.get === "function" ? this.local.db : this.local;
    const replicationOptions = {
      live: true,
      retry: true,
      ...(this.options.syncOptions || {}),
    };

    if (typeof db.sync === "function") {
      this._handle = db.sync(this.remote, replicationOptions);
      this._bindNativeHandle(this._handle);
      return;
    }

    if (typeof db.replicate?.to !== "function" || typeof db.replicate?.from !== "function") {
      this._setStatus({
        state: "error",
        running: false,
        error: serializeError(new TypeError("The database does not expose PouchDB replication APIs.")),
      });
      return;
    }

    const push = db.replicate.to(this.remote, replicationOptions);
    const pull = db.replicate.from(this.remote, replicationOptions);
    this._handle = push;
    this._secondaryHandles = [pull];
    this._bindNativeHandle(push, "push");
    this._bindNativeHandle(pull, "pull");
  }

  _bindNativeHandle(handle, fixedDirection = null) {
    addEmitterListener(handle, "active", () => {
      this._setStatus({ state: "active", direction: fixedDirection, error: null });
    }, this._removers);
    addEmitterListener(handle, "change", (info = {}) => {
      const direction = fixedDirection || info.direction || null;
      this._setStatus({
        state: "active",
        direction,
        lastChangedAt: new Date().toISOString(),
        error: null,
      });
    }, this._removers);
    addEmitterListener(handle, "paused", (error) => {
      this._setStatus({
        state: "paused",
        direction: null,
        lastSyncedAt: error ? this._status.lastSyncedAt : new Date().toISOString(),
        error: serializeError(error),
      });
    }, this._removers);
    addEmitterListener(handle, "denied", (error) => {
      this._setStatus({ state: "error", direction: fixedDirection, error: serializeError(error) });
    }, this._removers);
    addEmitterListener(handle, "error", (error) => {
      this._setStatus({ state: "error", direction: fixedDirection, error: serializeError(error) });
    }, this._removers);
    addEmitterListener(handle, "complete", () => {
      if (this.running) {
        this._setStatus({ state: "paused", direction: null, lastSyncedAt: new Date().toISOString() });
      }
    }, this._removers);
  }

  _startTransport() {
    const repository = this.local;
    if (
      typeof repository.getPendingChanges !== "function"
      || typeof repository.acknowledgeChanges !== "function"
      || typeof repository.applyRemoteChanges !== "function"
    ) {
      this._setStatus({
        state: "error",
        running: false,
        error: serializeError(new TypeError("Transport sync requires a WikiRepository-compatible local value.")),
      });
      return;
    }

    this._abortController = new AbortController();
    this._loopPromise = this._runTransportLoop(this._abortController.signal);
  }

  async _runTransportLoop(signal) {
    const interval = Math.max(250, Number(this.options.pollInterval || DEFAULT_POLL_INTERVAL));
    const retryBase = Math.max(250, Number(this.options.retryDelay || 1_000));
    let failures = 0;

    while (!signal.aborted) {
      try {
        const result = await this.syncOnce({ signal });
        failures = 0;
        if (!signal.aborted) this._setStatus({ state: "paused", direction: null, error: null });
        if (this.options.live === false) break;
        if (!result.hasMore && !await abortableDelay(interval, signal)) break;
      } catch (error) {
        if (signal.aborted) break;
        failures += 1;
        this._setStatus({ state: "error", direction: null, error: serializeError(error) });
        if (this.options.retry === false) break;
        const backoff = Math.min(30_000, retryBase * (2 ** Math.min(failures - 1, 5)));
        if (!await abortableDelay(backoff, signal)) break;
      }
    }

    if (!signal.aborted && this.running && this.options.live === false) {
      this._setStatus({ state: "paused", running: false, direction: null });
    }
  }

  async syncOnce({ signal } = {}) {
    if (!isTransport(this.remote)) {
      throw new TypeError("syncOnce is available for push/pull transports only.");
    }
    if (signal?.aborted) return { pushed: 0, pulled: 0, conflicts: 0, checkpoint: this._checkpoint };

    const repository = this.local;
    this._setStatus({ state: "active", running: true, direction: "push", error: null });
    const pending = await repository.getPendingChanges({
      // Attachments are base64-encoded in JSON. Three maximum-size (10 MiB)
      // images stay comfortably below the desktop server's 64 MiB request cap.
      limit: this.options.batchSize || 3,
      includeAttachments: true,
    });
    let pushed = 0;
    if (pending.length) {
      const pushResult = await this.remote.push(pending, {
        checkpoint: this._checkpoint,
        signal,
      });
      const serverConflictIds = Array.isArray(pushResult?.conflicts)
        ? pushResult.conflicts
            .map((conflict) => conflict?.incomingChangeId || conflict?.changeId || conflict?.id)
            .filter(Boolean)
        : [];
      const protocolAcknowledgements = [
        ...(Array.isArray(pushResult?.accepted) ? pushResult.accepted : []),
        ...(Array.isArray(pushResult?.duplicates) ? pushResult.duplicates : []),
        ...serverConflictIds,
      ];
      const acknowledged = pushResult?.acknowledgedIds
        || pushResult?.acknowledged
        || (protocolAcknowledgements.length
          ? protocolAcknowledgements
          : pending.map((entry) => entry.changeId || entry.id));
      await repository.acknowledgeChanges(acknowledged);
      pushed = acknowledged.length;
      // A push checkpoint describes server state *after* our write. Advancing
      // the pull cursor to it would skip changes another device wrote before
      // this push, so only a pull response may advance `_checkpoint`.
    }

    if (signal?.aborted) return { pushed, pulled: 0, conflicts: 0, checkpoint: this._checkpoint };
    this._setStatus({ state: "active", direction: "pull" });
    const pullResult = await this.remote.pull(this._checkpoint, { signal });
    const changes = Array.isArray(pullResult) ? pullResult : (pullResult?.changes || []);
    const application = await repository.applyRemoteChanges(changes, {
      source: this.options.source || "transport",
    });
    if (!Array.isArray(pullResult) && pullResult?.checkpoint !== undefined) {
      this._checkpoint = pullResult.checkpoint;
    }

    const result = {
      pushed,
      pulled: application.applied || 0,
      conflicts: application.conflicts || 0,
      checkpoint: this._checkpoint,
      hasMore: Boolean(pullResult?.hasMore)
        || pending.length >= (this.options.batchSize || 3),
    };
    this._setStatus({
      state: "paused",
      direction: null,
      lastChangedAt: (pushed || changes.length) ? new Date().toISOString() : this._status.lastChangedAt,
      lastSyncedAt: new Date().toISOString(),
      error: null,
    });
    return result;
  }

  stop() {
    if (this._abortController) this._abortController.abort();
    this._abortController = null;
    for (const remove of this._removers.splice(0)) remove();
    const handles = [this._handle, ...this._secondaryHandles].filter(Boolean);
    for (const handle of handles) {
      try {
        handle.cancel?.();
      } catch {
        // Cancellation is best effort; status still becomes stopped.
      }
    }
    this._handle = null;
    this._secondaryHandles = [];
    this._setStatus({ state: "stopped", running: false, direction: null });
    return this;
  }
}

export function createSyncController(local, remote, options) {
  return new SyncController(local, remote, options);
}

export default SyncController;
