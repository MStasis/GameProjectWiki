import { describe, expect, it, vi } from "vitest";

import { SyncController } from "../src/lib/syncController.js";

class Emitter {
  constructor() {
    this.listeners = new Map();
    this.cancel = vi.fn();
  }

  on(event, listener) {
    const listeners = this.listeners.get(event) || [];
    listeners.push(listener);
    this.listeners.set(event, listeners);
    return this;
  }

  off(event, listener) {
    this.listeners.set(event, (this.listeners.get(event) || []).filter((item) => item !== listener));
  }

  emit(event, value) {
    for (const listener of this.listeners.get(event) || []) listener(value);
  }
}

describe("SyncController", () => {
  it("starts bidirectional live/retry PouchDB replication and reports status", () => {
    const handle = new Emitter();
    const local = { sync: vi.fn(() => handle) };
    const controller = new SyncController(local, "https://example.invalid/wiki");
    const states = [];
    controller.subscribe((status) => states.push(status.state));
    controller.start();

    expect(local.sync).toHaveBeenCalledWith("https://example.invalid/wiki", {
      live: true,
      retry: true,
    });
    handle.emit("active");
    handle.emit("change", { direction: "push" });
    expect(controller.status.state).toBe("active");
    expect(controller.status.direction).toBe("push");
    handle.emit("paused");
    expect(controller.status.state).toBe("paused");

    controller.stop();
    expect(handle.cancel).toHaveBeenCalledOnce();
    expect(controller.status.state).toBe("stopped");
    expect(states).toContain("connecting");
  });

  it("pulls from the old checkpoint after a concurrent local push", async () => {
    const pending = [{ changeId: "outbox:1", entityId: "node:1", document: { title: "local" } }];
    const repository = {
      getPendingChanges: vi.fn(async () => pending),
      acknowledgeChanges: vi.fn(async () => 1),
      applyRemoteChanges: vi.fn(async () => ({ applied: 1, conflicts: 0 })),
    };
    const transport = {
      // Server sequence 8 contains an older phone edit; our push becomes 9.
      push: vi.fn(async () => ({ accepted: ["outbox:1"], checkpoint: 9 })),
      pull: vi.fn(async (checkpoint) => ({
        checkpoint: 9,
        changes: [{ sequence: 8, kind: "document", entityId: "node:remote", document: {} }],
      })),
    };
    const controller = new SyncController(repository, transport, {
      checkpoint: 7,
      live: false,
    });

    const result = await controller.syncOnce();

    expect(transport.pull).toHaveBeenCalledWith(7, { signal: undefined });
    expect(repository.applyRemoteChanges).toHaveBeenCalledWith(
      expect.arrayContaining([expect.objectContaining({ sequence: 8 })]),
      { source: "transport" },
    );
    expect(result.checkpoint).toBe(9);
    expect(result.pushed).toBe(1);
    expect(result.pulled).toBe(1);
  });

  it("uses repository transport methods and preserves conflict counts", async () => {
    const repository = {
      getPendingChanges: vi.fn(async () => []),
      acknowledgeChanges: vi.fn(),
      applyRemoteChanges: vi.fn(async () => ({ applied: 0, conflicts: 1 })),
    };
    const transport = {
      push: vi.fn(),
      pull: vi.fn(async () => ({
        checkpoint: 1,
        changes: [{ kind: "conflict", entityId: "node:x", conflict: {} }],
      })),
    };
    const controller = new SyncController(repository, transport, { live: false });
    const result = await controller.syncOnce();
    expect(result).toMatchObject({ pushed: 0, pulled: 0, conflicts: 1, checkpoint: 1 });
    expect(transport.push).not.toHaveBeenCalled();
  });
});
