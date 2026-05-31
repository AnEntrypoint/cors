/**
 * Shape of the target request the SDK is asked to make on the user's behalf,
 * before any proxy-specific rewriting is applied.
 */
export interface TargetRequest {
  url: string;
  method: string;
  headers: Headers;
  body: BodyInit | null;
  signal: AbortSignal | null;
}

/**
 * What a proxy adapter produces from a TargetRequest: the concrete request to
 * send to the proxy endpoint. `untransform` reconstructs a standard Response
 * from whatever the proxy actually returned (raw passthrough, wrapped JSON, ...).
 */
export interface ProxyRequest {
  url: string;
  init: RequestInit;
}

/** Capabilities a proxy supports, used by selection and graceful degradation. */
export interface ProxyCapabilities {
  /** HTTP methods the proxy is known to forward. GET-only proxies list only GET. */
  methods: string[];
  /** Whether the proxy forwards a request body. */
  body: boolean;
  /** Whether arbitrary request headers reach the target. */
  forwardsHeaders: boolean;
  /** Whether the proxy needs an API key or registered origin to work. */
  requiresKey: boolean;
}

/**
 * A single public CORS proxy. The transform/untransform pair is the adapter
 * that hides the proxy's bespoke request and response contract behind the
 * uniform fetch surface the SDK exposes.
 */
export interface ProxyDescriptor {
  /** Stable identifier, e.g. "codetabs", "allorigins-get". */
  id: string;
  /** Human-readable label for docs and errors. */
  label: string;
  /** Base endpoint, for documentation and health probes. */
  endpoint: string;
  caps: ProxyCapabilities;
  /** Build the concrete proxy request from the caller's target request. */
  transform(req: TargetRequest): ProxyRequest;
  /**
   * Reconstruct a standard Response from the proxy's raw response. Raw
   * passthrough proxies return the response as-is; wrapped proxies (allorigins)
   * carry the payload inside JSON and need rebuilding.
   */
  untransform(proxyResponse: Response, req: TargetRequest): Promise<Response>;
}

/** Strategy controlling which proxy (or proxies) a request is routed through. */
export type SelectionStrategy =
  | "first-healthy"
  | "round-robin"
  | "race"
  | "random";

export interface ClientOptions {
  /** Ordered proxy list. Defaults to the built-in registry. */
  proxies?: ProxyDescriptor[];
  /** Routing strategy across proxies. Default "first-healthy". */
  strategy?: SelectionStrategy;
  /** Per-attempt timeout in ms. Default 10000. */
  timeoutMs?: number;
  /** Injectable fetch; defaults to globalThis.fetch for env-agnostic use. */
  fetchImpl?: typeof fetch;
  /**
   * Cooldown in ms applied to a proxy after a rate-limit/failure before it is
   * eligible again. Default 60000.
   */
  cooldownMs?: number;
}

/** Per-proxy failure captured when every attempt in a chain fails. */
export interface ProxyAttemptError {
  proxyId: string;
  error: Error;
}
