import { createActor, waitFor } from "xstate";
import { AllProxiesFailedError } from "./errors.js";
import { requestMachine } from "./machine.js";
import { builtinProxies } from "./registry.js";
import { refreshProxies } from "./live-update.js";
import { dedupe } from "./live-update.js";
import type {
  ClientOptions,
  ProxyAttemptError,
  ProxyDescriptor,
  SelectionStrategy,
  TargetRequest,
} from "./types.js";

/** A proxy is in cooldown until this timestamp (ms epoch) after a failure. */
interface ProxyState {
  cooldownUntil: number;
}

const DEFAULTS = {
  strategy: "first-healthy" as SelectionStrategy,
  timeoutMs: 10_000,
  cooldownMs: 60_000,
};

/** Normalize fetch input into the SDK's internal TargetRequest. */
function toTargetRequest(
  input: RequestInfo | URL,
  init: RequestInit | undefined,
): TargetRequest {
  const url = input instanceof Request ? input.url : String(input);
  const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
  const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
  const body = init?.body ?? null;
  const signal = init?.signal ?? (input instanceof Request ? input.signal : null) ?? null;
  return { url, method, headers, body, signal };
}

/** Combine an external signal with a timeout into one AbortSignal. */
function withTimeout(
  signal: AbortSignal | null,
  timeoutMs: number,
): { signal: AbortSignal; cancel: () => void } {
  const ctrl = new AbortController();
  const onAbort = () => ctrl.abort((signal as AbortSignal)?.reason);
  if (signal) {
    if (signal.aborted) ctrl.abort(signal.reason);
    else signal.addEventListener("abort", onAbort, { once: true });
  }
  const timer = setTimeout(() => ctrl.abort(new DOMException("Timeout", "TimeoutError")), timeoutMs);
  return {
    signal: ctrl.signal,
    cancel: () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    },
  };
}

export class CorsProxyClient {
  private proxies: ProxyDescriptor[];
  private readonly strategy: SelectionStrategy;
  private readonly timeoutMs: number;
  private readonly cooldownMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly useStateMachine: boolean;
  private readonly state = new Map<string, ProxyState>();
  private rrCursor = 0;
  /** Resolves once the initial autoRefresh (if any) has settled. */
  readonly ready: Promise<void>;

  constructor(opts: ClientOptions = {}) {
    this.proxies = opts.proxies ?? builtinProxies;
    this.strategy = opts.strategy ?? DEFAULTS.strategy;
    this.timeoutMs = opts.timeoutMs ?? DEFAULTS.timeoutMs;
    this.cooldownMs = opts.cooldownMs ?? DEFAULTS.cooldownMs;
    this.useStateMachine = opts.useStateMachine ?? true;
    const impl = opts.fetchImpl ?? globalThis.fetch;
    if (typeof impl !== "function") {
      throw new TypeError(
        "No fetch implementation available. Pass opts.fetchImpl on this runtime.",
      );
    }
    this.fetchImpl = impl.bind(globalThis);
    this.ready = opts.autoRefresh ? this.refresh().then(() => undefined) : Promise.resolve();
  }

  /**
   * Refresh the proxy list from the upstream community sources and merge the
   * result over the current list. Never throws; returns the refresh outcome
   * for observability. On total upstream failure the existing list is kept.
   */
  async refresh(): Promise<{ added: number; sources: { id: string; ok: boolean; count: number }[] }> {
    const result = await refreshProxies({ fetchImpl: this.fetchImpl, timeoutMs: this.timeoutMs });
    const before = this.proxies.length;
    this.proxies = dedupe([...this.proxies, ...result.proxies]);
    return { added: this.proxies.length - before, sources: result.sources };
  }

  /** Proxies eligible right now: not in cooldown and capable of the method. */
  private eligible(req: TargetRequest): ProxyDescriptor[] {
    const now = Date.now();
    return this.proxies.filter((p) => {
      const st = this.state.get(p.id);
      if (st && st.cooldownUntil > now) return false;
      return p.caps.methods.includes(req.method);
    });
  }

  /** Order eligible proxies according to the configured strategy. */
  private order(eligible: ProxyDescriptor[]): ProxyDescriptor[] {
    switch (this.strategy) {
      case "round-robin": {
        if (eligible.length === 0) return eligible;
        const start = this.rrCursor++ % eligible.length;
        return [...eligible.slice(start), ...eligible.slice(0, start)];
      }
      case "random":
        return [...eligible].sort(() => Math.random() - 0.5);
      case "first-healthy":
      case "race":
      default:
        return eligible;
    }
  }

  private demote(id: string): void {
    this.state.set(id, { cooldownUntil: Date.now() + this.cooldownMs });
  }

  /** Run one proxy attempt; throws on transport error, timeout, or rate limit. */
  private async attempt(proxy: ProxyDescriptor, req: TargetRequest): Promise<Response> {
    const pr = proxy.transform(req);
    const { signal, cancel } = withTimeout(req.signal, this.timeoutMs);
    try {
      const raw = await this.fetchImpl(pr.url, { ...pr.init, signal });
      if (raw.status === 429 || raw.status === 403) {
        this.demote(proxy.id);
        throw new Error(`proxy returned ${raw.status} (rate-limited or key required)`);
      }
      return await proxy.untransform(raw, req);
    } catch (err) {
      this.demote(proxy.id);
      throw err instanceof Error ? err : new Error(String(err));
    } finally {
      cancel();
    }
  }

  /** Race all eligible proxies; first successful response wins. */
  private async race(proxies: ProxyDescriptor[], req: TargetRequest): Promise<Response> {
    const attempts: ProxyAttemptError[] = [];
    return new Promise<Response>((resolve, reject) => {
      let pending = proxies.length;
      if (pending === 0) {
        reject(new AllProxiesFailedError(attempts));
        return;
      }
      for (const p of proxies) {
        this.attempt(p, req).then(resolve, (error: Error) => {
          attempts.push({ proxyId: p.id, error });
          if (--pending === 0) reject(new AllProxiesFailedError(attempts));
        });
      }
    });
  }

  /** Try proxies sequentially in strategy order until one succeeds. */
  private async sequential(proxies: ProxyDescriptor[], req: TargetRequest): Promise<Response> {
    const attempts: ProxyAttemptError[] = [];
    for (const p of proxies) {
      try {
        return await this.attempt(p, req);
      } catch (error) {
        attempts.push({ proxyId: p.id, error: error as Error });
      }
    }
    throw new AllProxiesFailedError(attempts);
  }

  /**
   * Drive the perfect-fallback statechart for one request. Spins up an actor
   * from requestMachine, waits for a final state, and maps it: `success` ->
   * Response, `cancelled` -> rethrow the abort reason, `exhausted` ->
   * AllProxiesFailedError with every attempt. Demotions recorded by the machine
   * are applied to the cooldown map. Falls back to the plain sequential loop if
   * the engine throws for any reason.
   */
  private async viaMachine(ordered: ProxyDescriptor[], req: TargetRequest): Promise<Response> {
    let actor;
    try {
      actor = createActor(requestMachine, {
        input: { request: req, queue: ordered, timeoutMs: this.timeoutMs, fetchImpl: this.fetchImpl },
      });
      actor.start();
      const snapshot = await waitFor(actor, (s) => s.status === "done", { timeout: this.timeoutMs * (ordered.length + 1) + 1000 });
      for (const id of snapshot.context.demoted) this.demote(id);
      if (snapshot.value === "success" && snapshot.context.response) return snapshot.context.response;
      if (snapshot.value === "cancelled") {
        throw req.signal?.reason ?? new DOMException("Aborted", "AbortError");
      }
      throw new AllProxiesFailedError(snapshot.context.attempts);
    } catch (err) {
      if (err instanceof AllProxiesFailedError || (err as Error)?.name === "AbortError") throw err;
      // engine itself failed -> perfect fallback to the plain loop
      return this.sequential(ordered, req);
    } finally {
      actor?.stop();
    }
  }

  /** Drop-in fetch: routes the request through the proxy chain. */
  async fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const req = toTargetRequest(input, init);
    const ordered = this.order(this.eligible(req));
    if (ordered.length === 0) throw new AllProxiesFailedError([]);
    if (this.strategy === "race") return this.race(ordered, req);
    return this.useStateMachine ? this.viaMachine(ordered, req) : this.sequential(ordered, req);
  }
}

/** Convenience drop-in bound to a default client. */
export function createProxiedFetch(opts?: ClientOptions): typeof fetch {
  const client = new CorsProxyClient(opts);
  return ((input: RequestInfo | URL, reqInit?: RequestInit) =>
    client.fetch(input, reqInit)) as typeof fetch;
}
