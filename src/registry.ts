import type { ProxyCapabilities, ProxyDescriptor, TargetRequest } from "./types.js";
import { untransforms } from "./untransform.js";

/** Encode a target URL for a query-style proxy parameter. */
function q(url: string): string {
  return encodeURIComponent(url);
}

/**
 * Carry the caller's method/headers/body onto the proxy request for proxies
 * that forward them. GET-only proxies ignore everything but the URL.
 */
function forwardInit(req: TargetRequest, forwardHeaders: boolean): RequestInit {
  return {
    method: req.method,
    headers: forwardHeaders ? req.headers : undefined,
    body: req.body,
    signal: req.signal,
  };
}

const GET_ONLY: ProxyCapabilities = {
  methods: ["GET", "HEAD"],
  body: false,
  forwardsHeaders: false,
  requiresKey: false,
};

const ALL_METHODS: ProxyCapabilities = {
  methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"],
  body: true,
  forwardsHeaders: true,
  requiresKey: false,
};

interface FactoryOpts {
  id: string;
  label: string;
  /** Endpoint up to and including the join point, e.g. "https://x/?url=" or "https://x/". */
  base: string;
  caps?: ProxyCapabilities;
}

/**
 * query-style proxy: target URL is URL-encoded onto `base` (which ends with the
 * query parameter, e.g. "?url="). Raw passthrough response.
 */
export function queryProxy(o: FactoryOpts): ProxyDescriptor {
  const caps = o.caps ?? GET_ONLY;
  return {
    id: o.id,
    label: o.label,
    endpoint: o.base,
    caps,
    transform: (req) => ({
      url: `${o.base}${q(req.url)}`,
      init: caps.body ? forwardInit(req, caps.forwardsHeaders) : { method: "GET", signal: req.signal },
    }),
    untransform: untransforms.passthrough,
  };
}

/**
 * prefix-style proxy: target URL is appended verbatim to `base`
 * (e.g. "https://proxy/"). Raw passthrough response.
 */
export function prefixProxy(o: FactoryOpts): ProxyDescriptor {
  const caps = o.caps ?? ALL_METHODS;
  return {
    id: o.id,
    label: o.label,
    endpoint: o.base,
    caps,
    transform: (req) => ({
      url: `${o.base}${req.url}`,
      init: caps.body ? forwardInit(req, caps.forwardsHeaders) : { method: req.method, signal: req.signal },
    }),
    untransform: untransforms.passthrough,
  };
}

/**
 * The exhaustive inventory of public CORS proxies the SDK ships with. Each
 * entry encodes its request contract (prefix-style, query-style, wrapped) and
 * its known capabilities. Only proxies with a usable, confirmed contract are
 * registered so the failover chain does not waste attempts on dead hosts;
 * historical/defunct/self-host-only ones are documented in the README and in
 * `historicalProxies` below.
 */
export const builtinProxies: ProxyDescriptor[] = [
  // Raw passthrough, query-style. GET/HEAD. Live-confirmed.
  queryProxy({ id: "codetabs", label: "codetabs.com proxy", base: "https://api.codetabs.com/v1/proxy/?quest=" }),

  // Raw passthrough, query-style, forwards everything. Live-confirmed.
  queryProxy({ id: "cors-lol", label: "cors.lol", base: "https://api.cors.lol/?url=", caps: ALL_METHODS }),

  // Raw passthrough, query-style, forwards everything. Free for dev origins;
  // server-side/production requests are key-gated (returns 403 otherwise).
  queryProxy({
    id: "corsproxy-io",
    label: "corsproxy.io",
    base: "https://corsproxy.io/?url=",
    caps: { ...ALL_METHODS, requiresKey: true },
  }),

  // Wrapped JSON, query-style. GET only; payload inside { contents, status }.
  {
    id: "allorigins-get",
    label: "allorigins.win /get (wrapped)",
    endpoint: "https://api.allorigins.win/get?url=",
    caps: GET_ONLY,
    transform: (req) => ({ url: `https://api.allorigins.win/get?url=${q(req.url)}`, init: { method: "GET", signal: req.signal } }),
    untransform: untransforms.allOriginsGet,
  },

  // Raw passthrough variant of allorigins, query-style. GET only.
  queryProxy({ id: "allorigins-raw", label: "allorigins.win /raw", base: "https://api.allorigins.win/raw?url=" }),

  // Raw passthrough, prefix-style, forwards everything.
  prefixProxy({ id: "cors-sh", label: "proxy.cors.sh", base: "https://proxy.cors.sh/" }),

  // Raw passthrough, prefix-style. Requires Origin + X-Requested-With; demo
  // server requires opt-in as of 2021.
  {
    id: "cors-anywhere-herokuapp",
    label: "cors-anywhere (herokuapp demo, opt-in required)",
    endpoint: "https://cors-anywhere.herokuapp.com/",
    caps: ALL_METHODS,
    transform: (req) => {
      const headers = new Headers(req.headers);
      if (!headers.has("x-requested-with")) headers.set("x-requested-with", "XMLHttpRequest");
      return { url: `https://cors-anywhere.herokuapp.com/${req.url}`, init: { method: req.method, headers, body: req.body, signal: req.signal } };
    },
    untransform: untransforms.passthrough,
  },

  // Raw passthrough, prefix-style. Community cors-anywhere instance, no opt-in.
  prefixProxy({ id: "cors-anywhere-com", label: "cors-anywhere.com (community instance)", base: "https://cors-anywhere.com/" }),

  // Raw passthrough, prefix-style. GET/POST; 100KB up/down, 10 req/s.
  prefixProxy({
    id: "thingproxy",
    label: "thingproxy.freeboard.io",
    base: "https://thingproxy.freeboard.io/fetch/",
    caps: { methods: ["GET", "POST"], body: true, forwardsHeaders: true, requiresKey: false },
  }),

  // Query-style reference Cloudflare Worker. Requires an Origin header, so it
  // works from a browser but rejects header-less server-side fetches (403).
  queryProxy({ id: "test-cors-workers", label: "test.cors.workers.dev (reference worker, browser-only)", base: "https://test.cors.workers.dev/?" }),

  // Wrapped-JSON, query-style. GET. Whatever Origin (AnyOrigin clone).
  queryProxy({ id: "whateverorigin", label: "whateverorigin.org", base: "https://www.whateverorigin.org/get?url=" }),
];

/**
 * Historical, defunct, key-gated, or self-host-only proxies. Documented for
 * completeness; not registered because they have no reliable public contract.
 * Spin up your own from the templated ones (Zibri cloudflare worker,
 * cors-anywhere) for production.
 */
export const historicalProxies: { id: string; note: string }[] = [
  { id: "crossorigin.me", note: "defunct; corsproxy.github.io redirect, required Origin header, 2MB cap" },
  { id: "cors.io", note: "defunct; was GET/HEAD raw passthrough at cors.io/?" },
  { id: "anyorigin.com", note: "defunct; original JSONP AnyOrigin, http-only" },
  { id: "cors.bridged.cc", note: "deprecated; Grida bridged proxy, 16MB/request" },
  { id: "yacdn.org", note: "yacdn.org/proxy/ prefix CDN (FR); unreliable/down, ignores request headers" },
  { id: "jsonp.afeld.me", note: "JSONProxy; JSONP-only GET via ?callback=&url=" },
  { id: "cors-proxy.htmldriven.com", note: "htmldriven ?url= wrapped JSON; frequently down" },
  { id: "gobetween", note: "okfn/gobetween (gobetween.oklabs.org/pipe/); self-host" },
  { id: "goxcors", note: "acidsound/goxcors appspot; POST limited to x-www-form-urlencoded, always text/html" },
  { id: "cloudflare-cors-anywhere", note: "Zibri/cloudflare-cors-anywhere; self-host Worker template, 100k req/day" },
  { id: "cors.x2u.in", note: "cors.x2u.in query-style; intermittent" },
  { id: "taskcluster", note: "walac.github.io/cors-proxy; whitelisted to taskcluster only" },
  { id: "heroku-now-glitch-misc", note: "many dead instances: cors.now.sh, free-cors-proxy.herokuapp, corsproxy.our.buildo.io, corsify.me, cors.hyoo.ru, cors4js.appspot, fuck-cors.com, proxy-sauce.glitch.me, galvanize-cors-proxy.herokuapp, cors-buster.now.sh, universal-cors-proxy.glitch.me" },
];

/** Look up a built-in proxy by id. */
export function getProxy(id: string): ProxyDescriptor | undefined {
  return builtinProxies.find((p) => p.id === id);
}
