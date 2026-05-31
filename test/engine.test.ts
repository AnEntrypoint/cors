import { describe, it, expect, vi } from "vitest";
import { createActor, waitFor } from "xstate";
import {
  requestMachine,
  refreshProxies,
  dedupe,
  parseProxiesJson,
  queryProxy,
  type ProxyDescriptor,
  type UpstreamSource,
} from "../src/index.js";

const TARGET = "https://example.com/data";

function proxy(id: string): ProxyDescriptor {
  return queryProxy({ id, label: id, base: `https://${id}/?url=`, caps: { methods: ["GET"], body: false, forwardsHeaders: false, requiresKey: false } });
}

function req(signal: AbortSignal | null = null) {
  return { url: TARGET, method: "GET", headers: new Headers(), body: null, signal };
}

async function runMachine(queue: ProxyDescriptor[], fetchImpl: typeof fetch, signal: AbortSignal | null = null) {
  const actor = createActor(requestMachine, {
    input: { request: req(signal), queue, timeoutMs: 5000, fetchImpl },
  });
  actor.start();
  const snap = await waitFor(actor, (s) => s.status === "done", { timeout: 20000 });
  actor.stop();
  return snap;
}

describe("requestMachine (xstate perfect-fallback engine)", () => {
  it("reaches success on the first working proxy", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response("ok"));
    const snap = await runMachine([proxy("a")], fetchImpl);
    expect(snap.value).toBe("success");
    expect(await snap.context.response!.text()).toBe("ok");
  });

  it("walks every proxy in order then lands in exhausted with all reasons", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockRejectedValue(new Error("down"));
    const snap = await runMachine([proxy("a"), proxy("b"), proxy("c")], fetchImpl);
    expect(snap.value).toBe("exhausted");
    expect(snap.context.attempts.map((a) => a.proxyId)).toEqual(["a", "b", "c"]);
  });

  it("fails over from a broken first proxy to a working second", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockRejectedValueOnce(new Error("down"))
      .mockResolvedValueOnce(new Response("second"));
    const snap = await runMachine([proxy("a"), proxy("b")], fetchImpl);
    expect(snap.value).toBe("success");
    expect(await snap.context.response!.text()).toBe("second");
  });

  it("records 429/403 as a demotion", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response("", { status: 429 }))
      .mockResolvedValueOnce(new Response("ok"));
    const snap = await runMachine([proxy("a"), proxy("b")], fetchImpl);
    expect(snap.value).toBe("success");
    expect(snap.context.demoted).toContain("a");
  });

  it("lands in cancelled when the signal is already aborted", async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response("ok"));
    const snap = await runMachine([proxy("a")], fetchImpl, ctrl.signal);
    expect(snap.value).toBe("cancelled");
  });

  it("lands in exhausted on an empty queue without hanging", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const snap = await runMachine([], fetchImpl);
    expect(snap.value).toBe("exhausted");
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("live-update (floosie pipeline)", () => {
  function jsonSource(id: string): UpstreamSource {
    return { id, url: `https://src/${id}`, parse: (raw) => parseProxiesJson(raw) };
  }

  it("merges proxies from a source and reports per-source outcome", async () => {
    const payload = JSON.stringify({ proxies: [{ id: "x", endpoint: "https://x.test/?url=" }] });
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response(payload));
    const r = await refreshProxies({ fetchImpl, sources: [jsonSource("s1")] });
    expect(r.sources[0]).toMatchObject({ id: "s1", ok: true });
    expect(r.proxies.some((p) => p.id === "x")).toBe(true);
  });

  it("never throws when every source fails; returns empty proxies", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockRejectedValue(new Error("offline"));
    const r = await refreshProxies({ fetchImpl, sources: [jsonSource("s1"), jsonSource("s2")] });
    expect(r.proxies).toEqual([]);
    expect(r.sources.every((s) => !s.ok)).toBe(true);
  });

  it("rejects non-http endpoints from an untrusted live list", async () => {
    const payload = JSON.stringify({ proxies: [{ id: "evil", endpoint: "javascript:alert(1)" }, { id: "ok", endpoint: "https://ok.test/?url=" }] });
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response(payload));
    const r = await refreshProxies({ fetchImpl, sources: [jsonSource("s1")] });
    expect(r.proxies.some((p) => p.id === "evil")).toBe(false);
    expect(r.proxies.some((p) => p.id === "ok")).toBe(true);
  });
});

describe("dedupe", () => {
  it("drops duplicates by id and by endpoint, first wins", () => {
    const a = queryProxy({ id: "a", label: "a", base: "https://h/?url=" });
    const a2 = queryProxy({ id: "a", label: "a2", base: "https://other/?url=" });
    const b = queryProxy({ id: "b", label: "b", base: "https://h/?url=" }); // same endpoint as a
    const out = dedupe([a, a2, b]);
    expect(out.map((p) => p.id)).toEqual(["a"]);
  });
});
