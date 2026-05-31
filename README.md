# @anentrypoint/cors

A pluggable SDK that routes `fetch` requests through a registry of public CORS
proxies, with health-ranked failover. Drop it into any client (browser, Node
18+, Deno, Cloudflare Workers) when a target API lacks CORS headers and you need
a working cross-origin request without standing up your own proxy.

## Install

```sh
npm install @anentrypoint/cors
```

ESM-only, Node >= 18 (or any runtime with global `fetch`). Depends on
[`xstate`](https://stately.ai/docs/xstate) (failover engine) and
[`floosie`](https://www.npmjs.com/package/floosie) (live-update pipeline).

## Usage

```ts
import { createProxiedFetch } from "@anentrypoint/cors";

const fetch = createProxiedFetch();
const res = await fetch("https://api.example.com/data");
const data = await res.json();
```

### Live-updating the proxy list

When `autoRefresh` is set, the client pulls the freshest proxy list from the
upstream community sources it was originally built from (the
[distribuyed/proxies](https://github.com/distribuyed/proxies) list via jsDelivr,
[jimmywarting's gist](https://gist.github.com/jimmywarting/ac1be6ea0297c16c477e17f8fbe51347),
and this project's own published `proxies.json`) and merges them over the
baked-in registry on start. The refresh is non-blocking and never throws - if
every source is unreachable (offline, CORS, format drift), the baked-in
registry is kept.

```ts
import { CorsProxyClient } from "@anentrypoint/cors";

const client = new CorsProxyClient({ autoRefresh: true });
await client.ready;                       // optional: wait for the first refresh
const res = await client.fetch("https://api.example.com/data");

// or refresh on demand:
const { added, sources } = await client.refresh();
```

The fetch that pulls the lists is routed through CORS-enabled CDNs (jsDelivr),
so the SDK can update itself even inside a browser without hitting the very CORS
wall it exists to solve.

### Perfect failover (xstate engine)

Each request is driven by an [xstate](https://stately.ai/docs/xstate)
statechart (`requestMachine`): `selecting -> attempting -> (success | next |
exhausted | cancelled)`. Every eligible proxy is tried in strategy order; a
`429`/`403` records a cooldown demotion; an aborted signal lands in `cancelled`;
running out of proxies lands in `exhausted` with every attempt's reason. No path
leaves a request pending. If the engine itself fails to load or settle, the
client transparently falls back to a plain sequential loop - the fallback is
perfect down to the engine.

```ts
import { requestMachine } from "@anentrypoint/cors";
import { createActor } from "xstate";
// inspect transitions live
const actor = createActor(requestMachine, { input: { /* ... */ } });
actor.subscribe((s) => console.log(s.value));
```

The live-update pipeline is built with [floosie](https://www.npmjs.com/package/floosie):
sources are emitted as floosie chunks through `source(...)`, fetched and parsed
concurrently by the `parallel` operator, and deduped by the `distinct` operator.

`createProxiedFetch` returns a function with the same signature as the global
`fetch`, so it is a drop-in replacement.

### Client with options

```ts
import { CorsProxyClient } from "@anentrypoint/cors";

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
import { CorsProxyClient, getProxy, type ProxyDescriptor } from "@anentrypoint/cors";

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
in their uptime. The inventory below was cross-checked against the canonical
community-maintained lists ([jimmywarting's gist](https://gist.github.com/jimmywarting/ac1be6ea0297c16c477e17f8fbe51347)
and [distribuyed/proxies](https://github.com/distribuyed/proxies)) and live-probed
at time of writing. None is guaranteed to be up - that is exactly why the SDK
fails over.

`codetabs` and `cors-lol` were live-confirmed returning 200; `corsproxy-io` and
`test-cors-workers` require a browser Origin header / dev origin and return 403
to header-less server-side fetches (they work from a browser).

| id                       | endpoint                            | shape        | methods   | body | headers | key |
|--------------------------|-------------------------------------|--------------|-----------|------|---------|-----|
| codetabs                 | api.codetabs.com/v1/proxy/?quest=   | query, raw   | GET, HEAD | no   | no      | no  |
| cors-lol                 | api.cors.lol/?url=                  | query, raw   | all       | yes  | yes     | no  |
| corsproxy-io             | corsproxy.io/?url=                  | query, raw   | all       | yes  | yes     | dev |
| allorigins-get           | api.allorigins.win/get?url=         | query, JSON  | GET       | no   | no      | no  |
| allorigins-raw           | api.allorigins.win/raw?url=         | query, raw   | GET       | no   | no      | no  |
| cors-sh                  | proxy.cors.sh/                      | prefix, raw  | all       | yes  | yes     | no  |
| cors-anywhere-herokuapp  | cors-anywhere.herokuapp.com/        | prefix, raw  | all       | yes  | yes     | opt-in |
| cors-anywhere-com        | cors-anywhere.com/                  | prefix, raw  | all       | yes  | yes     | no  |
| thingproxy               | thingproxy.freeboard.io/fetch/      | prefix, raw  | GET, POST | yes  | yes     | no  |
| test-cors-workers        | test.cors.workers.dev/?            | query, raw   | GET, HEAD | no   | no      | browser |
| whateverorigin           | www.whateverorigin.org/get?url=     | query, raw   | GET       | no   | no      | no  |

The `key` column: `no` = open, `dev` = free for development origins only,
`opt-in` = demo server needs opt-in, `browser` = needs a browser Origin header.

### Adding proxies as data

Use the `queryProxy` / `prefixProxy` factories instead of hand-writing a
descriptor:

```ts
import { CorsProxyClient, queryProxy, prefixProxy } from "@anentrypoint/cors";

const client = new CorsProxyClient({
  proxies: [
    queryProxy({ id: "mine", label: "my worker", base: "https://cors.my.dev/?url=" }),
    prefixProxy({ id: "ca", label: "my cors-anywhere", base: "https://ca.my.dev/" }),
  ],
});
```

### Historical / defunct / self-host-only proxies

Documented for completeness via the exported `historicalProxies` array; **not**
registered because they have no reliable public contract. Spin up your own
(`Zibri/cloudflare-cors-anywhere` Worker, or `Rob--W/cors-anywhere`) for
production.

| id                          | note                                                      |
|-----------------------------|-----------------------------------------------------------|
| crossorigin.me              | defunct; required Origin header, 2MB cap                  |
| cors.io                     | defunct; GET/HEAD raw at cors.io/?                        |
| anyorigin.com               | defunct; original JSONP AnyOrigin, http-only             |
| cors.bridged.cc             | deprecated; Grida bridged, 16MB/request                  |
| yacdn.org                   | yacdn.org/proxy/ CDN (FR); unreliable, ignores headers   |
| jsonp.afeld.me              | JSONProxy; JSONP-only GET                                 |
| cors-proxy.htmldriven.com   | wrapped JSON ?url=; frequently down                      |
| gobetween                   | okfn/gobetween; self-host                                 |
| goxcors                     | appspot; POST x-www-form-urlencoded only, always html    |
| cloudflare-cors-anywhere    | Zibri self-host Worker template, 100k req/day            |
| cors.x2u.in                 | query-style; intermittent                                |
| taskcluster                 | whitelisted to taskcluster only                          |
| heroku-now-glitch-misc      | many dead instances (cors.now.sh, corsify.me, cors.hyoo.ru, ...) |

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
