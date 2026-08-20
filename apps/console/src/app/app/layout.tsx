import type { ReactNode } from "react";

/**
 * `/app` is the single authenticated URL. Panels are addressed by search
 * param, so the shell reads `useSearchParams()` and needs a Suspense boundary
 * for the client-side bailout — but that boundary belongs around the shell
 * itself, NOT here.
 *
 * It used to wrap `{children}`, and that was why signing in took three blank
 * page loads. Every authenticated page decides where you belong by calling
 * `redirect()` while rendering. With a Suspense boundary above them, React has
 * already begun streaming by the time that happens, the response headers are
 * gone, and Next can no longer answer with an HTTP 307 — it serialises a
 * NEXT_REDIRECT marker into the RSC payload instead. The browser then has to
 * download every chunk and hydrate before it learns where to go, showing
 * `fallback={null}` (a blank screen) for the whole trip, and it repeats that
 * for each hop of /app/entry -> /app/admin -> /app.
 *
 * Passing children straight through keeps the redirects in the response
 * headers, where the browser follows them without running any JavaScript.
 */
export default function AuthenticatedAppLayout({
  children,
}: {
  children: ReactNode;
}) {
  return children;
}
