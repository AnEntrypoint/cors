import { setup, assign, fromPromise, type ActorRefFrom } from "xstate";
import type { ProxyAttemptError, ProxyDescriptor, TargetRequest } from "./types.js";

/**
 * Context the failover statechart carries through a single request. `queue` is
 * the strategy-ordered list of eligible proxies; `cursor` walks it; `attempts`
 * accumulates per-proxy failures so the `exhausted` state can report every
 * reason. `response` holds the winning Response.
 */
export interface RequestContext {
  request: TargetRequest;
  queue: ProxyDescriptor[];
  cursor: number;
  attempts: ProxyAttemptError[];
  response: Response | null;
  /** Set when a 429/403 demotion happens, surfaced to the client to cooldown. */
  demoted: string[];
  timeoutMs: number;
  fetchImpl: typeof fetch;
}

export interface RequestInput {
  request: TargetRequest;
  queue: ProxyDescriptor[];
  timeoutMs: number;
  fetchImpl: typeof fetch;
}

/** Run a single proxy attempt. Resolves the Response or rejects with reason. */
async function runAttempt(
  proxy: ProxyDescriptor,
  request: TargetRequest,
  timeoutMs: number,
  fetchImpl: typeof fetch,
): Promise<{ response: Response; demoted: boolean }> {
  const ctrl = new AbortController();
  const onAbort = () => ctrl.abort((request.signal as AbortSignal)?.reason);
  if (request.signal) {
    if (request.signal.aborted) ctrl.abort(request.signal.reason);
    else request.signal.addEventListener("abort", onAbort, { once: true });
  }
  const timer = setTimeout(() => ctrl.abort(new DOMException("Timeout", "TimeoutError")), timeoutMs);
  try {
    const pr = proxy.transform(request);
    const raw = await fetchImpl(pr.url, { ...pr.init, signal: ctrl.signal });
    if (raw.status === 429 || raw.status === 403) {
      throw Object.assign(new Error(`proxy ${proxy.id} returned ${raw.status}`), { demote: true });
    }
    return { response: await proxy.untransform(raw, request), demoted: false };
  } finally {
    clearTimeout(timer);
    request.signal?.removeEventListener("abort", onAbort);
  }
}

/**
 * The perfect-fallback statechart. Every eligible proxy is tried in strategy
 * order; a failure advances the cursor; a 429/403 also records a demotion; the
 * external AbortSignal lands in `cancelled`; running out of proxies lands in
 * `exhausted` with every attempt reason. There is no path that leaves a request
 * pending: every state has an exit, so the actor always reaches a final state.
 */
export const requestMachine = setup({
  types: {
    context: {} as RequestContext,
    input: {} as RequestInput,
  },
  actors: {
    attempt: fromPromise(
      async ({ input }: { input: { proxy: ProxyDescriptor; ctx: RequestContext } }) =>
        runAttempt(input.proxy, input.ctx.request, input.ctx.timeoutMs, input.ctx.fetchImpl),
    ),
  },
  guards: {
    hasNext: ({ context }) => context.cursor < context.queue.length,
    aborted: ({ context }) => context.request.signal?.aborted === true,
  },
}).createMachine({
  id: "corsRequest",
  initial: "selecting",
  context: ({ input }) => ({
    request: input.request,
    queue: input.queue,
    cursor: 0,
    attempts: [],
    response: null,
    demoted: [],
    timeoutMs: input.timeoutMs,
    fetchImpl: input.fetchImpl,
  }),
  states: {
    selecting: {
      always: [
        { guard: "aborted", target: "cancelled" },
        { guard: "hasNext", target: "attempting" },
        { target: "exhausted" },
      ],
    },
    attempting: {
      invoke: {
        src: "attempt",
        input: ({ context }) => ({ proxy: context.queue[context.cursor]!, ctx: context }),
        onDone: {
          target: "success",
          actions: assign({ response: ({ event }) => event.output.response }),
        },
        onError: {
          target: "selecting",
          actions: assign({
            cursor: ({ context }) => context.cursor + 1,
            attempts: ({ context, event }) => {
              const err = event.error as Error;
              return [...context.attempts, { proxyId: context.queue[context.cursor]!.id, error: err }];
            },
            demoted: ({ context, event }) => {
              const err = event.error as Error & { demote?: boolean };
              return err?.demote ? [...context.demoted, context.queue[context.cursor]!.id] : context.demoted;
            },
          }),
        },
      },
    },
    success: { type: "final" },
    exhausted: { type: "final" },
    cancelled: { type: "final" },
  },
});

export type RequestActor = ActorRefFrom<typeof requestMachine>;
