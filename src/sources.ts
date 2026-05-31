import type { ProxyDescriptor } from "./types.js";
import { prefixProxy, queryProxy } from "./registry.js";

/**
 * An upstream source the SDK can refresh its proxy list from. `parse` turns the
 * raw fetched text into ProxyDescriptors. Sources are tried in order and the
 * results merged; any source that fails is skipped, never fatal.
 *
 * The first two sources are jsDelivr mirrors of the same canonical community
 * lists this registry was originally built from (jimmywarting's gist and
 * distribuyed/proxies). jsDelivr is CORS-enabled and CDN-cached, which avoids
 * the bootstrap irony of a CORS SDK being unable to fetch its own list because
 * of CORS. The third is this project's own published proxies.json.
 */
export interface UpstreamSource {
  id: string;
  url: string;
  parse(raw: string): ProxyDescriptor[];
}

/** Reject anything that is not a plain http(s) URL (no javascript:/data:/etc). */
function safeHttpUrl(value: string): string | null {
  try {
    const u = new URL(value);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    return u.toString();
  } catch {
    return null;
  }
}

/**
 * Build a descriptor from a discovered endpoint string. Endpoints that end with
 * a query parameter (contain "?") are treated as query-style; otherwise
 * prefix-style. Returns null for unusable endpoints.
 */
function descriptorFromEndpoint(raw: string): ProxyDescriptor | null {
  const url = safeHttpUrl(raw.trim());
  if (!url) return null;
  const id = `live:${new URL(url).host}`;
  const isQuery = /[?&](url|quest|q|get|href|callback)=?$/.test(url) || url.endsWith("=");
  return isQuery
    ? queryProxy({ id, label: id, base: url })
    : prefixProxy({ id, label: id, base: url.endsWith("/") ? url : `${url}/` });
}

/** Extract candidate endpoint strings from a markdown/HTML blob, deduped. */
function harvestEndpoints(raw: string): string[] {
  const found = new Set<string>();
  // bullet-list endpoints (distribuyed README "to do" list) and table hrefs
  const re = /https?:\/\/[^\s"'<>)\]]+/g;
  for (const m of raw.matchAll(re)) {
    const u = m[0];
    // keep only things that look like proxy endpoints, not docs/badges/images
    if (/(\?url=|\?quest=|\?q=|\?get=|\?href=|\/fetch\/|\/proxy\/|\/get\?|cors)/i.test(u) &&
        !/\.(png|svg|jpg|gif|css|js)(\?|$)/i.test(u) &&
        !/github\.com|githubusercontent|medium\.com|paypal|developer\.mozilla|npmjs|jsdelivr/i.test(u)) {
      found.add(u.replace(/[.,;]+$/, ""));
    }
  }
  return [...found];
}

/** Cap on how many live endpoints any single refresh may add (anti-abuse). */
export const MAX_LIVE_ENDPOINTS = 100;

export const upstreamSources: UpstreamSource[] = [
  {
    id: "distribuyed",
    url: "https://cdn.jsdelivr.net/gh/distribuyed/proxies@master/README.md",
    parse: (raw) =>
      harvestEndpoints(raw)
        .map(descriptorFromEndpoint)
        .filter((d): d is ProxyDescriptor => d !== null),
  },
  {
    id: "jimmywarting",
    url: "https://gist.githubusercontent.com/jimmywarting/ac1be6ea0297c16c477e17f8fbe51347/raw",
    parse: (raw) =>
      harvestEndpoints(raw)
        .map(descriptorFromEndpoint)
        .filter((d): d is ProxyDescriptor => d !== null),
  },
  {
    id: "self-pages",
    url: "https://anentrypoint.github.io/cors/proxies.json",
    parse: (raw) => parseProxiesJson(raw),
  },
];

/** Parse this project's own proxies.json (the gh-pages / npm-bundled form). */
export function parseProxiesJson(raw: string): ProxyDescriptor[] {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return [];
  }
  const list = Array.isArray(data)
    ? data
    : (data as { proxies?: unknown[] })?.proxies;
  if (!Array.isArray(list)) return [];
  const out: ProxyDescriptor[] = [];
  for (const entry of list) {
    const e = entry as { id?: string; endpoint?: string; shape?: string };
    if (!e?.endpoint) continue;
    const d = descriptorFromEndpoint(e.endpoint);
    if (d) {
      if (e.id) d.id = e.id;
      out.push(d);
    }
  }
  return out;
}
