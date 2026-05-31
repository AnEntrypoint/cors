import { pipe, source as floosieSource, parallel, distinct, json } from "floosie";
import type { ProxyDescriptor } from "./types.js";
import { MAX_LIVE_ENDPOINTS, upstreamSources, type UpstreamSource } from "./sources.js";

export interface RefreshOptions {
  /** Overall deadline for the whole refresh in ms. Default 8000. */
  timeoutMs?: number;
  /** Max bytes to read from any single source. Default 1_000_000. */
  maxBytes?: number;
  /** Injectable fetch; defaults to globalThis.fetch. */
  fetchImpl?: typeof fetch;
  /** Override the source list (defaults to the built-in upstreamSources). */
  sources?: UpstreamSource[];
}

export interface RefreshResult {
  proxies: ProxyDescriptor[];
  /** Per-source outcome for observability. */
  sources: { id: string; ok: boolean; count: number; error?: string }[];
}

/** The per-source result carried as a floosie json chunk through the pipeline. */
interface SourceChunkData {
  id: string;
  ok: boolean;
  proxies: ProxyDescriptor[];
  error?: string;
}

/** Fetch one source with a byte cap; throws on non-2xx or oversize. */
async function fetchSource(
  src: UpstreamSource,
  fetchImpl: typeof fetch,
  signal: AbortSignal,
  maxBytes: number,
): Promise<ProxyDescriptor[]> {
  const res = await fetchImpl(src.url, { signal });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const text = await res.text();
  if (text.length > maxBytes) throw new Error(`oversize ${text.length} > ${maxBytes}`);
  return src.parse(text);
}

/**
 * Refresh the proxy list from the upstream community sources, piped through
 * floosie. The sources are emitted as floosie json chunks from `source(...)`,
 * fetched-and-parsed concurrently by the `parallel` operator, deduped by the
 * `distinct` operator on source id, and consumed by iterating the resulting
 * StreamNode. Never throws: a source that fails becomes an `ok:false` chunk and
 * contributes no proxies. If every source fails (offline, CORS, format drift),
 * `proxies` is empty and the caller keeps its baked-in registry.
 */
export async function refreshProxies(opts: RefreshOptions = {}): Promise<RefreshResult> {
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch;
  const timeoutMs = opts.timeoutMs ?? 8000;
  const maxBytes = opts.maxBytes ?? 1_000_000;
  const srcs = opts.sources ?? upstreamSources;

  if (typeof fetchImpl !== "function") {
    return { proxies: [], sources: srcs.map((s) => ({ id: s.id, ok: false, count: 0, error: "no fetch" })) };
  }

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(new Error("refresh timeout")), timeoutMs);

  try {
    // Each upstream source is a floosie json chunk. parallel() fetches+parses
    // every source concurrently; distinct() drops repeat source ids; the
    // resulting StreamNode is consumed by for-await to collect outcomes.
    const inputs = srcs.map((s) => json({ sourceId: s.id }));
    const node = pipe(
      floosieSource(inputs),
      distinct((c) => (c.data as { sourceId: string }).sourceId),
      parallel(async (chunk): Promise<ReturnType<typeof json<SourceChunkData>>> => {
        const id = (chunk.data as { sourceId: string }).sourceId;
        const src = srcs.find((s) => s.id === id)!;
        try {
          const proxies = await fetchSource(src, fetchImpl, ctrl.signal, maxBytes);
          return json<SourceChunkData>({ id, ok: true, proxies });
        } catch (err) {
          return json<SourceChunkData>({ id, ok: false, proxies: [], error: err instanceof Error ? err.message : String(err) });
        }
      }, srcs.length),
    );

    const outcomes: RefreshResult["sources"] = [];
    const all: ProxyDescriptor[] = [];
    for await (const chunk of node.run(emptyAsync())) {
      const d = (chunk as ReturnType<typeof json<SourceChunkData>>).data;
      outcomes.push({ id: d.id, ok: d.ok, count: d.proxies.length, error: d.error });
      all.push(...d.proxies);
    }

    return { proxies: dedupe(all).slice(0, MAX_LIVE_ENDPOINTS), sources: outcomes };
  } catch {
    return { proxies: [], sources: srcs.map((s) => ({ id: s.id, ok: false, count: 0, error: "pipeline error" })) };
  } finally {
    clearTimeout(timer);
  }
}

/** An empty async iterable to seed a source-rooted StreamNode's run(). */
async function* emptyAsync(): AsyncIterable<never> {
  // no upstream input; the source node ignores it and emits its own items
}

/** Merge descriptors, first-id-wins, drop duplicates by id and by endpoint. */
export function dedupe(list: ProxyDescriptor[]): ProxyDescriptor[] {
  const byId = new Map<string, ProxyDescriptor>();
  const seenEndpoint = new Set<string>();
  for (const d of list) {
    if (byId.has(d.id) || seenEndpoint.has(d.endpoint)) continue;
    byId.set(d.id, d);
    seenEndpoint.add(d.endpoint);
  }
  return [...byId.values()];
}
