/**
 * Cross-origin discipline for the public widget endpoints.
 *
 * These routes deliberately do NOT call `assertSameOrigin`. Every other
 * mutating route in this console is reached by a cookie-authenticated browser
 * on our own origin, where a same-origin check is the CSRF defence. The widget
 * is the opposite case by construction: it runs on a customer's page, carries
 * no cookie and no session, and a same-origin check would reject every real
 * request while protecting nothing.
 *
 * What replaces it is stricter, not weaker:
 *
 *   1. The request must carry an `Origin` header. Browsers always send one
 *      cross-origin, so a missing origin means the caller is not the browser
 *      context the widget is authorised for, and the request is refused.
 *   2. The origin is passed to the database, which matches it EXACTLY against
 *      the tenant's own allowlist inside `widget_bootstrap` / `widget_ask`.
 *      This process never decides the answer; it only relays the header.
 *   3. `Access-Control-Allow-Origin` is echoed only after the database has
 *      already accepted the pair, so a refused origin receives a response the
 *      browser cannot read AND a body that contains nothing.
 *
 * There is no cookie on these responses and `credentials` is never allowed, so
 * a hostile page that manages to issue the request still cannot borrow a
 * console session.
 */

const preflightHeaders = "content-type";
const preflightMaxAgeSeconds = 600;

/** The exact `Origin` header, or null when the caller did not send one. */
export function requestOrigin(request: Request): string | null {
  const origin = request.headers.get("origin");
  if (!origin || origin === "null" || origin.length > 255) return null;
  return origin;
}

/**
 * CORS headers for a response the database already authorised. `Vary: Origin`
 * keeps a shared cache from serving one tenant's approval to another origin.
 */
export function allowedOriginHeaders(origin: string): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Expose-Headers": "Retry-After",
    Vary: "Origin",
  };
}

/**
 * Preflight. It is answered for any origin on purpose: a preflight discloses
 * nothing, and refusing it would only replace a clean CORS failure on the real
 * request with a confusing one. The real request is still gated by the
 * allowlist, and its response carries no CORS headers when the origin is not
 * approved, so the browser cannot read it.
 */
export function preflightResponse(request: Request, methods: string) {
  const origin = requestOrigin(request);
  return new Response(null, {
    status: 204,
    headers: {
      ...(origin ? allowedOriginHeaders(origin) : { Vary: "Origin" }),
      "Access-Control-Allow-Methods": `${methods}, OPTIONS`,
      "Access-Control-Allow-Headers": preflightHeaders,
      "Access-Control-Max-Age": String(preflightMaxAgeSeconds),
      "Cache-Control": "private, no-store",
    },
  });
}

/**
 * The single refusal shape. It is byte-identical for an unknown widget key, a
 * revoked key, a disabled widget and a disallowed origin, and it carries no
 * CORS headers, so an embedding page learns only "not available here".
 */
export function widgetRefusal(status = 404) {
  return Response.json(
    { ok: false, code: "widget_unavailable" },
    {
      status,
      headers: { "Cache-Control": "private, no-store", Vary: "Origin" },
    },
  );
}

export function widgetJson(
  body: unknown,
  origin: string,
  init: { status?: number; headers?: Record<string, string> } = {},
) {
  return Response.json(body, {
    status: init.status ?? 200,
    headers: {
      // A widget payload is tenant-specific and short-lived. It must never be
      // held by an intermediary cache that could hand it to another origin.
      "Cache-Control": "private, no-store",
      ...allowedOriginHeaders(origin),
      ...(init.headers ?? {}),
    },
  });
}
