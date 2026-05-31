export { CorsProxyClient, createProxiedFetch } from "./client.js";
export { builtinProxies, historicalProxies, getProxy, queryProxy, prefixProxy } from "./registry.js";
export { AllProxiesFailedError } from "./errors.js";
export { passthrough, allOriginsGet, untransforms } from "./untransform.js";
export { requestMachine } from "./machine.js";
export { refreshProxies, dedupe } from "./live-update.js";
export { upstreamSources, parseProxiesJson, MAX_LIVE_ENDPOINTS } from "./sources.js";
export type { RequestContext, RequestInput, RequestActor } from "./machine.js";
export type { RefreshOptions, RefreshResult } from "./live-update.js";
export type { UpstreamSource } from "./sources.js";
export type {
  ProxyDescriptor,
  ProxyCapabilities,
  TargetRequest,
  ProxyRequest,
  SelectionStrategy,
  ClientOptions,
  ProxyAttemptError,
} from "./types.js";
