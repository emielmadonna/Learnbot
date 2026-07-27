import { Suspense } from "react";
import type { ReactNode } from "react";

/**
 * `/app` is the single authenticated URL. Panels are addressed by search
 * param, so the shell reads `useSearchParams()` and needs a Suspense boundary
 * for the client-side bailout.
 */
export default function AuthenticatedAppLayout({
  children,
}: {
  children: ReactNode;
}) {
  return <Suspense fallback={null}>{children}</Suspense>;
}
