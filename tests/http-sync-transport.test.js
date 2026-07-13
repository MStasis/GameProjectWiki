import { describe, expect, it, vi } from "vitest";

import { HttpSyncTransport, SyncTransportError } from "../src/lib/httpSyncTransport.js";

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("HttpSyncTransport", () => {
  it("requires HTTPS except for the desktop loopback server", () => {
    expect(() => new HttpSyncTransport({
      baseUrl: "http://example.com",
      username: "user",
      password: "secret",
      fetchImpl: vi.fn(),
    })).toThrow(SyncTransportError);

    expect(() => new HttpSyncTransport({
      baseUrl: "http://127.0.0.1:8765",
      username: "user",
      password: "secret",
      fetchImpl: vi.fn(),
    })).not.toThrow();
  });

  it("authenticates pushes and acknowledges server conflicts without advancing the pull cursor", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({
      accepted: ["change:accepted"],
      duplicates: ["change:duplicate"],
      conflicts: [{ incomingChangeId: "change:conflict" }],
      checkpoint: 42,
    }));
    const transport = new HttpSyncTransport({
      baseUrl: "https://desktop.example.ts.net/",
      username: "wiki-sync",
      password: "secret",
      fetchImpl,
    });

    const result = await transport.push([{ changeId: "change:accepted" }]);
    expect(result.acknowledgedIds).toEqual([
      "change:accepted",
      "change:duplicate",
      "change:conflict",
    ]);
    expect(result.serverCheckpoint).toBe(42);
    const [url, request] = fetchImpl.mock.calls[0];
    expect(url).toBe("https://desktop.example.ts.net/api/sync/push");
    expect(request.headers.Authorization).toBe(`Basic ${btoa("wiki-sync:secret")}`);
    expect(JSON.parse(request.body).changes).toHaveLength(1);
  });

  it("sends the existing pull checkpoint and reports authentication errors clearly", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ checkpoint: 8, changes: [] }))
      .mockResolvedValueOnce(jsonResponse({ error: "authentication_required" }, 401));
    const transport = new HttpSyncTransport({
      baseUrl: "https://desktop.example.ts.net",
      username: "wiki-sync",
      password: "wrong",
      fetchImpl,
    });

    await expect(transport.pull(7)).resolves.toMatchObject({ checkpoint: 8 });
    expect(JSON.parse(fetchImpl.mock.calls[0][1].body)).toMatchObject({ checkpoint: 7 });
    await expect(transport.status()).rejects.toMatchObject({
      status: 401,
      code: "authentication_required",
    });
  });
});
