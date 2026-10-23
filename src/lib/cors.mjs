// CORS for the one endpoint the marketing site is allowed to call.
//
// The public site is static HTML on a different hostname from the application, so a form there
// posting to /api/trial is a cross-origin request. Without headers, the browser blocks the response
// and the form looks broken with no error the visitor can act on.
//
// Two deliberate limits:
//   * an allowlist, not "*". The endpoint creates accounts, so it answers only to origins named in
//     configuration
//   * no credentials. The session cookie belongs to the app's origin and must never be sent from a
//     public page, so `access-control-allow-credentials` is absent on purpose
//
// This is what makes an embedded funnel safe. An iframe would be the alternative, and that is
// blocked by design: the app sends X-Frame-Options DENY and its cookie is SameSite=Lax.

export function allowedOrigin(origin, allowlist = []) {
  if (!origin) return null;

  const wanted = String(origin).trim().replace(/\/$/, "").toLowerCase();
  if (!wanted) return null;

  if (allowlist.includes("*")) return origin;

  const match = allowlist
    .map((entry) => String(entry).trim().replace(/\/$/, "").toLowerCase())
    .find((entry) => entry && entry === wanted);

  return match ? origin : null;
}

export function withCors(response, requestOrigin, allowlist) {
  const allowed = allowedOrigin(requestOrigin, allowlist);
  if (!allowed) return response;

  const headers = new Headers(response.headers);
  headers.set("access-control-allow-origin", allowed);
  headers.set("vary", "origin");
  headers.set("access-control-allow-methods", "POST, OPTIONS");
  headers.set("access-control-allow-headers", "content-type");
  headers.set("access-control-max-age", "86400");

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

export function preflight(requestOrigin, allowlist) {
  const allowed = allowedOrigin(requestOrigin, allowlist);
  if (!allowed) return new Response(null, { status: 403 });

  return new Response(null, {
    status: 204,
    headers: {
      "access-control-allow-origin": allowed,
      "access-control-allow-methods": "POST, OPTIONS",
      "access-control-allow-headers": "content-type",
      "access-control-max-age": "86400",
      vary: "origin",
    },
  });
}
