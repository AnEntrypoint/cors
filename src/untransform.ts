import type { ProxyDescriptor, TargetRequest } from "./types.js";

/** Raw passthrough: the proxy already returns a faithful Response. */
export async function passthrough(res: Response): Promise<Response> {
  return res;
}

/**
 * allorigins /get wraps the payload as JSON:
 *   { contents: string, status: { url, http_code, content_type, ... } }
 * Rebuild a real Response carrying the original status code and content type.
 */
export async function allOriginsGet(res: Response): Promise<Response> {
  if (!res.ok) return res;
  const wrapped = (await res.json()) as {
    contents: string | null;
    status?: { http_code?: number; content_type?: string };
  };
  const code = wrapped.status?.http_code ?? 200;
  const headers = new Headers();
  if (wrapped.status?.content_type) {
    headers.set("content-type", wrapped.status.content_type);
  }
  return new Response(wrapped.contents ?? "", {
    status: code,
    statusText: "",
    headers,
  });
}

/** A descriptor's untransform bound to its target request, for symmetry. */
export type Untransform = ProxyDescriptor["untransform"];

export const untransforms = {
  passthrough: (res: Response, _req: TargetRequest) => passthrough(res),
  allOriginsGet: (res: Response, _req: TargetRequest) => allOriginsGet(res),
} satisfies Record<string, Untransform>;
