// Integration witness: drive the built SDK against a real public CORS proxy.
// Uses the real codetabs proxy (live-confirmed) to fetch a real target URL,
// and asserts the failover path produces a usable Response.
import { CorsProxyClient, getProxy, AllProxiesFailedError } from "./dist/index.js";

let failures = 0;
function check(name, cond) {
  if (cond) console.log(`pass: ${name}`);
  else { console.log(`FAIL: ${name}`); failures++; }
}

// 1. Real proxy fetch through the SDK (codetabs raw passthrough).
try {
  const client = new CorsProxyClient({
    proxies: [getProxy("codetabs")],
    timeoutMs: 15000,
  });
  const res = await client.fetch("https://example.com/");
  const body = await res.text();
  check("codetabs returns 2xx", res.status >= 200 && res.status < 300);
  check("body contains Example Domain", body.includes("Example Domain"));
} catch (e) {
  console.log(`FAIL: live codetabs fetch threw -> ${e.message}`);
  failures++;
}

// 2. Failover: a deliberately broken proxy first, real codetabs second.
try {
  const broken = {
    id: "broken",
    label: "broken",
    endpoint: "https://does-not-resolve.invalid/",
    caps: { methods: ["GET"], body: false, forwardsHeaders: false, requiresKey: false },
    transform: (req) => ({ url: `https://does-not-resolve.invalid/?u=${encodeURIComponent(req.url)}`, init: {} }),
    untransform: async (r) => r,
  };
  const client = new CorsProxyClient({
    proxies: [broken, getProxy("codetabs")],
    timeoutMs: 15000,
  });
  const res = await client.fetch("https://example.com/");
  check("failover reached a working proxy", res.status >= 200 && res.status < 300);
} catch (e) {
  console.log(`FAIL: failover threw -> ${e.message}`);
  failures++;
}

// 3. Total failure surfaces a typed error with per-proxy reasons.
try {
  const broken = {
    id: "broken",
    label: "broken",
    endpoint: "https://does-not-resolve.invalid/",
    caps: { methods: ["GET"], body: false, forwardsHeaders: false, requiresKey: false },
    transform: () => ({ url: "https://does-not-resolve.invalid/", init: {} }),
    untransform: async (r) => r,
  };
  const client = new CorsProxyClient({ proxies: [broken], timeoutMs: 8000 });
  await client.fetch("https://example.com/");
  check("total failure throws", false);
} catch (e) {
  check("total failure is AllProxiesFailedError", e instanceof AllProxiesFailedError);
  check("error carries attempts", Array.isArray(e.attempts) && e.attempts.length === 1);
}

console.log(failures === 0 ? "\nINTEGRATION WITNESS: PASS" : `\nINTEGRATION WITNESS: FAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);
