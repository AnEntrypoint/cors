import type { ProxyDescriptor, TargetRequest } from "./types.js";
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

/**
 * The exhaustive inventory of public CORS proxies the SDK ships with. Each
 * entry encodes its request contract (prefix-style, query-style, wrapped) and
 * its known capabilities. Defunct/unreliable historical proxies are documented
 * in the README; only ones with a usable contract are registered here so the
 * failover chain does not waste attempts on dead hosts by default.
 */
export const builtinProxies: ProxyDescriptor[] = [
  {
    // Raw passthrough, query-style. GET/HEAD; no body, no header forwarding.
    id: "codetabs",
    label: "codetabs.com proxy",
    endpoint: "https://api.codetabs.com/v1/proxy/?quest=",
    caps: { methods: ["GET", "HEAD"], body: false, forwardsHeaders: false, requiresKey: false },
    transform: (req) => ({
      url: `https://api.codetabs.com/v1/proxy/?quest=${q(req.url)}`,
      init: { method: "GET", signal: req.signal },
    }),
    untransform: untransforms.passthrough,
  },
  {
    // Raw passthrough, query-style. Forwards method/headers/body.
    id: "corsproxy-io",
    label: "corsproxy.io",
    endpoint: "https://corsproxy.io/?url=",
    caps: { methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"], body: true, forwardsHeaders: true, requiresKey: false },
    transform: (req) => ({
      url: `https://corsproxy.io/?url=${q(req.url)}`,
      init: forwardInit(req, true),
    }),
    untransform: untransforms.passthrough,
  },
  {
    // Wrapped JSON, query-style. GET only; payload inside { contents, status }.
    id: "allorigins-get",
    label: "allorigins.win /get (wrapped)",
    endpoint: "https://api.allorigins.win/get?url=",
    caps: { methods: ["GET"], body: false, forwardsHeaders: false, requiresKey: false },
    transform: (req) => ({
      url: `https://api.allorigins.win/get?url=${q(req.url)}`,
      init: { method: "GET", signal: req.signal },
    }),
    untransform: untransforms.allOriginsGet,
  },
  {
    // Raw passthrough variant of allorigins, query-style. GET only.
    id: "allorigins-raw",
    label: "allorigins.win /raw",
    endpoint: "https://api.allorigins.win/raw?url=",
    caps: { methods: ["GET"], body: false, forwardsHeaders: false, requiresKey: false },
    transform: (req) => ({
      url: `https://api.allorigins.win/raw?url=${q(req.url)}`,
      init: { method: "GET", signal: req.signal },
    }),
    untransform: untransforms.passthrough,
  },
  {
    // Raw passthrough, prefix-style. Forwards method/headers/body.
    id: "cors-sh",
    label: "proxy.cors.sh",
    endpoint: "https://proxy.cors.sh/",
    caps: { methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"], body: true, forwardsHeaders: true, requiresKey: false },
    transform: (req) => ({
      url: `https://proxy.cors.sh/${req.url}`,
      init: forwardInit(req, true),
    }),
    untransform: untransforms.passthrough,
  },
  {
    // Raw passthrough, prefix-style. Public cors-anywhere-style deployment.
    // Requires an X-Requested-With header on many deployments.
    id: "cors-anywhere-herokuapp",
    label: "cors-anywhere (herokuapp demo)",
    endpoint: "https://cors-anywhere.herokuapp.com/",
    caps: { methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"], body: true, forwardsHeaders: true, requiresKey: false },
    transform: (req) => {
      const headers = new Headers(req.headers);
      if (!headers.has("x-requested-with")) headers.set("x-requested-with", "XMLHttpRequest");
      return {
        url: `https://cors-anywhere.herokuapp.com/${req.url}`,
        init: { method: req.method, headers, body: req.body, signal: req.signal },
      };
    },
    untransform: untransforms.passthrough,
  },
  {
    // Raw passthrough, prefix-style. thingproxy expects the full URL appended.
    id: "thingproxy",
    label: "thingproxy.freeboard.io",
    endpoint: "https://thingproxy.freeboard.io/fetch/",
    caps: { methods: ["GET", "POST"], body: true, forwardsHeaders: true, requiresKey: false },
    transform: (req) => ({
      url: `https://thingproxy.freeboard.io/fetch/${req.url}`,
      init: forwardInit(req, true),
    }),
    untransform: untransforms.passthrough,
  },
  {
    // Cloudflare-workers reference proxy, query-style. GET-leaning passthrough.
    id: "whateverorigin",
    label: "whateverorigin.org",
    endpoint: "http://www.whateverorigin.org/get?url=",
    caps: { methods: ["GET"], body: false, forwardsHeaders: false, requiresKey: false },
    transform: (req) => ({
      url: `https://www.whateverorigin.org/get?url=${q(req.url)}`,
      init: { method: "GET", signal: req.signal },
    }),
    untransform: untransforms.passthrough,
  },
];

/** Look up a built-in proxy by id. */
export function getProxy(id: string): ProxyDescriptor | undefined {
  return builtinProxies.find((p) => p.id === id);
}
