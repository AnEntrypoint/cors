import { describe, it, expect, vi } from "vitest";
import {
  CorsProxyClient,
  createProxiedFetch,
  builtinProxies,
  historicalProxies,
  getProxy,
  queryProxy,
  prefixProxy,
  allOriginsGet,
  AllProxiesFailedError,
  type ProxyDescriptor,
} from "../src/index.js";

const TARGET = "https://example.com/data?a=1&b=2";

function fakeResponse(body: string, init?: ResponseInit): Response {
  return new Response(body, init);
}

describe("registry", () => {
  it("registers a non-trivial set of distinct proxies", () => {
    expect(builtinProxies.length).toBeGreaterThanOrEqual(11);
    const ids = new Set(builtinProxies.map((p) => p.id));
    expect(ids.size).toBe(builtinProxies.length);
  });

  it("looks up by id", () => {
    expect(getProxy("codetabs")?.id).toBe("codetabs");
    expect(getProxy("cors-lol")?.id).toBe("cors-lol");
    expect(getProxy("nope")).toBeUndefined();
  });

  it("documents historical/defunct proxies without registering them", () => {
    expect(historicalProxies.length).toBeGreaterThanOrEqual(10);
    const liveIds = new Set(builtinProxies.map((p) => p.id));
    // none of the documented-dead ones are in the live registry
    for (const h of historicalProxies) expect(liveIds.has(h.id)).toBe(false);
  });
});

describe("descriptor factories", () => {
  const req = { url: "https://example.com/p?x=1", method: "GET", headers: new Headers(), body: null, signal: null };

  it("queryProxy URL-encodes the target onto the base", () => {
    const p = queryProxy({ id: "t", label: "t", base: "https://h/?url=" });
    expect(p.transform(req).url).toBe(`https://h/?url=${encodeURIComponent(req.url)}`);
  });

  it("prefixProxy appends the raw target to the base", () => {
    const p = prefixProxy({ id: "t", label: "t", base: "https://h/" });
    expect(p.transform(req).url).toBe(`https://h/${req.url}`);
  });
});

describe("transform: url encoding per proxy shape", () => {
  it("query-style encodes the full target including its query string", () => {
    const codetabs = getProxy("codetabs")!;
    const pr = codetabs.transform({
      url: TARGET,
      method: "GET",
      headers: new Headers(),
      body: null,
      signal: null,
    });
    expect(pr.url).toBe(
      `https://api.codetabs.com/v1/proxy/?quest=${encodeURIComponent(TARGET)}`,
    );
    // nested query must be encoded, not leaked as top-level params
    expect(pr.url).not.toContain("&b=2");
  });

  it("prefix-style appends the raw target", () => {
    const corsSh = getProxy("cors-sh")!;
    const pr = corsSh.transform({
      url: TARGET,
      method: "GET",
      headers: new Headers(),
      body: null,
      signal: null,
    });
    expect(pr.url).toBe(`https://proxy.cors.sh/${TARGET}`);
  });

  it("cors-anywhere injects X-Requested-With when absent", () => {
    const ca = getProxy("cors-anywhere-herokuapp")!;
    const pr = ca.transform({
      url: TARGET,
      method: "GET",
      headers: new Headers(),
      body: null,
      signal: null,
    });
    expect(new Headers(pr.init.headers).get("x-requested-with")).toBe("XMLHttpRequest");
  });
});

describe("untransform: wrapped allorigins response", () => {
  it("rebuilds a real Response from { contents, status }", async () => {
    const wrapped = fakeResponse(
      JSON.stringify({ contents: "hello", status: { http_code: 201, content_type: "text/plain" } }),
    );
    const real = await allOriginsGet(wrapped);
    expect(real.status).toBe(201);
    expect(real.headers.get("content-type")).toBe("text/plain");
    expect(await real.text()).toBe("hello");
  });

  it("handles null contents without throwing", async () => {
    const wrapped = fakeResponse(JSON.stringify({ contents: null }));
    const real = await allOriginsGet(wrapped);
    expect(await real.text()).toBe("");
    expect(real.status).toBe(200);
  });
});

describe("client failover", () => {
  function oneProxy(id: string): ProxyDescriptor {
    return {
      id,
      label: id,
      endpoint: `https://${id}/`,
      caps: { methods: ["GET"], body: false, forwardsHeaders: false, requiresKey: false },
      transform: (req) => ({ url: `https://${id}/?u=${encodeURIComponent(req.url)}`, init: {} }),
      untransform: async (res) => res,
    };
  }

  it("falls over to the second proxy when the first fails", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockRejectedValueOnce(new Error("down"))
      .mockResolvedValueOnce(fakeResponse("ok"));
    const client = new CorsProxyClient({
      proxies: [oneProxy("a"), oneProxy("b")],
      fetchImpl,
    });
    const res = await client.fetch(TARGET);
    expect(await res.text()).toBe("ok");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("throws AllProxiesFailedError with per-proxy reasons when every proxy fails", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockRejectedValue(new Error("boom"));
    const client = new CorsProxyClient({
      proxies: [oneProxy("a"), oneProxy("b")],
      fetchImpl,
    });
    let caught: unknown;
    try {
      await client.fetch(TARGET);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(AllProxiesFailedError);
    expect((caught as AllProxiesFailedError).attempts.map((a) => a.proxyId)).toEqual([
      "a",
      "b",
    ]);
  });

  it("throws AllProxiesFailedError immediately when no proxy supports the method", async () => {
    const client = new CorsProxyClient({ proxies: [oneProxy("a")] });
    await expect(client.fetch(TARGET, { method: "POST" })).rejects.toBeInstanceOf(
      AllProxiesFailedError,
    );
  });

  it("demotes a proxy that returns 429 and skips it next time (cooldown)", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(fakeResponse("", { status: 429 }))
      .mockResolvedValue(fakeResponse("ok"));
    const client = new CorsProxyClient({
      proxies: [oneProxy("a"), oneProxy("b")],
      fetchImpl,
      cooldownMs: 60_000,
    });
    await client.fetch(TARGET); // a -> 429 demoted, b -> ok
    await client.fetch(TARGET); // a in cooldown, only b attempted
    const urls = fetchImpl.mock.calls.map((c) => String(c[0]));
    // second request should not have hit proxy "a"
    expect(urls.slice(2).some((u) => u.startsWith("https://a/"))).toBe(false);
  });

  it("race returns the first successful response", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async (url) =>
      String(url).startsWith("https://b/")
        ? fakeResponse("fast")
        : new Promise((r) => setTimeout(() => r(fakeResponse("slow")), 50)),
    );
    const client = new CorsProxyClient({
      proxies: [oneProxy("a"), oneProxy("b")],
      strategy: "race",
      fetchImpl,
    });
    const res = await client.fetch(TARGET);
    expect(await res.text()).toBe("fast");
  });

  it("aborts an attempt that exceeds the per-attempt timeout", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          (init as RequestInit).signal?.addEventListener("abort", () =>
            reject(new DOMException("Aborted", "AbortError")),
          );
        }),
    );
    const client = new CorsProxyClient({
      proxies: [oneProxy("a")],
      fetchImpl,
      timeoutMs: 20,
    });
    await expect(client.fetch(TARGET)).rejects.toBeInstanceOf(AllProxiesFailedError);
  });
});

describe("createProxiedFetch", () => {
  it("returns a fetch-compatible function", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(fakeResponse("ok"));
    const pf = createProxiedFetch({ fetchImpl });
    const res = await pf(TARGET);
    expect(await res.text()).toBe("ok");
  });
});
