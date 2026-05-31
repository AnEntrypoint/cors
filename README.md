# cors-proxy-sdk

A pluggable SDK that routes `fetch` requests through a registry of public CORS
proxies, with health-ranked failover. Drop it into any client (browser, Node
18+, Deno, Cloudflare Workers) when a target API lacks CORS headers and you need
a working cross-origin request without standing up your own proxy.

## Install

```sh
npm install cors-proxy-sdk
```

## Usage

```ts
import { createProxiedFetch } from "cors-proxy-sdk";

const fetch = createProxiedFetch();
const res = await fetch("https://api.example.com/data");
const data = await res.json();
```

`createProxiedFetch` returns a function with the same signature as the global
`fetch`, so it is a drop-in replacement.

### Client with options

```ts
import { CorsProxyClient } from "cors-proxy-sdk";

const client = new CorsProxyClient({
  strategy: "race",      // first proxy to answer wins
  timeoutMs: 8000,       // per-attempt timeout
  cooldownMs: 120000,    // demote a failing/rate-limited proxy this long
});

const res = await client.fetch("https://api.example.com/data", { method: "GET" });
```

### Selection strategies

- `first-healthy` (default): try proxies in registry order until one succeeds.
- `round-robin`: rotate the starting proxy each call to spread load.
- `random`: shuffle order each call.
- `race`: fire all eligible proxies at once; the first success wins.

A proxy that throws, times out, or returns `429`/`403` is demoted into a
cooldown window and skipped until it expires. If every eligible proxy fails, the
call rejects with `AllProxiesFailedError`, whose `attempts` array lists the
per-proxy reasons.

### Custom registry

```ts
import { CorsProxyClient, getProxy, type ProxyDescriptor } from "cors-proxy-sdk";

const mine: ProxyDescriptor = {
  id: "my-worker",
  label: "my cloudflare worker",
  endpoint: "https://cors.my.dev/?url=",
  caps: { methods: ["GET", "POST"], body: true, forwardsHeaders: true, requiresKey: false },
  transform: (req) => ({
    url: `https://cors.my.dev/?url=${encodeURIComponent(req.url)}`,
    init: { method: req.method, headers: req.headers, body: req.body, signal: req.signal },
  }),
  untransform: async (res) => res,
};

const client = new CorsProxyClient({ proxies: [mine, getProxy("codetabs")!] });
```

## Built-in proxy inventory

Public CORS proxies are heterogeneous in their request contract and unreliable
in their uptime; this list captures the ones with a usable, documented contract
at time of writing. None is guaranteed to be up — that is exactly why the SDK
fails over.

| id                         | endpoint                                      | shape        | methods        | body | headers | key |
|----------------------------|-----------------------------------------------|--------------|----------------|------|---------|-----|
| codetabs                   | api.codetabs.com/v1/proxy/?quest=             | query, raw   | GET, HEAD      | no   | no      | no  |
| corsproxy-io               | corsproxy.io/?url=                            | query, raw   | all            | yes  | yes     | no  |
| allorigins-get             | api.allorigins.win/get?url=                   | query, JSON  | GET            | no   | no      | no  |
| allorigins-raw             | api.allorigins.win/raw?url=                   | query, raw   | GET            | no   | no      | no  |
| cors-sh                    | proxy.cors.sh/                                | prefix, raw  | all            | yes  | yes     | no  |
| cors-anywhere-herokuapp    | cors-anywhere.herokuapp.com/                  | prefix, raw  | all            | yes  | yes     | no  |
| thingproxy                 | thingproxy.freeboard.io/fetch/                | prefix, raw  | GET, POST      | yes  | yes     | no  |
| whateverorigin             | www.whateverorigin.org/get?url=               | query, raw   | GET            | no   | no      | no  |

### Request shapes

- **query-style**: target URL is passed as a (URL-encoded) query parameter, e.g.
  `?url=` or `?quest=`. Nested query strings in the target must be encoded.
- **prefix-style**: target URL is appended to the proxy endpoint verbatim.
- **wrapped JSON** (`allorigins-get`): the response is JSON of the form
  `{ contents, status: { http_code, content_type } }`; the SDK reconstructs a
  real `Response` from it via `allOriginsGet`.

### Historical / unreliable proxies (not registered by default)

These have appeared in the ecosystem but are commonly down, deprecated, or
key-gated; add them to a custom registry if you have access:
`crossorigin.me` (defunct), `cors.bridged.cc` (deprecated), `yacdn.org`,
`jsonp.afeld.me` (JSONP only), `cors.eu.org`, `test.cors.workers.dev`
(reference worker, not a public service). Self-hosting `cors-anywhere` or a
small Cloudflare Worker is the reliable long-term option.

## Caveats

- Public proxies see your full request, including any auth headers. Never route
  credentialed or sensitive requests through a proxy you do not control.
- Uptime and rate limits vary; the failover chain and cooldown mitigate but do
  not eliminate flakiness. For production, register your own proxy.
- GET-only proxies are skipped automatically for non-GET requests.

## License

MIT
