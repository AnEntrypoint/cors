import type { ProxyAttemptError } from "./types.js";

/** Thrown when every proxy in the failover chain fails for a request. */
export class AllProxiesFailedError extends Error {
  readonly attempts: ProxyAttemptError[];

  constructor(attempts: ProxyAttemptError[]) {
    const summary = attempts
      .map((a) => `${a.proxyId}: ${a.error.message}`)
      .join("; ");
    super(
      attempts.length === 0
        ? "No proxies were available to attempt the request."
        : `All ${attempts.length} proxy attempt(s) failed -> ${summary}`,
    );
    this.name = "AllProxiesFailedError";
    this.attempts = attempts;
  }
}
