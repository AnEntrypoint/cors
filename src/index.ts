export { CorsProxyClient, createProxiedFetch } from "./client.js";
export { builtinProxies, historicalProxies, getProxy, queryProxy, prefixProxy } from "./registry.js";
export { AllProxiesFailedError } from "./errors.js";
export { passthrough, allOriginsGet, untransforms } from "./untransform.js";
export type {
  ProxyDescriptor,
  ProxyCapabilities,
  TargetRequest,
  ProxyRequest,
  SelectionStrategy,
  ClientOptions,
  ProxyAttemptError,
} from "./types.js";
